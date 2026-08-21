/**
 * The catalog: everything this node knows *about*, and the subset it actually
 * stores.
 *
 * There is no shard assignment any more. A node's catalog grows two ways:
 * a user uploads a document here, or metadata arrives over the mesh from
 * somebody else's upload. Either way the node can search it, because metadata
 * carries the embedding. Whether the node can *read* a chunk is a separate
 * question answered by the body store, and that is what the replication policy
 * governs.
 *
 * The consequence worth stating: a hit returned by this node is not proof the
 * node holds the passage. It is proof the node knows the passage exists, knows
 * it is relevant, and knows who to ask.
 */

import { BM25Index } from './bm25';
import {
  clearAll,
  db,
  getKV,
  metaBytesOf,
  setKV,
  storageBudget,
  type BodyRow,
  type DocRow,
  type MetaRow,
} from './db';
import { embedder } from './embedder';
import { EMBED_DIM, dequantize, makeDocIds, quantize, topK, type Scored } from './vector';
import { docIdOf, docKeyOf, parseDocument } from '../lib/chunk';

export interface LocalHit extends Scored {
  meta: MetaRow;
  /** Blended rank score; `score` stays the raw cosine for display. */
  rank: number;
  /** True when this node can serve the full text without asking anyone. */
  hasBody: boolean;
}

export type IndexPhase = 'idle' | 'downloading-model' | 'indexing' | 'ready' | 'error';

export interface IndexStatus {
  phase: IndexPhase;
  /** Chunks this node has metadata for. */
  known: number;
  /** Chunks this node holds the full text of. */
  stored: number;
  documents: number;
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
 * Without a floor, a node that knows nothing relevant still returns its four
 * least-irrelevant passages, and the answer layer cites them as though they
 * were answers. On a first-aid corpus that is the worst failure mode available
 * — frostbite advice confidently offered for a burn question. Below this
 * threshold a node stays silent and lets the rest of the mesh answer.
 *
 * Calibrated for all-MiniLM-L6-v2, which is not well-behaved at the low end:
 * unrelated passages still score 0.30-0.40 because they share a register
 * (short imperative prose). 0.42 is where unrelated content stops coming back.
 */
const MIN_SCORE = 0.42;

/**
 * Bump when the embedding model, its dtype, or the text fed to it changes.
 *
 * Persisted vectors are only comparable to a query vector produced the same
 * way. A stale index does not error — it just ranks badly and silently — so
 * the version is checked on restore and a mismatch forces a rebuild.
 */
const EMBED_VERSION = 'minilm-l6/wasm-q8/v2';

export class Catalog {
  status: IndexStatus = {
    phase: 'idle',
    known: 0,
    stored: 0,
    documents: 0,
    progress: 0,
    detail: '',
    backend: 'unknown',
  };

  onStatus?: (s: IndexStatus) => void;
  /** Fired whenever the catalog or the set of stored bodies changes. */
  onChange?: () => void;

  /** Packed matrix of every known vector, for a single-pass scan. */
  private matrix = new Float32Array(0);
  private docIds = makeDocIds(0);
  private metaById = new Map<number, MetaRow>();
  private haveBody = new Set<number>();
  private bm25: BM25Index | null = null;

  get ready() {
    return this.status.phase === 'ready';
  }

  /** Chunks this node has metadata for — what it can search. */
  get knownCount() {
    return this.docIds.length;
  }

  /** Chunks this node holds the text of — what it can serve. */
  get storedCount() {
    return this.haveBody.size;
  }

  metas(): MetaRow[] {
    return [...this.metaById.values()];
  }

  getMeta(docId: number): MetaRow | undefined {
    return this.metaById.get(docId);
  }

  holdsBody(docId: number): boolean {
    return this.haveBody.has(docId);
  }

