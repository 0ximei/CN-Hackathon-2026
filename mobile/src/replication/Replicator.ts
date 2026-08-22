import { contentMatches, verifyAuthorship, type Authorship } from '../identity/authorship';
/**
 * The replication control loop, on a phone.
 *
 * The decisions are not made here. They live in `@core/replication/policy` as
 * pure functions with no I/O and no clock, and they are the *same functions the
 * browser build runs* — weighted rendezvous hashing for placement, the
 * popularity/reliability/capacity target, the eviction order, and the invariant
 * that outranks all of them: never drop the last live copy of a body. Importing
 * them rather than reimplementing them is what keeps a phone and a browser from
 * quietly converging on different replica sets for the same document.
 *
 * What is here is the part that touches the radio, the clock and SQLite:
 * gathering the inputs, rate-limiting the actions, and gossiping the results.
 *
 * The constants differ from the web build's, and only the constants. BLE moves
 * a few kilobytes a second, so a pass that pulls three bodies on a LAN pulls
 * two here and waits longer between passes. A control loop that reacts to every
 * change instantly spends a slow radio's entire budget reacting.
 */

import type { AnnouncePayload, HolderEntry, HoldersPayload, MetaEntry } from '@core/protocol/packet';
import {
    META_REPLICAS,
    evictionOrder,
    mix32,
    planFor,
    reliabilityOf,
    shouldKeepMeta,
    targetReplicas,
    type NodeInfo,
} from '@core/replication/policy';

import type { MeshCatalog } from '../storage/MeshCatalog';
import type { DocRow, MetaRow, PeerStatRow, Provenance } from '../storage/types';

/**
 * How often to reconcile.
 *
 * Cheap: this pass reads local state and decides what to pull or evict. Nothing
 * here touches the radio except the pulls, which are separately bounded.
 */
const RECONCILE_MS = 8_000;
/** Bodies pulled per pass, so a node joining an established mesh trickles in. */
const MAX_PULLS_PER_PASS = 2;
/** Chunks per ANNOUNCE packet. Each entry is ~660 bytes — two BLE frames. */
/**
 * Passages per ANNOUNCE, chosen against the radio rather than the packet.
 *
 * The transport reports a 4 KB MTU, which is true of the interface and not of
 * the link: underneath, every packet is cut into 514-byte GATT segments that
 * must all arrive, in order, or the reassembler resets and the whole message is
 * gone. There is no retransmission anywhere — a link that drops mid-message
 * clears its queue and nothing above the radio is told.
 *
 * So the number that matters is segments per packet, and at four entries the
 * worst case measured against the built-in corpus is 2731 B: six segments that
 * all have to survive. Two entries is 1433 B, three segments. Metadata gossip
 * is not latency-sensitive — one more packet costs nothing that matters, and
 * halving the window in which a flap can destroy the whole thing costs nothing
 * at all. `wiresize.test.ts` holds the budget.
 */
const ENTRIES_PER_ANNOUNCE = 2;

/**
 * Chunks per HOLDERS packet.
 *
 * The reason this exists at all is a mistake worth recording. Refreshing holder
 * claims by re-sending the ANNOUNCE that carried them means re-sending a
 * 384-byte embedding and a 200-byte snippet — about 660 bytes per chunk — to
 * carry roughly twenty bytes of news that actually changed. On the browser
 * build that is invisible. Measured on the bundled corpus (6 documents, 34
 * chunks, 23 KB to announce in full) driving that off the reconcile timer came
 * to about 1 KB/s *flooded to every link*, and twice that through a node in the
 * middle of a line. A BLE link with a 517-byte MTU does a few kB/s in total, so
 * beacons ended up queued behind metadata — and a HELLO that misses
 * PEER_TIMEOUT_MS makes a live peer look dead, which is how a mesh with working
 * links reports zero peers.
 *
 * A HOLDERS entry is about 21 bytes, so the whole corpus fits in roughly 700
 * bytes instead of 23 KB. That is what lets the refresh stay on the fast timer
 * where replication needs it.
 */
const HOLDERS_PER_PACKET = 24;

/**
 * How often to re-announce one document in full.
 *
 * Anti-entropy backstop only, now that holder claims travel separately: a peer
 * that was present but missed the original ANNOUNCE flood has no other way to
 * learn the metadata, since CATALOG_REQ only fires on first contact. One
 * document a minute is about 65 B/s on this corpus.
 */
