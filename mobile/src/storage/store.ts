import * as SQLite from 'expo-sqlite';

import { BM25Index } from '@core/search/bm25';
import { docIdOf, docKeyOf, type ParsedDoc } from '@core/lib/chunk';
import { EMBED_DIM, makeDocIds, topK, type Scored } from '@core/search/vector';
import { embedder } from '../search/embedder';

const DATABASE = 'meshnet.db';

/** How much of a chunk travels inside a RESULT packet. */
const SNIPPET_CHARS = 200;

export interface StoredChunk {
  docId: number;
  docKey: number;
  seq: number;
  title: string;
  section: string;
  source: string;
  text: string;
}

export interface CatalogStats {
  documents: number;
  chunks: number;
  bytes: number;
}

/**
 * Local storage and local search.
 *
 * The web build layers Dexie over IndexedDB and keeps metadata and bodies in
 * separate tables so the two can replicate at different factors. That split
 * earns its complexity across a dozen browser tabs sharing one disk; on a phone
 * holding a 26 KB corpus it would be ceremony, so this keeps one table and
 * replicates whole chunks.
 *
 * Embeddings are not stored. `HashingEmbedder` is deterministic and takes
 * microseconds, so recomputing the matrix at launch is faster than reading it
 * back and removes any chance of a stored vector outliving the embedder that
 * produced it — a mismatch that would silently return wrong results rather
 * than fail.
 */