  private setStatus(patch: Partial<IndexStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  /* ---------------- lifecycle ---------------- */

  /** Brings the embedder up and loads whatever is already on disk. */
  async start(): Promise<void> {
    const version = await getKV<string>('embedVersion', '');
    const known = await db().catalog.count();

    if (known > 0 && version !== EMBED_VERSION) {
      // Vectors were produced by a different model or backend. They will not
      // rank correctly against a new query vector and will not say so.
      this.setStatus({ phase: 'idle', detail: 'index outdated — clearing' });
      await clearAll();
    }

    this.setStatus({ phase: 'downloading-model', progress: 0, detail: 'loading embedding model' });
    embedder.onProgress = (p) => {
      this.setStatus({
        progress: p.total ? p.loaded / p.total : 0,
        detail: `downloading ${p.file || 'model'}`,
      });
    };
    const backend = await embedder.init();
    await setKV('embedVersion', EMBED_VERSION);

    await this.reload();
    this.setStatus({
      phase: 'ready',
      backend,
      progress: 1,
      detail: this.knownCount ? `catalog restored (${backend})` : `empty catalog (${backend})`,
    });
  }

  /** Rebuilds the in-memory index from IndexedDB. */
  async reload(): Promise<void> {
    const [metas, bodyIds, docCount] = await Promise.all([
      db().catalog.toArray(),
      db().bodies.toCollection().primaryKeys() as Promise<number[]>,
      db().docs.count(),
    ]);

    this.matrix = new Float32Array(metas.length * EMBED_DIM);
    this.docIds = makeDocIds(metas.length);
    this.metaById = new Map();
    this.haveBody = new Set(bodyIds);

    metas.forEach((m, i) => {
      this.matrix.set(dequantize(new Int8Array(m.q), m.scale), i * EMBED_DIM);
      this.docIds[i] = m.docId;
      this.metaById.set(m.docId, m);
    });

    this.bm25 = new BM25Index(
      metas.map((m) => ({ docId: m.docId, text: `${m.title} ${m.section} ${m.snippet}` })),
    );

    this.setStatus({
      known: metas.length,
      stored: this.haveBody.size,
      documents: docCount,
    });
    this.onChange?.();
  }

  /* ---------------- search ---------------- */

  /**
   * Searches everything this node knows about.
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
        meta: this.metaById.get(hit.docId)!,
        rank: hit.score + BM25_WEIGHT * (lexical.get(hit.docId) ?? 0),
        hasBody: this.haveBody.has(hit.docId),
      }))
      .filter((h) => h.meta && h.score >= MIN_SCORE)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, k);
  }

  /* ---------------- uploads ---------------- */

  /**
   * Ingests a document uploaded here. Returns the metadata to announce.
   *
   * The uploading node always keeps the bodies it created — it is the first
   * replica by definition, and replication spreads outward from it rather than
   * the document existing nowhere until a policy pass runs.
   */
  async upload(
    filename: string,
    raw: string,
    originId: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ doc: DocRow; metas: MetaRow[] }> {
    const parsed = parseDocument(filename, raw);
    if (!parsed.chunks.length) throw new Error(`${filename} has no readable text`);

    const docKey = docKeyOf(parsed.title, raw);
    const now = Date.now();

    this.setStatus({
      phase: 'indexing',
      progress: 0,
      detail: `embedding ${parsed.chunks.length} passages from ${parsed.title}`,
    });

    const metas: MetaRow[] = [];
    const bodies: BodyRow[] = [];

    // Batched so progress is visible and memory stays flat on phones.
    const BATCH = 8;
    for (let i = 0; i < parsed.chunks.length; i += BATCH) {
      const batch = parsed.chunks.slice(i, i + BATCH);
      // Prefixing the heading gives the embedding context the body often lacks.
      const vectors = await embedder.embed(
        batch.map((c) => `${parsed.title} — ${c.section}. ${c.text}`),
      );
      batch.forEach((chunk, j) => {
        const seq = i + j;
        const docId = docIdOf(docKey, seq, chunk.text);
        const { q, scale } = quantize(vectors[j]);
        metas.push({
          docId,
          docKey,
          seq,
          title: parsed.title,
          section: chunk.section,
          snippet: chunk.text.slice(0, 200),
          q: q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength) as ArrayBuffer,
          scale,
          bytes: chunk.text.length,
          originId,
          version: 1,
          updatedAt: now,
        });
        bodies.push({ docId, text: chunk.text, storedAt: now, touchedAt: now });
      });
      onProgress?.(Math.min(i + BATCH, parsed.chunks.length), parsed.chunks.length);
      this.setStatus({ progress: Math.min(1, (i + BATCH) / parsed.chunks.length) });
    }

    const doc: DocRow = {
      docKey,
      title: parsed.title,
      source: parsed.source,
      bytes: metas.reduce((s, m) => s + m.bytes, 0),
      chunkCount: metas.length,
      originId,
      createdAt: now,
    };

    const d = db();
    await d.transaction('rw', d.docs, d.catalog, d.bodies, d.holders, async () => {
      await d.docs.put(doc);
      await d.catalog.bulkPut(metas);
      await d.bodies.bulkPut(bodies);
      await d.holders.bulkPut(
        metas.map((m) => ({ docId: m.docId, nodeId: originId, seenAt: now })),
      );
    });

    await this.reload();
    this.setStatus({ phase: 'ready', progress: 1, detail: `added ${parsed.title}` });
    return { doc, metas };
  }

