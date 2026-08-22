import type { ParsedDoc } from '@core/lib/chunk';

import type {
    BodyRow,
    CatalogStats,
    DocRow,
    DocSummary,
    HolderRow,
    LocalHit,
    MetaRow,
    PeerIdentityRow,
    PeerStatRow,
    PopRow,
    Provenance,
} from './types';

/**
 * What the mesh needs from storage.
 *
 * Structurally this is `LocalCatalog`, written out as an interface so that
 * nothing above it has to depend on the concrete class. Depending on
 * `LocalCatalog` directly would drag expo-sqlite into every place a node is
 * constructed — including the tests, which run in Node — and the behaviour
 * worth testing (who answers, which way replies travel, what replication
 * decides) has nothing to do with which database is underneath.
 */
export interface MeshCatalog {
    /* index */
    readonly knownCount: number;
    readonly storedCount: number;
    readonly budget: number;
    metas(): MetaRow[];
    getMeta(docId: number): MetaRow | undefined;
    holdsBody(docId: number): boolean;
    bodyOf(docId: number): string | undefined;
    snippet(docId: number): string;
    docRow(docKey: number): DocRow | undefined;
    docRows(): DocRow[];
    documents(): DocSummary[];
    stats(): CatalogStats;
    searchLocal(queryVec: Float32Array, queryText: string, k: number): LocalHit[];

    /* writes */
    upload(
        filename: string,
        raw: string,
        originId: number,
        onProgress?: (done: number, total: number) => void,
    ): Promise<{ doc: DocRow; metas: MetaRow[] }>;
    ingestParsed(
        parsed: ParsedDoc,
        originId: number,
        provenance: Provenance,
        bodyFilter?: (docId: number) => boolean,
        onProgress?: (done: number, total: number) => void,
    ): Promise<{ doc: DocRow; metas: MetaRow[] }>;
    ingestMeta(metas: MetaRow[], doc?: DocRow): Promise<number>;
    getBody(docId: number): Promise<string | undefined>;
    putBody(docId: number, text: string): Promise<void>;
    evictBody(docId: number): Promise<void>;
    evictMeta(docIds: number[]): Promise<number>;
    bodyRows(docIds: number[]): Promise<Map<number, BodyRow>>;
    forget(docKey: number): Promise<void>;
    reload(): Promise<void>;

    /* accounting */
    usage(): Promise<{
        metaBytes: number;
        bodyBytes: number;
        budgetBytes: number;
        freeBytes: number;
    }>;
    setBudget(bytes: number): Promise<void>;

    /* holders */
    holderRows(): Promise<HolderRow[]>;
    putHolders(rows: HolderRow[]): Promise<void>;
    deleteHolder(docId: number, nodeId: number): Promise<void>;
    deleteHoldersOf(nodeId: number, docIds: number[]): Promise<void>;

    /* popularity */
    popRows(): Promise<PopRow[]>;
    popOf(nodeId: number): Promise<PopRow[]>;
    bumpPop(docIds: number[], selfId: number): Promise<void>;
    mergePop(docId: number, nodeId: number, hits: number): Promise<void>;

    /* peers */
    peerStats(): Promise<PeerStatRow[]>;
    peerStat(nodeId: number): Promise<PeerStatRow | null>;
    putPeerStats(rows: PeerStatRow[]): Promise<void>;
    peerIdentities(): Promise<PeerIdentityRow[]>;
    putPeerIdentity(row: PeerIdentityRow): Promise<void>;

    /* key/value and store-and-forward */
    kvGet(key: string): Promise<string | null>;
    kvSet(key: string, value: string): Promise<void>;
    enqueue(dstId: number, payload: string, ttlMs: number): Promise<void>;
    dueFor(dstId?: number): Promise<{ id: number; dstId: number; payload: string }[]>;
    dequeue(id: number): Promise<void>;
    queuedCount(): Promise<number>;
}
