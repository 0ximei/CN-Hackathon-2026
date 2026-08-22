import type * as SQLite from 'expo-sqlite';

import { BM25Index } from '@core/search/bm25';
import { docIdOf, docKeyOf, parseDocument, type ParsedDoc } from '@core/lib/chunk';
import { normalizeUploadedText } from '@core/lib/textUpload';
import {
    EMBED_DIM,
    dequantize,
    makeDocIds,
    quantize,
    topK,
} from '@core/search/vector';

import { embedder } from '../search/embedder';
import {
    BM25_TIEBREAK,
    MIN_RELEVANCE,
    relevanceOf,
    termCoverage,
} from '../search/relevance';
import { fromBase64, toBase64 } from '../lib/base64';
import { openDatabase } from './schema';
import {
    SNIPPET_CHARS,
    metaBytesOf,
    type BodyRow,
    type CatalogStats,
    type DocRow,
    type DocSummary,
    type HolderRow,
    type MetaRow,
    type PeerStatRow,
    type LocalHit,
    type PeerIdentityRow,
    type PopRow,
    type Provenance,
} from './types';

// Re-exported so `localCatalog` stays the one import site for callers that
// already have it; the definitions live in `types.ts` because everything there
// is free of expo-sqlite, and therefore usable from a plain Node test run.
export { SNIPPET_CHARS, type LocalHit, type PeerIdentityRow };

/**
 * Everything this node knows *about*, and the subset it actually stores.
 *
 * The distinction is the whole design. A hit returned from here is not proof
 * this node holds the passage — it is proof it knows the passage exists, knows
 * it is relevant, and knows who to ask.
 */
export class LocalCatalog {
    /** Packed matrix of every known vector, for a single-pass scan. */
    private matrix = new Float32Array(0);
    private docIds = makeDocIds(0);
    private metaById = new Map<number, MetaRow>();
    /** docId -> its row in `matrix`. Rebuilt with the matrix, never apart from it. */
    private rowOf = new Map<number, number>();
    private docsByKey = new Map<number, DocRow>();
    private haveBody = new Set<number>();
    private bm25 = new BM25Index([]);
    /**
     * Whether the lexical index needs rebuilding.
     *
     * Gaining or losing a body changes what this node can match on, and a
     * reconcile pass under storage pressure sheds dozens of them in a row.
     * Rebuilding eagerly makes that O(n^2) tokenisations for a result nobody
     * looks at until the next query, so the work is deferred to the first
     * search that actually needs it.
     */
    private lexicalDirty = true;
    /** Bodies are read back constantly during ranking; keep them addressable. */
    private bodyText = new Map<number, string>();

    private budgetBytes = DEFAULT_BUDGET_BYTES;

    private constructor(private readonly db: SQLite.SQLiteDatabase) { }

    static async open(): Promise<LocalCatalog> {
        const catalog = new LocalCatalog(await openDatabase());
        const stored = await catalog.kvGet(BUDGET_KEY);
        const parsed = stored === null ? NaN : Number(stored);
        if (Number.isFinite(parsed) && parsed > 0) catalog.budgetBytes = parsed;
        await catalog.reload();
        return catalog;
    }

    /* ------------------------- in-memory index ------------------------ */

    /**
     * Rebuilds the searchable index from SQLite.
     *
     * Vectors are dequantized from what is on disk rather than recomputed from
     * text — which is the point of storing them at all. A node holding metadata
     * for a passage whose body lives on another phone has no text to embed, and
     * has to be able to score that passage anyway.
     */
    async reload(): Promise<void> {
        interface MetaSql extends Omit<MetaRow, 'q'> {
            q: string;
        }
        const [metaRows, bodyRows, docRows] = await Promise.all([
            this.db.getAllAsync<MetaSql>(
                `SELECT docId, docKey, seq, title, section, snippet, q, scale, bytes, originId, version, updatedAt
                   FROM meta ORDER BY docKey, seq`,
            ),
            this.db.getAllAsync<{ docId: number; text: string }>('SELECT docId, text FROM bodies'),
            this.db.getAllAsync<DocRow>(
                `SELECT docKey, title, source, bytes, chunkCount, originId, createdAt, provenance FROM docs`,
            ),
        ]);

        this.matrix = new Float32Array(metaRows.length * EMBED_DIM);
        this.docIds = makeDocIds(metaRows.length);
        this.metaById = new Map();
        this.rowOf = new Map();
        this.bodyText = new Map(bodyRows.map((b) => [b.docId, b.text]));
        this.haveBody = new Set(this.bodyText.keys());
        this.docsByKey = new Map(docRows.map((d) => [d.docKey, d]));

        metaRows.forEach((row, i) => {
            const bytes = fromBase64(row.q);
            const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            this.matrix.set(dequantize(q, row.scale), i * EMBED_DIM);
            this.docIds[i] = row.docId;
            this.rowOf.set(row.docId, i);
            this.metaById.set(row.docId, { ...row, q });
        });

        this.lexicalDirty = true;
    }