const REANNOUNCE_MS = 60_000;
/** Documents per re-announce tick. One, deliberately: the point is a trickle. */
const REANNOUNCE_PER_TICK = 1;
/** Fraction of the holder-refresh cycle a claim must outlive. */
const REANNOUNCE_SAFETY = 0.5;
/** Counter window before halving, so reliability can recover. */
const STAT_WINDOW = 200;
/** A holder record older than this is not evidence anybody still has it. */
const HOLDER_TTL_MS = 90_000;
/**
 * Headroom multiple required before pulling a body.
 *
 * Hysteresis, not caution. Pulling right up to the budget means the next pass
 * finds the node over budget and evicts what it just pulled — a node on a tight
 * budget thrashes forever and burns a radio that has nothing to spare.
 */
const PULL_HEADROOM = 3;

export interface DocReplicaInfo {
    docKey: number;
    title: string;
    source: string;
    provenance: Provenance;
    chunkCount: number;
    bytes: number;
    originId: number;
    /** Mean live body replicas across this document's chunks. */
    meanReplicas: number;
    /** Chunks of this document whose body is stored here. */
    storedHere: number;
    desired: number;
    hits: number;
    /** The verdict reached when this document arrived. See `identity/authorship.ts`. */
    authorship: Authorship;
    /** SHA-256 of the content, as signed. Absent for the built-in corpus. */
    docHash?: Uint8Array;
    /** The signature itself, so the UI can show the thing it is asserting. */
    sig?: Uint8Array;
    /**
     * Whether the bytes held here hash to what was signed.
     *
     * `null` when it cannot be checked — the content hash covers the whole
     * document and this node holds only part of it, which is the normal state
     * of the metadata tier rather than a problem.
     */
    contentIntact: boolean | null;
}

export interface ReplicationStats {
    known: number;
    stored: number;
    /** Chunks whose live replica count is below target. */
    underReplicated: number;
    /** Chunks with exactly one live copy — the ones at risk. */
    atRisk: number;
    metaBytes: number;
    bodyBytes: number;
    budgetBytes: number;
    freeBytes: number;
    underPressure: boolean;
    lastPass: number;
    pulls: number;
    evictions: number;
}

export interface PeerReliability {
    nodeId: number;
    reliability: number;
    freeBytes: number;
}

export interface ReplicatorDeps {
    selfId: number;
    catalog: MeshCatalog;
    /** Live peers, from the mesh node's beacon table. */
    livePeers: () => { nodeId: number; freeBytes: number }[];
    announce: (payload: AnnouncePayload, dstId?: number) => void;
    /** Sends a compact holder/popularity refresh. Always a flood. */
    announceHolders: (payload: HoldersPayload) => void;
    /** Pulls one body from a specific peer. Resolves null on timeout. */
    fetchBody: (docId: number, fromNodeId: number) => Promise<string | null>;
    onStats?: (s: ReplicationStats) => void;
    /** Surfaced in the activity log, so replication is visible rather than magic. */
    onEvent?: (e: { kind: 'pull' | 'evict'; docId: number; title: string; detail: string }) => void;
}

const EMPTY_STATS: ReplicationStats = {
    known: 0,
    stored: 0,
    underReplicated: 0,
    atRisk: 0,
    metaBytes: 0,
    bodyBytes: 0,
    budgetBytes: 0,
    freeBytes: 0,
    underPressure: false,
    lastPass: 0,
    pulls: 0,
    evictions: 0,
};

export class Replicator {
    private timer: ReturnType<typeof setInterval> | null = null;
    private announceTimer: ReturnType<typeof setInterval> | null = null;
    private stats: ReplicationStats = { ...EMPTY_STATS };
    private reliabilityCache = new Map<number, number>();
    /**
     * Offset so nodes do not walk the library in lockstep. Every node sees the
     * same documents in the same order, so a shared starting point would have
     * them all refreshing the same document in the same pass and nothing else.
     */
    private reannounceCursor: number;
    private running = false;

    constructor(private deps: ReplicatorDeps) {
        this.reannounceCursor = mix32(deps.selfId >>> 0, 0x5eed) % 1024;
    }

    start(): void {
        if (this.timer !== null) return;
        this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
        this.announceTimer = setInterval(() => void this.reannounceSlice(), REANNOUNCE_MS);
        // One immediate pass so a fresh node does not wait a full interval
        // before discovering what it should be holding. Deliberately *not*
        // accompanied by an immediate announcement: a node that has just come
        // up has no links yet, and the first thing a new link should carry is a
        // beacon, not a kilobyte of metadata the peer probably already has.
        void this.reconcile();
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        if (this.announceTimer !== null) clearInterval(this.announceTimer);
        this.timer = null;
        this.announceTimer = null;
    }

    getStats(): ReplicationStats {
        return { ...this.stats };
    }