export class LocalCatalog {
  private matrix = new Float32Array(0);
  private docIds = makeDocIds(0);
  private byId = new Map<number, StoredChunk>();
  private lexical = new BM25Index([]);

  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(): Promise<LocalCatalog> {
    const db = await SQLite.openDatabaseAsync(DATABASE);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chunks (
        docId   INTEGER PRIMARY KEY NOT NULL,
        docKey  INTEGER NOT NULL,
        seq     INTEGER NOT NULL,
        title   TEXT NOT NULL,
        section TEXT NOT NULL,
        source  TEXT NOT NULL,
        text    TEXT NOT NULL,
        addedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_docKey ON chunks (docKey);
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        dstId     INTEGER NOT NULL,
        payload   TEXT NOT NULL,
        queuedAt  INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_dst ON outbox (dstId);
    `);
    const catalog = new LocalCatalog(db);
    await catalog.reload();
    return catalog;
  }

  /* ---------------------------- ingest ---------------------------- */

  /**
   * Store a parsed document's chunks.
   *
   * Ids are content-addressed by `docIdOf`, so re-ingesting the same document
   * is a no-op rather than a duplicate, and a chunk that arrives over the radio
   * from a peer collides with the local copy exactly when it is the same text.
   */
  async ingestDoc(doc: ParsedDoc, filter?: (docId: number) => boolean): Promise<number> {
    const body = doc.chunks.map((c) => c.text).join('\n');
    const docKey = docKeyOf(doc.title, body);
    const now = Date.now();
    let written = 0;

    await this.db.withTransactionAsync(async () => {
      for (let seq = 0; seq < doc.chunks.length; seq++) {
        const chunk = doc.chunks[seq];
        const docId = docIdOf(docKey, seq, chunk.text);
        if (filter && !filter(docId)) continue;
        await this.db.runAsync(
          `INSERT OR IGNORE INTO chunks
             (docId, docKey, seq, title, section, source, text, addedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [docId, docKey, seq, doc.title, chunk.section, doc.source, chunk.text, now],
        );
        written++;
      }
    });
    return written;
  }

  /** Store one chunk learned from a peer. Returns false if already held. */
  async ingestRemote(chunk: StoredChunk): Promise<boolean> {
    if (this.byId.has(chunk.docId)) return false;
    await this.db.runAsync(
      `INSERT OR IGNORE INTO chunks
         (docId, docKey, seq, title, section, source, text, addedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        chunk.docId,
        chunk.docKey,
        chunk.seq,
        chunk.title,
        chunk.section,
        chunk.source,
        chunk.text,
        Date.now(),
      ],
    );
    return true;
  }

  /** Rebuilds the in-memory search structures from SQLite. */
  async reload(): Promise<void> {
    const rows = await this.db.getAllAsync<StoredChunk>(
      `SELECT docId, docKey, seq, title, section, source, text FROM chunks ORDER BY docKey, seq`,
    );

    this.byId = new Map(rows.map((r) => [r.docId, r]));
    this.docIds = makeDocIds(rows.length);
    this.matrix = new Float32Array(rows.length * EMBED_DIM);

    for (let i = 0; i < rows.length; i++) {
      this.docIds[i] = rows[i].docId;
      this.matrix.set(embedder.embed(rows[i].text), i * EMBED_DIM);
    }

    this.lexical = new BM25Index(rows.map((r) => ({ docId: r.docId, text: r.text })));
  }

  /* ---------------------------- search ---------------------------- */

  /**
   * Hybrid rank over the local chunks.
   *
   * The vector half handles paraphrase, the lexical half handles the exact
   * clinical terms an embedding blurs. With a hashing embedder the lexical half
   * carries more of the weight than it would against MiniLM, which is why it is
   * blended rather than used only as a tiebreak.
   */
  search(queryVec: Float32Array, queryText: string, k: number): Scored[] {
    if (!this.docIds.length) return [];

    const dense = topK(queryVec, this.matrix, this.docIds, Math.max(k * 3, k));
    const lexical = BM25Index.normalize(this.lexical.score(queryText));

    const blended = new Map<number, number>();
    for (const hit of dense) blended.set(hit.docId, hit.score * 0.6);
    for (const [docId, score] of lexical) {
      // A strong lexical match on a chunk the vector scan missed still deserves
      // to surface; without this the blend could only ever re-order the dense
      // shortlist.
      blended.set(docId, (blended.get(docId) ?? 0) + score * 0.4);
    }

    return [...blended.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  chunk(docId: number): StoredChunk | undefined {
    return this.byId.get(docId);
  }

  snippet(docId: number): string {
    const text = this.byId.get(docId)?.text ?? '';
    return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
  }

  all(): StoredChunk[] {
    return [...this.byId.values()];
  }

  stats(): CatalogStats {
    let bytes = 0;
    const docs = new Set<number>();
    for (const chunk of this.byId.values()) {
      bytes += chunk.text.length;
      docs.add(chunk.docKey);
    }
    return { documents: docs.size, chunks: this.byId.size, bytes };
  }

  async clear(): Promise<void> {
    await this.db.execAsync('DELETE FROM chunks; DELETE FROM outbox;');
    await this.reload();
  }

  /* ------------------------- key/value ---------------------------- */

  async kvGet(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      [key],
    );
    return row?.value ?? null;
  }

  async kvSet(key: string, value: string): Promise<void> {
    await this.db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [key, value]);
  }

  /* -------------------------- outbox ------------------------------ */

  async enqueue(dstId: number, payload: string, ttlMs: number): Promise<void> {
    const now = Date.now();
    await this.db.runAsync(
      'INSERT INTO outbox (dstId, payload, queuedAt, expiresAt) VALUES (?, ?, ?, ?)',
      [dstId, payload, now, now + ttlMs],
    );
  }

  async dueFor(dstId?: number): Promise<{ id: number; dstId: number; payload: string }[]> {
    await this.db.runAsync('DELETE FROM outbox WHERE expiresAt < ?', [Date.now()]);
    return dstId === undefined
      ? this.db.getAllAsync('SELECT id, dstId, payload FROM outbox ORDER BY queuedAt')
      : this.db.getAllAsync('SELECT id, dstId, payload FROM outbox WHERE dstId = ? ORDER BY queuedAt', [
          dstId,
        ]);
  }

  async dequeue(id: number): Promise<void> {
    await this.db.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
  }

  async queuedCount(): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    return row?.n ?? 0;
  }
}