    /**
     * The lexical index, over the best text available for each chunk: the body
     * where this node holds it, the snippet where it does not.
     *
     * Holding the passage genuinely makes this node better at finding it. That
     * is the honest consequence of the two-tier split rather than a bug in it —
     * a node that only knows *about* a passage knows less about it.
     */
    private lexical(): BM25Index {
        if (this.lexicalDirty) {
            this.bm25 = new BM25Index(
                this.metas().map((m) => ({
                    docId: m.docId,
                    text: this.bodyText.get(m.docId) ?? `${m.title} ${m.section} ${m.snippet}`,
                })),
            );
            this.lexicalDirty = false;
        }
        return this.bm25;
    }

    /** Chunks this node has metadata for — what it can search. */
    get knownCount(): number {
        return this.metaById.size;
    }

    /** Chunks this node holds the text of — what it can serve. */
    get storedCount(): number {
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

    /** The body, if it is here. Synchronous because the index already holds it. */
    bodyOf(docId: number): string | undefined {
        return this.bodyText.get(docId);
    }

    snippet(docId: number): string {
        const meta = this.metaById.get(docId);
        if (!meta) return '';
        return meta.snippet;
    }

    docRow(docKey: number): DocRow | undefined {
        return this.docsByKey.get(docKey);
    }

    docRows(): DocRow[] {
        return [...this.docsByKey.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    stats(): CatalogStats {
        let metaBytes = 0;
        for (const m of this.metaById.values()) metaBytes += metaBytesOf(m);
        let bodyBytes = 0;
        for (const t of this.bodyText.values()) bodyBytes += t.length;
        return {
            documents: this.docsByKey.size,
            known: this.metaById.size,
            stored: this.haveBody.size,
            metaBytes,
            bodyBytes,
        };
    }

    /** One row per document, for the Library. */
    documents(): DocSummary[] {
        const chunks = new Map<number, { known: number; stored: number }>();
        for (const m of this.metaById.values()) {
            const entry = chunks.get(m.docKey) ?? { known: 0, stored: 0 };
            entry.known++;
            if (this.haveBody.has(m.docId)) entry.stored++;
            chunks.set(m.docKey, entry);
        }
        return [...this.docsByKey.values()]
            .map((doc) => {
                const counts = chunks.get(doc.docKey) ?? { known: 0, stored: 0 };
                return {
                    docKey: doc.docKey,
                    title: doc.title,
                    source: doc.source,
                    provenance: doc.provenance,
                    originId: doc.originId,
                    chunks: counts.known,
                    storedHere: counts.stored,
                    bytes: doc.bytes,
                    createdAt: doc.createdAt,
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /* ------------------------------ search ---------------------------- */

    /**
     * Searches everything this node knows about, body or not.
     *
     * `queryText` comes along for the ride because a QUERY packet carries a
     * short text field beside the vector — enough for lexical scoring of exact
     * clinical terms without shipping the whole query.
     */
    searchLocal(queryVec: Float32Array, queryText: string, k: number): LocalHit[] {
        if (!this.docIds.length) return [];

        const dense = topK(queryVec, this.matrix, this.docIds, Math.min(k * 4, this.docIds.length));
        const lexical = queryText ? this.lexical().score(queryText) : new Map<number, number>();

        // Candidates come from both halves. A passage whose exact term matches
        // but whose hashed vector does not would otherwise never be considered,
        // and on this embedder that is the common case rather than the exotic
        // one — nothing in a hashing embedder knows that "haemorrhage" and
        // "bleeding" are related, but BM25 at least knows the word is there.
        const candidates = new Set<number>(dense.map((d) => d.docId));
        for (const docId of lexical.keys()) candidates.add(docId);

        const normalized = BM25Index.normalize(lexical);
        const scored: { hit: LocalHit; rank: number }[] = [];
        for (const docId of candidates) {
            const meta = this.metaById.get(docId);
            if (!meta) continue;
            const coverage = termCoverage(
                queryText,
                `${meta.title} ${meta.section} ${this.bodyText.get(docId) ?? meta.snippet}`,
            );
            const relevance = relevanceOf(this.cosine(queryVec, docId), coverage);
            if (relevance < MIN_RELEVANCE) continue;
            scored.push({
                hit: {
                    docId,
                    score: relevance,
                    meta,
                    hasBody: this.haveBody.has(docId),
                },
                // Ordering only, and only here: a BM25 score normalised against
                // this node's index means nothing on another node's.
                rank: relevance + BM25_TIEBREAK * (normalized.get(docId) ?? 0),
            });
        }

        return scored
            .sort((a, b) => b.rank - a.rank)
            .slice(0, k)
            .map((s) => s.hit);
    }

    private cosine(queryVec: Float32Array, docId: number): number {
        const row = this.rowOf.get(docId);
        if (row === undefined) return 0;
        const off = row * EMBED_DIM;
        let s = 0;
        for (let d = 0; d < EMBED_DIM; d++) s += queryVec[d] * this.matrix[off + d];
        return s;
    }

    /* ------------------------------ uploads --------------------------- */

    /**
     * Ingests a document uploaded on this device.
     *
     * The uploading node always keeps the bodies it created: it is the first
     * replica by definition, and replication spreads outward from it rather
     * than the document existing nowhere until a policy pass runs.
     */
    async upload(
        filename: string,
        raw: string,
        originId: number,
        onProgress?: (done: number, total: number) => void,
    ): Promise<{ doc: DocRow; metas: MetaRow[] }> {
        const text = normalizeUploadedText(raw);
        if (!text) throw new Error(`${filename} has no readable text`);
        const parsed = parseDocument(filename, text);
        if (!parsed.chunks.length) throw new Error(`${filename} has no readable text`);
        return this.ingestParsed(parsed, originId, 'local', undefined, onProgress);
    }

    /**
     * Writes a parsed document into both tiers.
     *
     * `bodyFilter` is what makes seeding interesting: metadata is written for
     * every chunk, so the node knows the whole corpus exists, while bodies are
     * written only for the slice it is meant to carry. That is the two-tier
     * split visible from the first launch rather than only after replication
     * has had time to run.
     */
    async ingestParsed(
        parsed: ParsedDoc,
        originId: number,
        provenance: Provenance,
        bodyFilter?: (docId: number) => boolean,
        onProgress?: (done: number, total: number) => void,
    ): Promise<{ doc: DocRow; metas: MetaRow[] }> {
        const body = parsed.chunks.map((c) => c.text).join('\n');
        const docKey = docKeyOf(parsed.title, body);
        const now = Date.now();

        const metas: MetaRow[] = [];
        const bodies: BodyRow[] = [];

        parsed.chunks.forEach((chunk, seq) => {
            const docId = docIdOf(docKey, seq, chunk.text);
            // Prefixing the heading gives the embedding context the passage
            // itself often lacks — "Cool the burn" says nothing about burns
            // beyond the word, and the section heading does.
            const { q, scale } = quantize(
                embedder.embed(`${parsed.title} - ${chunk.section}. ${chunk.text}`),
            );
            metas.push({
                docId,
                docKey,
                seq,
                title: parsed.title,
                section: chunk.section,
                snippet: chunk.text.slice(0, SNIPPET_CHARS),
                q,
                scale,
                bytes: chunk.text.length,
                originId,
                version: 1,
                updatedAt: now,
            });
            if (!bodyFilter || bodyFilter(docId)) {
                bodies.push({ docId, text: chunk.text, storedAt: now, touchedAt: now });
            }
            onProgress?.(seq + 1, parsed.chunks.length);
        });

        const doc: DocRow = {
            docKey,
            title: parsed.title,
            source: parsed.source,
            bytes: metas.reduce((s, m) => s + m.bytes, 0),
            chunkCount: metas.length,
            originId,
            createdAt: now,
            provenance,
        };

        await this.db.withTransactionAsync(async () => {
            await this.writeDoc(doc);
            for (const meta of metas) await this.writeMeta(meta);
            for (const b of bodies) await this.writeBody(b);
        });

        await this.reload();
        return { doc, metas };
    }

    /* --------------------------- gossip ingest ------------------------ */

    /**
     * Accepts metadata learned from the mesh.
     *
     * Last-writer-wins on `version`, which is enough because metadata is
     * immutable once published — the version exists so a re-upload of a
     * corrected document can supersede the old one, not to merge concurrent
     * edits, which nothing here produces.
     */
    async ingestMeta(incoming: MetaRow[], doc?: DocRow): Promise<number> {
        const fresh = incoming.filter((m) => {
            const existing = this.metaById.get(m.docId);
            return !existing || m.version > existing.version;
        });
        // A re-announcement of unchanged metadata is the common case, not the
        // exception: the reconcile loop rebroadcasts a rotating slice of the
        // library every few seconds purely to refresh holder claims. Reloading
        // the whole index for one of those would rebuild the vector matrix
        // several times a minute for no change at all.
        const newDoc = doc && !this.docsByKey.has(doc.docKey) ? doc : null;
        if (!fresh.length && !newDoc) return 0;

        await this.db.withTransactionAsync(async () => {
            if (newDoc) await this.writeDoc(newDoc);
            for (const meta of fresh) await this.writeMeta(meta);
        });

        await this.reload();
        return fresh.length;
    }

    /* ------------------------------ bodies ---------------------------- */

    async getBody(docId: number): Promise<string | undefined> {
        const text = this.bodyText.get(docId);
        if (text === undefined) return undefined;
        // Touch on read so eviction can prefer genuinely cold chunks.
        await this.db.runAsync('UPDATE bodies SET touchedAt = ? WHERE docId = ?', [
            Date.now(),
            docId,
        ]);
        return text;
    }

    /** Stores a body pulled from a peer as part of a replication decision. */
    async putBody(docId: number, text: string): Promise<void> {
        // Never store a body this node cannot describe: an undescribable body
        // is unfindable and unservable, and it would count against the budget
        // while doing the mesh no good at all.
        if (!this.metaById.has(docId)) return;
        const now = Date.now();
        await this.writeBody({ docId, text, storedAt: now, touchedAt: now });
        this.bodyText.set(docId, text);
        this.haveBody.add(docId);
        this.lexicalDirty = true;
    }

    /** Drops a body while keeping its metadata, so the chunk stays findable. */
    async evictBody(docId: number): Promise<void> {
        await this.db.runAsync('DELETE FROM bodies WHERE docId = ?', [docId]);
        this.bodyText.delete(docId);
        this.haveBody.delete(docId);
        this.lexicalDirty = true;
    }

    async bodyRows(docIds: number[]): Promise<Map<number, BodyRow>> {
        if (!docIds.length) return new Map();
        const rows = await this.db.getAllAsync<BodyRow>(
            `SELECT docId, text, storedAt, touchedAt FROM bodies WHERE docId IN (${holes(docIds.length)})`,
            docIds,
        );
        return new Map(rows.map((r) => [r.docId, r]));
    }

    /**
     * Drops metadata this node is no longer one of the carriers for.
     *
     * Unlike evicting a body this makes the chunk invisible here: it can no
     * longer be scored, so this node stops answering queries about it. That is
     * the intended effect of a bounded metadata target. A document left with no
     * chunks loses its row too, so the Library does not list something the node
     * knows nothing about.
     */
    async evictMeta(docIds: number[]): Promise<number> {
        const ids = docIds.filter((id) => this.metaById.has(id));
        if (!ids.length) return 0;
        const docKeys = new Set(ids.map((id) => this.metaById.get(id)!.docKey));
        await this.db.withTransactionAsync(async () => {
            const list = holes(ids.length);
            await this.db.runAsync(`DELETE FROM meta WHERE docId IN (${list})`, ids);
            await this.db.runAsync(`DELETE FROM bodies WHERE docId IN (${list})`, ids);
            await this.db.runAsync(`DELETE FROM holders WHERE docId IN (${list})`, ids);
            await this.db.runAsync(`DELETE FROM pop WHERE docId IN (${list})`, ids);
            for (const docKey of docKeys) {
                const left = await this.db.getFirstAsync<{ n: number }>(
                    'SELECT COUNT(*) AS n FROM meta WHERE docKey = ?',
                    [docKey],
                );
                if (!left?.n) await this.db.runAsync('DELETE FROM docs WHERE docKey = ?', [docKey]);
            }
        });
        await this.reload();
        return ids.length;
    }

    /**
     * Forgets a document on this device: metadata, bodies and accounting.
     *
     * Local only. There is no delete authority in a mesh with no coordinator,
     * and pretending otherwise would be a lie in the UI — re-announcement from
     * a peer can legitimately bring it back, and the Library says so.
     */
    async forget(docKey: number): Promise<void> {
        const ids = this.metas()
            .filter((m) => m.docKey === docKey)
            .map((m) => m.docId);
        await this.db.withTransactionAsync(async () => {
            await this.db.runAsync('DELETE FROM docs WHERE docKey = ?', [docKey]);
            if (ids.length) {
                const list = holes(ids.length);
                await this.db.runAsync(`DELETE FROM meta WHERE docId IN (${list})`, ids);
                await this.db.runAsync(`DELETE FROM bodies WHERE docId IN (${list})`, ids);
                await this.db.runAsync(`DELETE FROM holders WHERE docId IN (${list})`, ids);
                await this.db.runAsync(`DELETE FROM pop WHERE docId IN (${list})`, ids);
            }
        });
        await this.reload();
    }

    /** Wipes only the seed corpus, so re-slicing never touches real content. */
    async clearSeed(): Promise<void> {
        const seedKeys = this.docRows()
            .filter((d) => d.provenance === 'seed')
            .map((d) => d.docKey);
        for (const docKey of seedKeys) await this.forget(docKey);
    }

    /* ---------------------------- accounting -------------------------- */

    async usage(): Promise<{
        metaBytes: number;
        bodyBytes: number;
        budgetBytes: number;
        freeBytes: number;
    }> {
        const { metaBytes, bodyBytes } = this.stats();
        return {
            metaBytes,
            bodyBytes,
            budgetBytes: this.budgetBytes,
            freeBytes: Math.max(0, this.budgetBytes - metaBytes - bodyBytes),
        };
    }

    get budget(): number {
        return this.budgetBytes;
    }

    async setBudget(bytes: number): Promise<void> {
        this.budgetBytes = Math.max(1024, Math.floor(bytes));
        await this.kvSet(BUDGET_KEY, String(this.budgetBytes));
    }

    /* ------------------------------ holders --------------------------- */

    async holderRows(): Promise<HolderRow[]> {
        return this.db.getAllAsync<HolderRow>('SELECT docId, nodeId, seenAt FROM holders');
    }

    async putHolders(rows: HolderRow[]): Promise<void> {
        if (!rows.length) return;
        await this.db.withTransactionAsync(async () => {
            for (const r of rows) {
                await this.db.runAsync(
                    'INSERT OR REPLACE INTO holders (docId, nodeId, seenAt) VALUES (?, ?, ?)',
                    [r.docId, r.nodeId, r.seenAt],
                );
            }
        });
    }

    async deleteHolder(docId: number, nodeId: number): Promise<void> {
        await this.db.runAsync('DELETE FROM holders WHERE docId = ? AND nodeId = ?', [docId, nodeId]);
    }

    async deleteHoldersOf(nodeId: number, docIds: number[]): Promise<void> {
        if (!docIds.length) return;
        await this.db.runAsync(
            `DELETE FROM holders WHERE nodeId = ? AND docId IN (${holes(docIds.length)})`,
            [nodeId, ...docIds],
        );
    }

    /* --------------------------- popularity --------------------------- */

    async popRows(): Promise<PopRow[]> {
        return this.db.getAllAsync<PopRow>('SELECT docId, nodeId, hits, updatedAt FROM pop');
    }

    async popOf(nodeId: number): Promise<PopRow[]> {
        return this.db.getAllAsync<PopRow>(
            'SELECT docId, nodeId, hits, updatedAt FROM pop WHERE nodeId = ?',
            [nodeId],
        );
    }

    async bumpPop(docIds: number[], selfId: number): Promise<void> {
        if (!docIds.length) return;
        const now = Date.now();
        await this.db.withTransactionAsync(async () => {
            for (const docId of docIds) {
                await this.db.runAsync(
                    `INSERT INTO pop (docId, nodeId, hits, updatedAt) VALUES (?, ?, 1, ?)
                     ON CONFLICT(docId, nodeId) DO UPDATE SET hits = hits + 1, updatedAt = excluded.updatedAt`,
                    [docId, selfId, now],
                );
            }
        });
    }

    /** Records a peer's gossiped share. `max`, never `+`: shares are monotonic. */
    async mergePop(docId: number, nodeId: number, hits: number): Promise<void> {
        await this.db.runAsync(
            `INSERT INTO pop (docId, nodeId, hits, updatedAt) VALUES (?, ?, ?, ?)
             ON CONFLICT(docId, nodeId) DO UPDATE SET
               hits = MAX(pop.hits, excluded.hits), updatedAt = excluded.updatedAt`,
            [docId, nodeId, hits, Date.now()],
        );
    }

    /* --------------------------- peer stats --------------------------- */

    async peerStats(): Promise<PeerStatRow[]> {
        return this.db.getAllAsync<PeerStatRow>(
            `SELECT nodeId, firstSeen, lastSeen, helloSeen, helloExpected, requests, responses, freeBytes
               FROM peerStats`,
        );
    }

    async peerStat(nodeId: number): Promise<PeerStatRow | null> {
        return this.db.getFirstAsync<PeerStatRow>(
            `SELECT nodeId, firstSeen, lastSeen, helloSeen, helloExpected, requests, responses, freeBytes
               FROM peerStats WHERE nodeId = ?`,
            [nodeId],
        );
    }

    async putPeerStats(rows: PeerStatRow[]): Promise<void> {
        if (!rows.length) return;
        await this.db.withTransactionAsync(async () => {
            for (const r of rows) {
                await this.db.runAsync(
                    `INSERT OR REPLACE INTO peerStats
                       (nodeId, firstSeen, lastSeen, helloSeen, helloExpected, requests, responses, freeBytes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        r.nodeId,
                        r.firstSeen,
                        r.lastSeen,
                        r.helloSeen,
                        r.helloExpected,
                        r.requests,
                        r.responses,
                        r.freeBytes,
                    ],
                );
            }
        });
    }

    /* ------------------------ peer identities ------------------------- */

    async peerIdentities(): Promise<PeerIdentityRow[]> {
        return this.db.getAllAsync<PeerIdentityRow>(
            `SELECT nodeId, publicKeyHex, name, firstSeen, verifiedAt, trustedAt, state, detail
               FROM peerIdentities`,
        );
    }

    async putPeerIdentity(row: PeerIdentityRow): Promise<void> {
        await this.db.runAsync(
            `INSERT OR REPLACE INTO peerIdentities
               (nodeId, publicKeyHex, name, firstSeen, verifiedAt, trustedAt, state, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.nodeId,
                row.publicKeyHex,
                row.name,
                row.firstSeen,
                row.verifiedAt,
                row.trustedAt,
                row.state,
                row.detail,
            ],
        );
    }

    /* ---------------------------- key/value --------------------------- */

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

    /* ------------------------------ outbox ---------------------------- */

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
            : this.db.getAllAsync(
                'SELECT id, dstId, payload FROM outbox WHERE dstId = ? ORDER BY queuedAt',
                [dstId],
            );
    }

    async dequeue(id: number): Promise<void> {
        await this.db.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
    }

    async queuedCount(): Promise<number> {
        const row = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
        return row?.n ?? 0;
    }

    /* ------------------------------ writes ---------------------------- */

    private async writeDoc(doc: DocRow): Promise<void> {
        await this.db.runAsync(
            `INSERT OR REPLACE INTO docs
               (docKey, title, source, bytes, chunkCount, originId, createdAt, provenance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                doc.docKey,
                doc.title,
                doc.source,
                doc.bytes,
                doc.chunkCount,
                doc.originId,
                doc.createdAt,
                doc.provenance,
            ],
        );
    }

    private async writeMeta(meta: MetaRow): Promise<void> {
        await this.db.runAsync(
            `INSERT OR REPLACE INTO meta
               (docId, docKey, seq, title, section, snippet, q, scale, bytes, originId, version, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                meta.docId,
                meta.docKey,
                meta.seq,
                meta.title,
                meta.section,
                meta.snippet,
                toBase64(new Uint8Array(meta.q.buffer, meta.q.byteOffset, meta.q.byteLength)),
                meta.scale,
                meta.bytes,
                meta.originId,
                meta.version,
                meta.updatedAt,
            ],
        );
    }

    private async writeBody(body: BodyRow): Promise<void> {
        await this.db.runAsync(
            'INSERT OR REPLACE INTO bodies (docId, text, storedAt, touchedAt) VALUES (?, ?, ?, ?)',
            [body.docId, body.text, body.storedAt, body.touchedAt],
        );
    }
}

const BUDGET_KEY = 'storageBudget';

/**
 * How much room a node offers the mesh before an operator changes it.
 *
 * Far smaller than a phone's free space on purpose. The number is a demo dial:
 * the point of the two-tier split only becomes visible when a node is asked to
 * hold more than it can, and a default sized to the device would mean nobody
 * ever saw it happen.
 */
const DEFAULT_BUDGET_BYTES = 1024 * 1024;

/** `?, ?, ?` for an IN clause of n values. */
function holes(n: number): string {
    return new Array(n).fill('?').join(', ');
}