    /* ---------------------- peer observation ----------------------- */

    /**
     * Nodes that could hold a chunk right now: live peers plus ourselves.
     *
     * Membership is taken from the beacon table each time rather than
     * accumulated — a node that has gone dark is not a placement target however
     * reliable it used to be.
     */
    private candidateNodes(selfFreeBytes: number): NodeInfo[] {
        const peers = this.deps.livePeers().map((p) => ({
            nodeId: p.nodeId,
            reliability: this.reliabilityCache.get(p.nodeId) ?? 0.5,
            freeBytes: p.freeBytes,
        }));
        return [
            {
                nodeId: this.deps.selfId,
                reliability: this.selfReliability(peers),
                freeBytes: selfFreeBytes,
            },
            ...peers,
        ];
    }

    /**
     * What weight to give ourselves when ranking placement.
     *
     * Emphatically not 1. Reliability is observed, and a node cannot observe its
     * own downtime — it is by definition running whenever it looks. Scoring self
     * at a perfect 1 while every peer carries a measured value below it makes
     * each node rank itself top for most chunks, so all of them conclude they
     * should hold and the replica target is quietly exceeded. Taking the mean of
     * the peers says "assume we are a typical node on this mesh", which removes
     * the self-preference without inventing a measurement.
     */
    private selfReliability(peers: NodeInfo[]): number {
        if (!peers.length) return 1;
        return peers.reduce((s, p) => s + p.reliability, 0) / peers.length;
    }

    /**
     * Records that a peer's beacon arrived.
     *
     * `helloExpected` is advanced by `tickExpectations` on the reconcile timer
     * rather than here, so a peer that goes quiet accrues misses while a peer
     * beaconing normally stays level.
     */
    async noteHello(nodeId: number, freeBytes: number): Promise<void> {
        const now = Date.now();
        const row = (await this.deps.catalog.peerStat(nodeId)) ?? blankStat(nodeId, now);
        row.lastSeen = now;
        row.helloSeen += 1;
        row.freeBytes = freeBytes;
        if (row.helloSeen > row.helloExpected) row.helloExpected = row.helloSeen;
        await this.deps.catalog.putPeerStats([decay(row)]);
    }

    async noteRequest(nodeId: number): Promise<void> {
        const now = Date.now();
        const row = (await this.deps.catalog.peerStat(nodeId)) ?? blankStat(nodeId, now);
        row.requests += 1;
        await this.deps.catalog.putPeerStats([decay(row)]);
    }

    async noteResponse(nodeId: number): Promise<void> {
        const now = Date.now();
        const row = (await this.deps.catalog.peerStat(nodeId)) ?? blankStat(nodeId, now);
        row.responses += 1;
        row.lastSeen = now;
        await this.deps.catalog.putPeerStats([decay(row)]);
    }

    private async tickExpectations(livePeerIds: number[]): Promise<void> {
        const live = new Set(livePeerIds);
        const rows = await this.deps.catalog.peerStats();
        const updates = rows
            .filter((r) => live.has(r.nodeId))
            .map((r) => decay({ ...r, helloExpected: r.helloExpected + 1 }));
        await this.deps.catalog.putPeerStats(updates);
    }

    /** Reliability per peer, measured here and never self-reported. */
    async peerReliability(): Promise<PeerReliability[]> {
        const rows = await this.deps.catalog.peerStats();
        return rows.map((r) => ({
            nodeId: r.nodeId,
            reliability: reliabilityOf(r),
            freeBytes: r.freeBytes,
        }));
    }

    /* --------------------------- popularity ------------------------ */

    /** Counts an access. Only ever this node's own share of the G-counter. */
    async recordHit(docIds: number[]): Promise<void> {
        await this.deps.catalog.bumpPop(docIds, this.deps.selfId);
    }

    private async popularityMap(): Promise<Map<number, number>> {
        const rows = await this.deps.catalog.popRows();
        const out = new Map<number, number>();
        for (const r of rows) out.set(r.docId, (out.get(r.docId) ?? 0) + r.hits);
        return out;
    }

    /* ----------------------------- holders ------------------------- */

    /**
     * How long a holder claim stays believable.
     *
     * Derived from the refresh cycle rather than fixed, because the two must not
     * cross: once a library is large enough that the cycle exceeds the TTL,
     * every node's claims expire before they are refreshed, every node concludes
     * it holds the only copy, and nothing is ever evicted — bodies replicate
     * without bound no matter what MAX_BODY_REPLICAS says.
     *
     * With the trickle above, a bigger library buys itself a longer TTL rather
     * than a faster radio, which is the trade a slow link forces.
     */
    private holderTtlMs(chunkCount: number): number {
        const cycleMs = Math.ceil(chunkCount / HOLDERS_PER_PACKET) * RECONCILE_MS;
        return Math.max(HOLDER_TTL_MS, cycleMs / REANNOUNCE_SAFETY);
    }

