import * as SQLite from 'expo-sqlite';

import { BM25Index } from '@core/search/bm25';
import { docIdOf, docKeyOf, type ParsedDoc } from '@core/lib/chunk';
import { EMBED_DIM, makeDocIds, topK, type Scored } from '@core/search/vector';
import { embedder } from '../search/embedder';

import type { StoredChunk, CatalogStats, DocSummary, Provenance } from './types';

const DATABASE = 'meshnet.db';

/** How much of a chunk travels inside a RESULT packet. */
const SNIPPET_CHARS = 200;

export class LocalCatalog {
    private matrix = new Float32Array(0);
    private docIds = makeDocIds(0);
    private byId = new Map<number, StoredChunk>();
    private lexical = new BM25Index([]);

    private constructor(private readonly db: SQLite.SQLiteDatabase) { }

    static async open(): Promise<LocalCatalog> {
        const db = await SQLite.openDatabaseAsync(DATABASE);
        await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chunks (
        docId      INTEGER PRIMARY KEY NOT NULL,
        docKey     INTEGER NOT NULL,
        seq        INTEGER NOT NULL,
        title      TEXT NOT NULL,
        section    TEXT NOT NULL,
        source     TEXT NOT NULL,
        text       TEXT NOT NULL,
        addedAt    INTEGER NOT NULL,
        provenance TEXT NOT NULL DEFAULT 'seed'
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
        // `CREATE TABLE IF NOT EXISTS` above does not add columns to a table that
        // already existed from before `provenance` was introduced — migrate those
        // in place instead of forcing a reinstall.
        const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(chunks)');
        if (!columns.some((c) => c.name === 'provenance')) {
            await db.execAsync(`ALTER TABLE chunks ADD COLUMN provenance TEXT NOT NULL DEFAULT 'seed'`);
        }
        const catalog = new LocalCatalog(db);
        await catalog.reload();
        return catalog;
    }

    /* ---------------------------- ingest ---------------------------- */

    async ingestDoc(
        doc: ParsedDoc,
        filter?: (docId: number) => boolean,
        provenance: 'seed' | 'local' = 'local',
    ): Promise<number> {
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
             (docId, docKey, seq, title, section, source, text, addedAt, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [docId, docKey, seq, doc.title, chunk.section, doc.source, chunk.text, now, provenance],
                );
                written++;
            }
        });
        return written;
    }

    /** Writes a chunk received from a peer. Always tagged `mesh` — never caller-supplied. */
    async ingestRemote(chunk: Omit<StoredChunk, 'provenance'>): Promise<boolean> {
        if (this.byId.has(chunk.docId)) return false;
        await this.db.runAsync(
            `INSERT OR IGNORE INTO chunks
         (docId, docKey, seq, title, section, source, text, addedAt, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                chunk.docId,
                chunk.docKey,
                chunk.seq,
                chunk.title,
                chunk.section,
                chunk.source,
                chunk.text,
                Date.now(),
                'mesh' satisfies Provenance,
            ],
        );
        return true;
    }

    async reload(): Promise<void> {
        const rows = await this.db.getAllAsync<StoredChunk>(
            `SELECT docId, docKey, seq, title, section, source, text, provenance FROM chunks ORDER BY docKey, seq`,
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

    search(queryVec: Float32Array, queryText: string, k: number): Scored[] {
        if (!this.docIds.length) return [];

        const dense = topK(queryVec, this.matrix, this.docIds, Math.max(k * 3, k));
        const lexical = BM25Index.normalize(this.lexical.score(queryText));

        const blended = new Map<number, number>();
        for (const hit of dense) blended.set(hit.docId, hit.score * 0.6);
        for (const [docId, score] of lexical) {
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

    /** Every chunk of one document, in order — what `announce()` gossips. */
    chunksOf(docKey: number): StoredChunk[] {
        return [...this.byId.values()]
            .filter((c) => c.docKey === docKey)
            .sort((a, b) => a.seq - b.seq);
    }

    /** One row per document held here, for the Files tab. */
    documents(): DocSummary[] {
        const byDoc = new Map<number, DocSummary>();
        for (const c of this.byId.values()) {
            const existing = byDoc.get(c.docKey);
            if (existing) {
                existing.chunks++;
                existing.bytes += c.text.length;
            } else {
                byDoc.set(c.docKey, {
                    docKey: c.docKey,
                    title: c.title,
                    source: c.source,
                    provenance: c.provenance,
                    chunks: 1,
                    bytes: c.text.length,
                });
            }
        }
        return [...byDoc.values()].sort((a, b) => a.title.localeCompare(b.title));
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

    /**
     * Wipes only the seed corpus, so re-slicing coverage never touches uploads
     * or documents pulled in from the mesh.
     */
    async clearSeed(): Promise<void> {
        await this.db.execAsync(`DELETE FROM chunks WHERE provenance = 'seed'; DELETE FROM outbox;`);
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
