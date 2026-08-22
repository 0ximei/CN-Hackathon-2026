import { docIdOf, docKeyOf, parseDocument, type ParsedDoc } from '@core/lib/chunk';
import { normalizeUploadedText } from '@core/lib/textUpload';
import { BM25Index } from '@core/search/bm25';
import { EMBED_DIM, quantize } from '@core/search/vector';

import { hashDocument } from '../identity/authorship';
import { embedder } from '../search/embedder';
import { BM25_TIEBREAK, MIN_RELEVANCE, relevanceOf, termCoverage } from '../search/relevance';
import type { MeshCatalog } from './MeshCatalog';
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

/**
 * The catalog with the database taken out.
 *
 * The real one is SQLite behind expo-sqlite, which needs a device. Everything
 * worth testing about a mesh — who answers, which way replies travel, what
 * replication decides to hold — is indifferent to the storage engine, and the
 * ranking and two-tier accounting here are deliberately the same arithmetic as
 * `LocalCatalog` so a test that passes is saying something about the app rather
 * than about a stub.
 *
 * It lives beside the real implementation rather than inside the test file so
 * the two are edited together: an interface method added to one and not the
 * other is a compile error here, not a mystery later.
 */
export class MemoryCatalog implements MeshCatalog {
    private metaById = new Map<number, MetaRow>();
    private docsByKey = new Map<number, DocRow>();
    private bodies = new Map<number, BodyRow>();
    private holders = new Map<string, HolderRow>();
    private pop = new Map<string, PopRow>();
    private stats_ = new Map<number, PeerStatRow>();
    private ids = new Map<number, PeerIdentityRow>();
    private kv = new Map<string, string>();
    private outbox: { id: number; dstId: number; payload: string; expiresAt: number }[] = [];
    private nextOutboxId = 1;
    private bm25 = new BM25Index([]);
    private budgetBytes = 8 * 1024 * 1024;

    /* --------------------------- test helpers --------------------------- */

    /** Writes a single passage this node both knows and holds. */
    add(docId: number, title: string, text: string, docKey = 1): void {
        const { q, scale } = quantize(embedder.embed(`${title} - . ${text}`));
        this.metaById.set(docId, {
            docId,
            docKey,
            seq: 0,
            title,
            section: '',
            snippet: text.slice(0, SNIPPET_CHARS),
            q,
            scale,
            bytes: text.length,
            originId: 0,
            version: 1,
            updatedAt: Date.now(),
        });
        this.bodies.set(docId, { docId, text, storedAt: Date.now(), touchedAt: Date.now() });
        if (!this.docsByKey.has(docKey)) {
            this.docsByKey.set(docKey, {
                docKey,
                title,
                source: 'test',
                bytes: text.length,
                chunkCount: 1,
                originId: 0,
                createdAt: Date.now(),
                provenance: 'seed',
                docHash: hashDocument(title, [text]),
                authorship: 'unsigned',
            });
        }
        this.reindex();
    }

    async attest(docKey: number, authorKey: Uint8Array, sig: Uint8Array): Promise<void> {
        const doc = this.docsByKey.get(docKey);
        if (!doc) return;
        this.docsByKey.set(docKey, { ...doc, authorKey, sig, authorship: 'verified' });
    }

    /** Drops the body but keeps the metadata — a metadata-only node, on demand. */
    dropBody(docId: number): void {
        this.bodies.delete(docId);
        this.reindex();
    }

    /* ------------------------------- index ------------------------------ */

    get knownCount() {
        return this.metaById.size;
    }
    get storedCount() {
        return this.bodies.size;
    }
    get budget() {
        return this.budgetBytes;
    }

    metas(): MetaRow[] {
        return [...this.metaById.values()];
    }
    getMeta(docId: number) {
        return this.metaById.get(docId);
    }
    holdsBody(docId: number) {
        return this.bodies.has(docId);
    }
    bodyOf(docId: number) {
        return this.bodies.get(docId)?.text;
    }
    snippet(docId: number) {
        return this.metaById.get(docId)?.snippet ?? '';
    }
    docRow(docKey: number) {
        return this.docsByKey.get(docKey);
    }
    docRows(): DocRow[] {
        return [...this.docsByKey.values()];
    }

    documents(): DocSummary[] {
        const counts = new Map<number, { known: number; stored: number }>();
        for (const m of this.metaById.values()) {
            const c = counts.get(m.docKey) ?? { known: 0, stored: 0 };
            c.known++;
            if (this.bodies.has(m.docId)) c.stored++;
            counts.set(m.docKey, c);
        }
        return this.docRows().map((doc) => {
            const c = counts.get(doc.docKey) ?? { known: 0, stored: 0 };
            return {
                docKey: doc.docKey,
                title: doc.title,
                source: doc.source,
                provenance: doc.provenance,
                originId: doc.originId,
                chunks: c.known,
                storedHere: c.stored,
                bytes: doc.bytes,
                createdAt: doc.createdAt,
            };
        });
    }