    /**
     * Who holds what, as best this node can tell.
     *
     * Remote claims expire, because a peer that stopped announcing is not
     * evidence of anything. Our own holdings never do: the body store is ground
     * truth, not a claim.
     */
    private async holderMap(): Promise<Map<number, Set<number>>> {
        const catalog = this.deps.catalog;
        const cutoff = Date.now() - this.holderTtlMs(catalog.knownCount);
        const rows = await catalog.holderRows();
        const out = new Map<number, Set<number>>();
        const add = (docId: number, nodeId: number) => {
            let set = out.get(docId);
            if (!set) out.set(docId, (set = new Set()));
            set.add(nodeId);
        };

        for (const r of rows) {
            if (r.seenAt < cutoff && r.nodeId !== this.deps.selfId) continue;
            add(r.docId, r.nodeId);
        }
        for (const meta of catalog.metas()) {
            if (catalog.holdsBody(meta.docId)) add(meta.docId, this.deps.selfId);
        }
        return out;
    }

    /**
     * Re-stamps our own holder rows so peers keep hearing a live claim, and
     * deletes the ones that are no longer true.
     *
     * A self-claim we cannot honour is worse than a missing one: search picks us
     * as the holder and then has nobody to ask, and replication counts a copy
     * that is not there. Such a claim can come back to us through a peer that
     * has not heard about the eviction yet, so it has to be pruned, not merely
     * not-written.
     */
    private async refreshOwnHolders(): Promise<void> {
        const now = Date.now();
        const selfId = this.deps.selfId;
        const catalog = this.deps.catalog;
        const held = new Set(
            catalog.metas().filter((m) => catalog.holdsBody(m.docId)).map((m) => m.docId),
        );

        await catalog.putHolders([...held].map((docId) => ({ docId, nodeId: selfId, seenAt: now })));

        const stale = (await catalog.holderRows())
            .filter((r) => r.nodeId === selfId && !held.has(r.docId))
            .map((r) => r.docId);
        await catalog.deleteHoldersOf(selfId, stale);
    }

    async noteHolder(docId: number, nodeId: number): Promise<void> {
        await this.deps.catalog.putHolders([{ docId, nodeId, seenAt: Date.now() }]);
    }

    /* ------------------------------ gossip ------------------------- */

    /** Applies metadata, holder claims and popularity shares learned from a peer. */
    async onAnnounce(payload: AnnouncePayload, fromNodeId: number): Promise<number> {
        const catalog = this.deps.catalog;
        const now = Date.now();
        const metas: MetaRow[] = payload.entries.map((e) => ({
            docId: e.docId,
            docKey: payload.docKey,
            seq: e.seq,
            title: payload.title,
            section: e.section,
            snippet: e.snippet,
            q: e.vec,
            scale: e.scale,
            bytes: e.bytes,
            originId: e.originId,
            version: e.version,
            updatedAt: now,
        }));

        // The metadata tier is bounded too. Without this check META_REPLICAS is
        // decoration: ANNOUNCE is flooded, so every node that hears one keeps a
        // copy and metadata replicates to the entire mesh however low the
        // constant is set. Ranking happens before ingest so a node that is not a
        // carrier never writes the row at all.
        const candidates = this.candidateNodes(1);
        const keep = metas.filter(
            (m) =>
                shouldKeepMeta(m.docId, this.deps.selfId, candidates) ||
                // Never drop the description of a body we hold: an
                // undescribable body is unfindable and unservable. Never drop
                // our own upload either.
                catalog.holdsBody(m.docId) ||
                m.originId === this.deps.selfId,
        );
        if (!keep.length) return 0;
        const kept = new Set(keep.map((m) => m.docId));

        // Judged here, once, on arrival, and stored with the row. Verifying on
        // read instead would mean every render of the Files tab running
        // Ed25519 over every document, and would leave the verdict dependent on
        // code that could be changed after the fact — the point of recording it
        // is that it is a statement about what actually came off the radio.
        const authorship = verifyAuthorship(
            {
                docKey: payload.docKey,
                docHash: payload.docHash ?? new Uint8Array(0),
                title: payload.title,
                source: payload.source,
                chunkCount: payload.chunkCount,
                bytes: payload.docBytes,
                createdAtSec: payload.createdAtSec,
                authorId: payload.docOriginId,
            },
            payload.sig,
            payload.authorKey,
        );

        const added = await catalog.ingestMeta(keep, {
            docKey: payload.docKey,
            title: payload.title,
            source: payload.source,
            bytes: payload.docBytes,
            chunkCount: payload.chunkCount,
            originId: payload.docOriginId,
            createdAt: payload.createdAtSec * 1000,
            provenance: payload.docOriginId === this.deps.selfId ? 'local' : 'mesh',
            docHash: payload.docHash,
            authorKey: authorship === 'verified' ? payload.authorKey : undefined,
            sig: authorship === 'verified' ? payload.sig : undefined,
            authorship,
        });

        // Holder claims and popularity shares are recorded whether or not the
        // metadata was new — a re-announcement exists precisely to refresh them.
        const holders: { docId: number; nodeId: number; seenAt: number }[] = [];
        for (const e of payload.entries) {
            if (!kept.has(e.docId)) continue;
            for (const holder of e.holders) {
                // Never let a peer tell us what we hold. We are the only
                // authority on our own storage, and a stale claim written back
                // about ourselves is self-refreshing: it never ages out, search
                // resolves the holder to this node, and the body is then
                // unreachable from here.
                if (holder === this.deps.selfId) continue;
                holders.push({ docId: e.docId, nodeId: holder, seenAt: now });
            }
            if (e.hits > 0) await catalog.mergePop(e.docId, fromNodeId, e.hits);
        }
        await catalog.putHolders(holders);

        return added;
    }

