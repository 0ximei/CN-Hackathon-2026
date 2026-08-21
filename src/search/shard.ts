/**
 * Shard lifecycle: fetch this node's slice of the corpus, embed it, persist it,
 * and answer queries against it.
 *
 * A node never holds the whole corpus. `searchLocal` therefore returns only
 * what this node happens to know, which is exactly why the query has to go out
 * over the mesh to be answered well.
 */

import { BM25Index } from './bm25';
import { clearIndex, db, getMeta, setMeta, type ChunkRow } from './db';
import { embedder } from './embedder';
import { EMBED_DIM, dequantize, makeDocIds, quantize, topK, type Scored } from './vector';

export interface ShardManifest {
  builtAt: string;
  shardCount: number;
  totalChunks: number;
  documents: number;
  shards: { id: number; chunks: number; words: number; topics: string[] }[];
}

export interface LocalHit extends Scored {
  chunk: ChunkRow;
  /** Blended rank score; `score` stays the raw cosine for display. */
  rank: number;
}

export type IndexPhase = 'idle' | 'downloading-model' | 'indexing' | 'ready' | 'error';

export interface IndexStatus {
  phase: IndexPhase;
  shardId: number | null;
  chunks: number;
  /** 0..1 */
  progress: number;
  detail: string;
  backend: string;
}

/** Blend weight for lexical score. Vectors dominate; BM25 rescues exact terms. */
const BM25_WEIGHT = 0.3;

/**
 * Minimum cosine similarity for a passage to be worth returning.
 *
 * Without a floor, a shard that holds nothing relevant still returns its four
 * least-irrelevant passages, and the answer layer cites them as though they
 * were answers. On a first-aid corpus that is the worst failure mode available
 * — frostbite advice confidently offered for a burn question. Below this
 * threshold a node stays silent and lets the rest of the mesh answer.
 *
 * Calibrated for all-MiniLM-L6-v2, which is not well-behaved at the low end:
 * unrelated passages in this corpus still score 0.30-0.40 because they share
 * the same register (short imperative safety prose). 0.42 is where genuinely
 * unrelated content stops coming back.
 */
const MIN_SCORE = 0.42;

/**
 * Bump when the embedding model, its dtype, or the text fed to it changes.
 *
 * Persisted vectors are only comparable to a query vector produced the same
 * way. A stale index does not error — it just ranks badly and silently — so
 * the version is checked on restore and a mismatch forces a re-index.
 */
const EMBED_VERSION = 'minilm-l6/wasm-q8/v2';

export class ShardStore {
  status: IndexStatus = {
    phase: 'idle',
    shardId: null,
    chunks: 0,
    progress: 0,
    detail: '',
    backend: 'unknown',
  };

  onStatus?: (s: IndexStatus) => void;

  /** Packed matrix of every vector in the shard, for a single-pass scan. */
  private matrix = new Float32Array(0);
  private docIds = makeDocIds(0);
  private chunkById = new Map<number, ChunkRow>();
  private bm25: BM25Index | null = null;