    stats(): CatalogStats {
        let metaBytes = 0;
        for (const m of this.metaById.values()) metaBytes += metaBytesOf(m);
        let bodyBytes = 0;
        for (const b of this.bodies.values()) bodyBytes += b.text.length;
        return {
            documents: this.docsByKey.size,
            known: this.metaById.size,
            stored: this.bodies.size,
            metaBytes,
            bodyBytes,
        };
    }

    searchLocal(queryVec: Float32Array, queryText: string, k: number): LocalHit[] {
        const lexical = queryText ? this.lexical().score(queryText) : new Map<number, number>();
        const normalized = BM25Index.normalize(lexical);
        const out: { hit: LocalHit; rank: number }[] = [];
        for (const meta of this.metaById.values()) {
            let cosine = 0;
            const vec = this.vectorOf(meta);
            for (let i = 0; i < EMBED_DIM; i++) cosine += queryVec[i] * vec[i];
            const coverage = termCoverage(
                queryText,
                `${meta.title} ${meta.section} ${this.bodies.get(meta.docId)?.text ?? meta.snippet}`,
            );
            const relevance = relevanceOf(cosine, coverage);
            if (relevance < MIN_RELEVANCE) continue;
            out.push({
                hit: {
                    docId: meta.docId,
                    score: relevance,
                    meta,
                    hasBody: this.bodies.has(meta.docId),
                },
                rank: relevance + BM25_TIEBREAK * (normalized.get(meta.docId) ?? 0),
            });
        }
        return out
            .sort((a, b) => b.rank - a.rank)
            .slice(0, k)
            .map((s) => s.hit);
    }