    /**
     * Applies a compact holder/popularity refresh from a peer.
     *
     * Deliberately cannot create a chunk: an entry for a docId this node has no
     * metadata for is dropped, because a holder claim about a passage we cannot
     * describe is unusable — search could not score it and replication could not
     * budget for it. The metadata arrives on a real ANNOUNCE or not at all.
     */
    async onHolders(payload: HoldersPayload, fromNodeId: number): Promise<void> {
        const catalog = this.deps.catalog;
        const now = Date.now();
        const rows: { docId: number; nodeId: number; seenAt: number }[] = [];

        for (const entry of payload.entries) {
            if (!catalog.getMeta(entry.docId)) continue;
            for (const holder of entry.holders) {
                // Never let a peer tell us what we hold — see onAnnounce.
                if (holder === this.deps.selfId) continue;
                rows.push({ docId: entry.docId, nodeId: holder, seenAt: now });
            }
            if (entry.hits > 0) await catalog.mergePop(entry.docId, fromNodeId, entry.hits);
        }
        await catalog.putHolders(rows);
    }

    /**
     * Tells the mesh what this node holds, and how popular it has found things.
     *
     * One packet per slice of the catalog, flooded, on the reconcile timer. This
     * is the fast path that makes eviction work: a node cannot shed a body until
     * it can see that somebody else has one, and it learns that here.
     */
    private async refreshHolders(): Promise<void> {
        if (!this.deps.livePeers().length) return;
        const catalog = this.deps.catalog;
        const holders = await this.holderMap();
        const shares = new Map(
            (await catalog.popOf(this.deps.selfId)).map((r) => [r.docId, r.hits]),
        );

        // Grouped by document because the packet is keyed on one, which keeps a
        // receiver's lookup cheap and mirrors how ANNOUNCE is shaped.
        const byDoc = new Map<number, HolderEntry[]>();
        for (const meta of catalog.metas()) {
            const claims = holders.get(meta.docId);
            const hits = shares.get(meta.docId) ?? 0;
            // Nothing to say about a chunk nobody is known to hold and nobody
            // here has read.
            if (!claims?.size && !hits) continue;
            const list = byDoc.get(meta.docKey) ?? [];
            list.push({ docId: meta.docId, holders: [...(claims ?? [])], hits });
            byDoc.set(meta.docKey, list);
        }

        for (const [docKey, entries] of byDoc) {
            for (let i = 0; i < entries.length; i += HOLDERS_PER_PACKET) {
                this.deps.announceHolders({
                    docKey,
                    entries: entries.slice(i, i + HOLDERS_PER_PACKET),
                });
            }
        }
    }