  private setStatus(patch: Partial<IndexStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  static async manifest(): Promise<ShardManifest> {
    const res = await fetch('/corpus/manifest.json');
    if (!res.ok) throw new Error('corpus manifest missing — run `npm run corpus:build`');
    return res.json();
  }

  get ready() {
    return this.status.phase === 'ready';
  }

  get shardId() {
    return this.status.shardId;
  }

  get chunkCount() {
    return this.docIds.length;
  }

  /** Restores a previously-indexed shard from IndexedDB. Fast path on reload. */
  async restore(): Promise<boolean> {
    const shardId = await getMeta<number | null>('shardId', null);
    if (shardId === null) return false;
    const count = await db().chunks.count();
    if (count === 0) return false;

    const version = await getMeta<string>('embedVersion', '');
    if (version !== EMBED_VERSION) {
      // Vectors were produced by a different model or backend; re-embed rather
      // than serve rankings we know are wrong.
      await clearIndex();
      this.setStatus({ shardId, phase: 'idle', detail: 'index outdated — re-indexing' });
      await this.load(shardId);
      return true;
    }

    this.setStatus({ shardId, phase: 'indexing', progress: 0, detail: 'loading local index' });
    await this.loadIntoMemory();

    // The vectors are already on disk, but the *query* still has to be embedded
    // at search time. Warming the model here means the first search is instant
    // instead of silently stalling behind a model download.
    this.setStatus({ phase: 'downloading-model', detail: 'warming embedding model' });
    embedder.onProgress = (p) => {
      this.setStatus({
        progress: p.total ? p.loaded / p.total : 0,
        detail: `downloading ${p.file || 'model'}`,
      });
    };
    const backend = await embedder.init();

    this.setStatus({
      phase: 'ready',
      backend,
      chunks: this.docIds.length,
      progress: 1,
      detail: `restored from local database (${backend})`,
    });
    return true;
  }

  /** Downloads, embeds, and persists a shard. Safe to call to switch shards. */
  async load(shardId: number): Promise<void> {
    try {
      this.setStatus({
        shardId,
        phase: 'downloading-model',
        progress: 0,
        detail: 'loading embedding model',
      });

      embedder.onProgress = (p) => {
        this.setStatus({
          progress: p.total ? p.loaded / p.total : 0,
          detail: `downloading ${p.file || 'model'}`,
        });
      };
      const backend = await embedder.init();
      this.setStatus({ backend, detail: `embedding model ready (${backend})` });

      const res = await fetch(`/corpus/shard-${shardId}.json`);
      if (!res.ok) throw new Error(`shard ${shardId} not found`);
      const { chunks } = (await res.json()) as { chunks: ChunkRow[] };

      await clearIndex();
      await db().chunks.bulkPut(chunks);

      this.setStatus({ phase: 'indexing', progress: 0, detail: `embedding ${chunks.length} passages` });

      // Batched so progress is visible and memory stays flat on phones.
      const BATCH = 8;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        // Prefixing the section heading gives the embedding useful context that
        // the passage body alone often lacks.
        const vectors = await embedder.embed(
          batch.map((c) => `${c.title} — ${c.section}. ${c.text}`),
        );
        await db().vectors.bulkPut(
          vectors.map((v, j) => {
            const { q, scale } = quantize(v);
            return {
              docId: batch[j].docId,
              q: q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength) as ArrayBuffer,
              scale,
            };
          }),
        );
        this.setStatus({
          progress: Math.min(1, (i + batch.length) / chunks.length),
          detail: `embedded ${Math.min(i + BATCH, chunks.length)} of ${chunks.length} passages`,
        });
      }

      await setMeta('shardId', shardId);
      await setMeta('embedVersion', EMBED_VERSION);
      await this.loadIntoMemory();
      this.setStatus({
        phase: 'ready',
        chunks: this.docIds.length,
        progress: 1,
        detail: `shard ${shardId} indexed`,
      });
    } catch (err) {
      this.setStatus({
        phase: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async loadIntoMemory() {
    const [chunks, vectors] = await Promise.all([db().chunks.toArray(), db().vectors.toArray()]);
    const byId = new Map(vectors.map((v) => [v.docId, v]));

    // Only chunks that actually have a vector are searchable.
    const usable = chunks.filter((c) => byId.has(c.docId));
    this.matrix = new Float32Array(usable.length * EMBED_DIM);
    this.docIds = makeDocIds(usable.length);
    this.chunkById = new Map();

    usable.forEach((chunk, i) => {
      const v = byId.get(chunk.docId)!;
      this.matrix.set(dequantize(new Int8Array(v.q), v.scale), i * EMBED_DIM);
      this.docIds[i] = chunk.docId;
      this.chunkById.set(chunk.docId, chunk);
    });

    this.bm25 = new BM25Index(
      usable.map((c) => ({ docId: c.docId, text: `${c.title} ${c.section} ${c.text}` })),
    );
  }

  /**
   * Searches this node's shard only.
   *
   * `queryText` is optional because a query arriving over the mesh carries a
   * short text field alongside the vector — enough for lexical rescue of exact
   * terms without shipping the full query.
   */
  searchLocal(queryVec: Float32Array, k: number, queryText?: string): LocalHit[] {
    if (!this.docIds.length) return [];

    const vectorHits = topK(queryVec, this.matrix, this.docIds, Math.min(k * 3, this.docIds.length));
    const lexical = queryText
      ? BM25Index.normalize(this.bm25?.score(queryText) ?? new Map())
      : new Map<number, number>();

    return vectorHits
      .map((hit) => ({
        ...hit,
        chunk: this.chunkById.get(hit.docId)!,
        rank: hit.score + BM25_WEIGHT * (lexical.get(hit.docId) ?? 0),
      }))
      .filter((h) => h.chunk && h.score >= MIN_SCORE)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, k);
  }

  getChunk(docId: number): ChunkRow | undefined {
    return this.chunkById.get(docId);
  }

  /** Every section title this node holds — shown as its "knowledge" in the UI. */
  topics(): string[] {
    return [...new Set([...this.chunkById.values()].map((c) => c.section))];
  }
}

export const shardStore = new ShardStore();