  /* ---------------- gossip ingest ---------------- */

  /**
   * Accepts metadata learned from the mesh.
   *
   * Last-writer-wins on `version`, which is enough here because metadata is
   * immutable once published — the version exists to let a re-upload of a
   * corrected document supersede the old one, not to merge concurrent edits.
   */
  async ingestMeta(incoming: MetaRow[], doc?: DocRow): Promise<number> {
    if (!incoming.length) return 0;
    const fresh = incoming.filter((m) => {
      const existing = this.metaById.get(m.docId);
      return !existing || m.version > existing.version;
    });
    if (!fresh.length && !doc) return 0;

    const d = db();
    await d.transaction('rw', d.docs, d.catalog, async () => {
      if (doc) {
        const known = await d.docs.get(doc.docKey);
        if (!known) await d.docs.put(doc);
      }
      if (fresh.length) await d.catalog.bulkPut(fresh);
    });

    if (fresh.length) await this.reload();
    return fresh.length;
  }

  /* ---------------- bodies ---------------- */

  async getBody(docId: number): Promise<string | undefined> {
    const row = await db().bodies.get(docId);
    if (!row) return undefined;
    // Touch on read so eviction can prefer genuinely cold chunks.
    void db().bodies.update(docId, { touchedAt: Date.now() });
    return row.text;
  }

  /** Stores a body pulled from a peer as part of a replication decision. */
  async putBody(docId: number, text: string): Promise<void> {
    if (!this.metaById.has(docId)) return; // never store a body we cannot describe
    const now = Date.now();
    await db().bodies.put({ docId, text, storedAt: now, touchedAt: now });
    this.haveBody.add(docId);
    this.setStatus({ stored: this.haveBody.size });
    this.onChange?.();
  }

  /** Drops a body while keeping its metadata, so the chunk stays findable. */
  async evictBody(docId: number): Promise<void> {
    await db().bodies.delete(docId);
    this.haveBody.delete(docId);
    this.setStatus({ stored: this.haveBody.size });
    this.onChange?.();
  }

  /* ---------------- documents ---------------- */

  async documents(): Promise<DocRow[]> {
    return db().docs.orderBy('createdAt').reverse().toArray();
  }

  /**
   * Forgets a document locally: its metadata, its bodies, and its accounting.
   *
   * Local only. Other nodes keep their copies — there is no delete authority in
   * a mesh with no coordinator, and pretending otherwise would be a lie in the
   * UI. Re-announcement from a peer can legitimately bring it back.
   */
  async forget(docKey: number): Promise<void> {
    const d = db();
    const metas = await d.catalog.where('docKey').equals(docKey).toArray();
    const ids = metas.map((m) => m.docId);
    await d.transaction('rw', d.docs, d.catalog, d.bodies, d.holders, d.pop, async () => {
      await d.docs.delete(docKey);
      await d.catalog.bulkDelete(ids);
      await d.bodies.bulkDelete(ids);
      for (const docId of ids) {
        await d.holders.where('docId').equals(docId).delete();
        await d.pop.where('docId').equals(docId).delete();
      }
    });
    await this.reload();
  }

  /* ---------------- accounting ---------------- */

  /** Bytes of metadata and bodies held, and the budget they run against. */
  async usage(): Promise<{
    metaBytes: number;
    bodyBytes: number;
    budgetBytes: number;
    freeBytes: number;
  }> {
    const [bodies, budget] = await Promise.all([db().bodies.toArray(), storageBudget()]);
    const bodyBytes = bodies.reduce((s, b) => s + b.text.length, 0);
    const metaBytes = this.metas().reduce((s, m) => s + metaBytesOf(m), 0);
    return {
      metaBytes,
      bodyBytes,
      budgetBytes: budget.budgetBytes,
      freeBytes: Math.max(0, budget.budgetBytes - bodyBytes - metaBytes),
    };
  }
}

export const catalog = new Catalog();