    /** Builds ANNOUNCE packets for a document and hands them to the sender. */
    async announceDocument(docKey: number, dstId?: number): Promise<number> {
        const catalog = this.deps.catalog;
        const doc = catalog.docRow(docKey);
        if (!doc) return 0;
        const metas = catalog
            .metas()
            .filter((m) => m.docKey === docKey)
            .sort((a, b) => a.seq - b.seq);
        if (!metas.length) return 0;

        const holders = await this.holderMap();
        const selfShares = new Map(
            (await catalog.popOf(this.deps.selfId)).map((r) => [r.docId, r.hits]),
        );

        for (let i = 0; i < metas.length; i += ENTRIES_PER_ANNOUNCE) {
            const slice = metas.slice(i, i + ENTRIES_PER_ANNOUNCE);
            const entries: MetaEntry[] = slice.map((m) => ({
                docId: m.docId,
                seq: m.seq,
                version: m.version,
                section: m.section,
                snippet: m.snippet,
                bytes: m.bytes,
                originId: m.originId,
                scale: m.scale,
                vec: m.q,
                holders: [...(holders.get(m.docId) ?? [])],
                // Only ever gossip *our own* share of the counter. Forwarding
                // someone else's under our node id would double-count it.
                hits: selfShares.get(m.docId) ?? 0,
            }));

            this.deps.announce(
                {
                    docKey: doc.docKey,
                    title: doc.title,
                    source: doc.source,
                    docBytes: doc.bytes,
                    chunkCount: doc.chunkCount,
                    docOriginId: doc.originId,
                    docHash: doc.docHash,
                    // Relayed verbatim, never re-signed. This node cannot vouch
                    // for a document it did not write, and a re-signature would
                    // be exactly the claim the attestation exists to refuse.
                    authorKey: doc.authorKey,
                    sig: doc.sig,
                    createdAtSec: Math.floor(doc.createdAt / 1000),
                    entries,
                },
                dstId,
            );
        }
        return metas.length;
    }

    /**
     * Answers a joining node's anti-entropy request.
     *
     * Skips the built-in corpus, and the reason is bandwidth rather than
     * policy: the sample documents are bundled into the app, so both ends
     * seeded identical metadata for all of them on first launch and sending it
     * again would spend a slow radio's whole budget telling a peer things it
     * already knows. Which *bodies* each node holds is a separate question, and
     * it is answered by the reconcile loop's re-announcements, which do include
     * the seed corpus.
     *
     * `sinceSec` is accepted for wire compatibility and honoured, though a
     * requester currently always sends 0 — it only ever asks once per peer.
     */
    async serveCatalogRequest(sinceSec: number, dstId: number, max: number): Promise<void> {
        const since = sinceSec * 1000;
        let sent = 0;
        for (const doc of this.deps.catalog.docRows().sort((a, b) => a.createdAt - b.createdAt)) {
            if (sent >= max) break;
            if (doc.provenance === 'seed') continue;
            if (doc.createdAt < since) continue;
            sent += await this.announceDocument(doc.docKey, dstId);
        }
    }

    /* ------------------------------ the loop ----------------------- */