    private vectorOf(meta: MetaRow): Float32Array {
        const out = new Float32Array(meta.q.length);
        let norm = 0;
        for (let i = 0; i < meta.q.length; i++) {
            out[i] = meta.q[i] * meta.scale;
            norm += out[i] * out[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
        return out;
    }

    private lexicalDirty = true;

    private reindex(): void {
        this.lexicalDirty = true;
    }

    /** Mirrors `LocalCatalog.lexical`: rebuilt on demand, not on every write. */
    private lexical(): BM25Index {
        if (!this.lexicalDirty) return this.bm25;
        this.lexicalDirty = false;
        this.bm25 = new BM25Index(
            this.metas().map((m) => ({
                docId: m.docId,
                text: this.bodies.get(m.docId)?.text ?? `${m.title} ${m.section} ${m.snippet}`,
            })),
        );
        return this.bm25;
    }

    /* ------------------------------- writes ----------------------------- */

    async upload(filename: string, raw: string, originId: number, onProgress?: (d: number, t: number) => void) {
        const text = normalizeUploadedText(raw);
        if (!text) throw new Error(`${filename} has no readable text`);
        const parsed = parseDocument(filename, text);
        if (!parsed.chunks.length) throw new Error(`${filename} has no readable text`);
        return this.ingestParsed(parsed, originId, 'local', undefined, onProgress);
    }

    async ingestParsed(
        parsed: ParsedDoc,
        originId: number,
        provenance: Provenance,
        bodyFilter?: (docId: number) => boolean,
        onProgress?: (done: number, total: number) => void,
    ) {
        const body = parsed.chunks.map((c) => c.text).join('\n');
        const docKey = docKeyOf(parsed.title, body);
        const now = Date.now();
        const metas: MetaRow[] = [];

        parsed.chunks.forEach((chunk, seq) => {
            const docId = docIdOf(docKey, seq, chunk.text);
            const { q, scale } = quantize(
                embedder.embed(`${parsed.title} - ${chunk.section}. ${chunk.text}`),
            );
            const meta: MetaRow = {
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
            };
            metas.push(meta);
            this.metaById.set(docId, meta);
            if (!bodyFilter || bodyFilter(docId)) {
                this.bodies.set(docId, { docId, text: chunk.text, storedAt: now, touchedAt: now });
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
            docHash: hashDocument(parsed.title, parsed.chunks.map((c) => c.text)),
            authorship: 'unsigned',
        };
        this.docsByKey.set(docKey, doc);
        this.reindex();
        return { doc, metas };
    }

    async ingestMeta(incoming: MetaRow[], doc?: DocRow): Promise<number> {
        let added = 0;
        for (const m of incoming) {
            const existing = this.metaById.get(m.docId);
            if (existing && m.version <= existing.version) continue;
            this.metaById.set(m.docId, m);
            added++;
        }
        if (doc && !this.docsByKey.has(doc.docKey)) this.docsByKey.set(doc.docKey, doc);
        if (added) this.reindex();
        return added;
    }

    async getBody(docId: number) {
        const row = this.bodies.get(docId);
        if (row) row.touchedAt = Date.now();
        return row?.text;
    }

    async putBody(docId: number, text: string) {
        if (!this.metaById.has(docId)) return;
        const now = Date.now();
        this.bodies.set(docId, { docId, text, storedAt: now, touchedAt: now });
        this.reindex();
    }

    async evictBody(docId: number) {
        this.bodies.delete(docId);
        this.reindex();
    }

    async bodyRows(docIds: number[]) {
        const out = new Map<number, BodyRow>();
        for (const id of docIds) {
            const row = this.bodies.get(id);
            if (row) out.set(id, row);
        }
        return out;
    }

    async evictMeta(docIds: number[]): Promise<number> {
        let dropped = 0;
        for (const id of docIds) {
            if (!this.metaById.delete(id)) continue;
            this.bodies.delete(id);
            dropped++;
        }
        if (dropped) this.reindex();
        return dropped;
    }

    async forget(docKey: number) {
        this.docsByKey.delete(docKey);
        for (const [id, meta] of [...this.metaById]) {
            if (meta.docKey !== docKey) continue;
            this.metaById.delete(id);
            this.bodies.delete(id);
        }
        this.reindex();
    }

    async reload() {
        this.reindex();
    }

    /* ---------------------------- accounting ---------------------------- */

    async usage() {
        const { metaBytes, bodyBytes } = this.stats();
        return {
            metaBytes,
            bodyBytes,
            budgetBytes: this.budgetBytes,
            freeBytes: Math.max(0, this.budgetBytes - metaBytes - bodyBytes),
        };
    }

    async setBudget(bytes: number) {
        this.budgetBytes = Math.max(1024, Math.floor(bytes));
    }

    /* ------------------------------ holders ----------------------------- */

    async holderRows() {
        return [...this.holders.values()];
    }
    async putHolders(rows: HolderRow[]) {
        for (const r of rows) this.holders.set(`${r.docId}:${r.nodeId}`, r);
    }
    async deleteHolder(docId: number, nodeId: number) {
        this.holders.delete(`${docId}:${nodeId}`);
    }
    async deleteHoldersOf(nodeId: number, docIds: number[]) {
        for (const docId of docIds) this.holders.delete(`${docId}:${nodeId}`);
    }

    /* ----------------------------- popularity --------------------------- */

    async popRows() {
        return [...this.pop.values()];
    }
    async popOf(nodeId: number) {
        return [...this.pop.values()].filter((r) => r.nodeId === nodeId);
    }
    async bumpPop(docIds: number[], selfId: number) {
        for (const docId of docIds) {
            const key = `${docId}:${selfId}`;
            const row = this.pop.get(key);
            this.pop.set(key, {
                docId,
                nodeId: selfId,
                hits: (row?.hits ?? 0) + 1,
                updatedAt: Date.now(),
            });
        }
    }
    async mergePop(docId: number, nodeId: number, hits: number) {
        const key = `${docId}:${nodeId}`;
        const row = this.pop.get(key);
        this.pop.set(key, {
            docId,
            nodeId,
            hits: Math.max(row?.hits ?? 0, hits),
            updatedAt: Date.now(),
        });
    }

    /* -------------------------------- peers ----------------------------- */

    async peerStats() {
        return [...this.stats_.values()];
    }
    async peerStat(nodeId: number) {
        return this.stats_.get(nodeId) ?? null;
    }
    async putPeerStats(rows: PeerStatRow[]) {
        for (const r of rows) this.stats_.set(r.nodeId, r);
    }
    async peerIdentities() {
        return [...this.ids.values()];
    }
    async putPeerIdentity(row: PeerIdentityRow) {
        this.ids.set(row.nodeId, row);
    }

    /* --------------------------- kv and outbox -------------------------- */

    async kvGet(key: string) {
        return this.kv.get(key) ?? null;
    }
    async kvSet(key: string, value: string) {
        this.kv.set(key, value);
    }
    async enqueue(dstId: number, payload: string, ttlMs: number) {
        this.outbox.push({
            id: this.nextOutboxId++,
            dstId,
            payload,
            expiresAt: Date.now() + ttlMs,
        });
    }
    async dueFor(dstId?: number) {
        return this.outbox.filter((r) => dstId === undefined || r.dstId === dstId);
    }
    async dequeue(id: number) {
        this.outbox = this.outbox.filter((r) => r.id !== id);
    }
    async queuedCount() {
        return this.outbox.length;
    }
}