    /**
     * One reconciliation pass.
     *
     * Serial and re-entrant-guarded: two overlapping passes would both see the
     * same under-replication and both pull, which is how you get a thundering
     * herd against whichever node holds a popular chunk — on a radio that can
     * serve one request at a time.
     */
    async reconcile(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const catalog = this.deps.catalog;
            const selfId = this.deps.selfId;

            const usage = await catalog.usage();
            const underPressure = usage.freeBytes <= 0;

            // Assert what we hold before reading anyone's view of it.
            await this.refreshOwnHolders();

            const live = this.deps.livePeers();
            await this.tickExpectations(live.map((p) => p.nodeId));

            const reliabilities = await this.peerReliability();
            this.reliabilityCache = new Map(reliabilities.map((r) => [r.nodeId, r.reliability]));

            const candidates = this.candidateNodes(usage.freeBytes);
            const liveIds = new Set(candidates.map((c) => c.nodeId));

            const [holders, pop] = await Promise.all([this.holderMap(), this.popularityMap()]);
            const metas = catalog.metas();

            const pulls: { docId: number; from: number; meta: MetaRow }[] = [];
            const evicts: {
                docId: number;
                live: number;
                hits: number;
                touchedAt: number;
                bytes: number;
                meta: MetaRow;
            }[] = [];
            let underReplicated = 0;
            let atRisk = 0;

            for (const meta of metas) {
                const claimed = holders.get(meta.docId) ?? new Set<number>();
                const haveBody = catalog.holdsBody(meta.docId);
                // Only count holders we can actually see. A holder that is
                // offline is not availability, and treating it as such is how
                // data quietly reaches zero replicas while the UI calls it safe.
                const liveHolders = [...claimed].filter((id) => liveIds.has(id));
                if (haveBody && !liveHolders.includes(selfId)) liveHolders.push(selfId);

                const hits = pop.get(meta.docId) ?? 0;
                const plan = planFor({
                    docId: meta.docId,
                    selfId,
                    candidates,
                    liveHolders,
                    hits,
                    haveBody,
                    underPressure,
                });

                if (liveHolders.length < plan.desired) underReplicated++;
                if (liveHolders.length <= 1) atRisk++;

                if (plan.action === 'pull') {
                    const source = liveHolders.find((id) => id !== selfId);
                    if (source !== undefined) pulls.push({ docId: meta.docId, from: source, meta });
                } else if (plan.action === 'evict') {
                    evicts.push({
                        docId: meta.docId,
                        live: liveHolders.length,
                        hits,
                        touchedAt: 0,
                        bytes: meta.bytes,
                        meta,
                    });
                }
            }

            // Pull the most at-risk chunks first: fewest live copies, then most
            // wanted. Without the ordering a pass spends its budget on whatever
            // happened to be early in the catalog.
            pulls.sort((a, b) => {
                const byCopies =
                    (holders.get(a.docId)?.size ?? 0) - (holders.get(b.docId)?.size ?? 0);
                return byCopies || (pop.get(b.docId) ?? 0) - (pop.get(a.docId) ?? 0);
            });

            let pulled = 0;
            let budgetLeft = usage.freeBytes;
            for (const p of pulls.slice(0, MAX_PULLS_PER_PASS)) {
                if (budgetLeft < p.meta.bytes * PULL_HEADROOM) break;
                const text = await this.deps.fetchBody(p.docId, p.from);
                if (text === null) {
                    // The holder did not answer. Its reliability already took
                    // the hit via noteRequest/noteResponse; drop the stale claim
                    // so the next pass looks elsewhere rather than retrying the
                    // same dead peer.
                    await catalog.deleteHolder(p.docId, p.from);
                    continue;
                }
                await catalog.putBody(p.docId, text);
                await this.noteHolder(p.docId, selfId);
                budgetLeft -= text.length;
                pulled++;
                this.deps.onEvent?.({
                    kind: 'pull',
                    docId: p.docId,
                    title: p.meta.title,
                    detail: `${p.meta.section || 'passage'} — replicated here`,
                });
            }

            let evicted = 0;
            if (evicts.length) {
                const bodies = await catalog.bodyRows(evicts.map((e) => e.docId));
                for (const e of evicts) e.touchedAt = bodies.get(e.docId)?.touchedAt ?? 0;
                for (const e of evictionOrder(evicts)) {
                    await catalog.evictBody(e.docId);
                    await catalog.deleteHolder(e.docId, selfId);
                    evicted++;
                    this.deps.onEvent?.({
                        kind: 'evict',
                        docId: e.docId,
                        title: e.meta.title,
                        detail: `${e.live} copies elsewhere — freed ${e.bytes} B`,
                    });
                    // Under pressure keep going until back inside budget;
                    // otherwise one eviction per pass converges without
                    // thrashing.
                    if (!underPressure) break;
                }
            }

            // Shed metadata for chunks this node is no longer a carrier for. On
            // a mesh no larger than META_REPLICAS this never fires — every node
            // ranks inside the target — so the two- and three-phone demo is
            // untouched and the bound only bites once there are more nodes than
            // copies wanted.
            const metaEvictions: number[] = [];
            for (const meta of catalog.metas()) {
                if (catalog.holdsBody(meta.docId) || meta.originId === selfId) continue;
                if (!shouldKeepMeta(meta.docId, selfId, candidates)) metaEvictions.push(meta.docId);
            }
            if (metaEvictions.length) {
                const first = catalog.getMeta(metaEvictions[0]);
                const dropped = await catalog.evictMeta(metaEvictions);
                if (dropped && first) {
                    this.deps.onEvent?.({
                        kind: 'evict',
                        docId: first.docId,
                        title: first.title,
                        detail: `${dropped} metadata dropped — carried elsewhere`,
                    });
                }
            }

            // Publish what this node holds *after* acting on this pass, so a
            // body pulled or shed a moment ago is claimed or disclaimed in the
            // same breath rather than a cycle later.
            await this.refreshHolders();

            const after = await catalog.usage();
            this.stats = {
                known: catalog.knownCount,
                stored: catalog.storedCount,
                underReplicated,
                atRisk,
                metaBytes: after.metaBytes,
                bodyBytes: after.bodyBytes,
                budgetBytes: after.budgetBytes,
                freeBytes: after.freeBytes,
                underPressure,
                lastPass: Date.now(),
                pulls: this.stats.pulls + pulled,
                evictions: this.stats.evictions + evicted,
            };
            this.deps.onStats?.(this.getStats());
        } finally {
            this.running = false;
        }
    }

    /**
     * Refreshes holder claims for one document, on its own slow schedule.
     *
     * Skipped entirely while nothing is listening: a flood with no links costs
     * nothing but does advance the cursor, so a node that spent ten minutes
     * alone would come back having "refreshed" everything to an empty room.
     */
    private async reannounceSlice(): Promise<void> {
        const docs = this.deps.catalog.docRows();
        if (!docs.length || !this.deps.livePeers().length) return;
        for (let i = 0; i < REANNOUNCE_PER_TICK; i++) {
            const doc = docs[this.reannounceCursor % docs.length];
            this.reannounceCursor++;
            await this.announceDocument(doc.docKey);
        }
    }

    /* ---------------------------- reporting ------------------------ */

    /**
     * Whether the text held here is the text that was signed.
     *
     * Only answerable with the whole document: the hash covers every chunk in
     * order, so a node holding four passages out of six cannot recompute it and
     * says so, rather than reporting a failure it did not observe. That is the
     * honest limit of a two-tier design — authorship is provable from a single
     * packet, content is provable only once you hold the content.
     */
    private contentIntact(doc: DocRow, metas: MetaRow[]): boolean | null {
        if (!doc.docHash?.length) return null;
        const ordered = [...metas].sort((a, b) => a.seq - b.seq);
        if (ordered.length !== doc.chunkCount) return null;
        const texts: string[] = [];
        for (const m of ordered) {
            const body = this.deps.catalog.bodyOf(m.docId);
            if (body === undefined) return null;
            texts.push(body);
        }
        return contentMatches(doc.docHash, doc.title, texts);
    }

    /** Per-document replication view for the Library. */
    async documentReport(): Promise<DocReplicaInfo[]> {
        const catalog = this.deps.catalog;
        const [holders, pop] = await Promise.all([this.holderMap(), this.popularityMap()]);
        const usage = await catalog.usage();
        const candidates = this.candidateNodes(usage.freeBytes);
        const liveIds = new Set(candidates.map((c) => c.nodeId));

        const byKey = new Map<number, MetaRow[]>();
        for (const m of catalog.metas()) {
            const list = byKey.get(m.docKey);
            if (list) list.push(m);
            else byKey.set(m.docKey, [m]);
        }

        return catalog.docRows().map((doc) => {
            const metas = byKey.get(doc.docKey) ?? [];
            let replicaTotal = 0;
            let storedHere = 0;
            let hits = 0;
            let desired = 0;

            for (const m of metas) {
                const claimed = holders.get(m.docId) ?? new Set<number>();
                const liveHolders = [...claimed].filter((id) => liveIds.has(id));
                if (catalog.holdsBody(m.docId)) {
                    storedHere++;
                    if (!liveHolders.includes(this.deps.selfId)) liveHolders.push(this.deps.selfId);
                }
                replicaTotal += liveHolders.length;
                const h = pop.get(m.docId) ?? 0;
                hits += h;
                desired = Math.max(desired, targetReplicas({ hits: h, candidates }));
            }

            return {
                authorship: doc.authorship,
                docHash: doc.docHash,
                sig: doc.sig,
                contentIntact: this.contentIntact(doc, metas),
                docKey: doc.docKey,
                title: doc.title,
                source: doc.source,
                provenance: doc.provenance,
                chunkCount: metas.length,
                bytes: doc.bytes,
                originId: doc.originId,
                meanReplicas: metas.length ? replicaTotal / metas.length : 0,
                storedHere,
                desired,
                hits,
            };
        });
    }

    /** Target metadata replica count, for display alongside the body target. */
    metaTarget(peerCount: number): number {
        return Math.min(META_REPLICAS, peerCount + 1);
    }
}

function blankStat(nodeId: number, now: number): PeerStatRow {
    return {
        nodeId,
        firstSeen: now,
        lastSeen: now,
        helloSeen: 0,
        helloExpected: 0,
        requests: 0,
        responses: 0,
        freeBytes: 0,
    };
}

/**
 * Halves the counters once they get large.
 *
 * Keeps the ratio intact while letting a peer live down an old bad patch —
 * without this, reliability is an average over all time and a node that was
 * offline early can never fully recover. An EWMA in integer clothing.
 */
function decay(row: PeerStatRow): PeerStatRow {
    if (row.helloExpected < STAT_WINDOW && row.requests < STAT_WINDOW) return row;
    return {
        ...row,
        helloSeen: Math.floor(row.helloSeen / 2),
        helloExpected: Math.floor(row.helloExpected / 2),
        requests: Math.floor(row.requests / 2),
        responses: Math.floor(row.responses / 2),
    };
}
