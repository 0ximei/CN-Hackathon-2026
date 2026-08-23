import {
    BROADCAST,
    IDENT_NONCE_BYTES,
    PACKET_TYPE_NAME,
    PacketType,
    decodeAnnounce,
    decodeCatalogReq,
    decodeDocReq,
    decodeDocRes,
    decodeHello,
    decodeHolders,
    decodeIdentReq,
    decodeIdentRes,
    decodeQuery,
    decodeResult,
    encodeAnnounce,
    encodeCatalogReq,
    encodeDocReq,
    encodeDocRes,
    encodeHello,
    encodeHolders,
    encodeIdentReq,
    encodeIdentRes,
    encodeQuery,
    encodeResult,
    decodePacket,
    encodePacket,
    hopsTravelled,
    identChallengeBytes,
    type AnnouncePayload,
    type Hit,
    type HoldersPayload,
    type Packet,
} from '@core/protocol/packet';
import { Router, type RouteEntry } from '@core/protocol/router';
import { dequantize, fromWireScore, quantize, toWireScore } from '@core/search/vector';
import type { Identity } from '@core/lib/ids';
import { nextMsgId } from '@core/lib/ids';

import type { Transport } from '@core/transport/Transport';

import { manifestBytes } from '../identity/authorship';
import { randomBytes } from '../identity/keys';
import {
    blankPeerIdentity,
    confirmInPerson,
    judge,
    revokeTrust,
    type PeerIdentity,
    type TrustState,
} from '../identity/trust';
import { Replicator, type ReplicationStats } from '../replication/Replicator';
import type { MeshCatalog } from '../storage/MeshCatalog';
import type { CatalogStats, DocRow } from '../storage/types';
import { embedder } from '../search/embedder';
import { fromBase64, toBase64 } from '../lib/base64';

/**
 * What the orchestrator needs from a radio.
 *
 * `Transport` plus two optional extras. BLE has a running commentary worth
 * surfacing — dialling, MTU negotiation, links lost — that the other transports
 * have no equivalent for, and it can be told to pretend a link is down, which
 * is how the demo forces multi-hop routing without physically walking a phone
 * out of range. Both are optional rather than part of the interface every radio
 * must satisfy.
 */
export type MeshTransport = Transport & {
    onLog?(cb: (line: string) => void): () => void;
    /** Peers to behave as if unreachable. The demo's "cut a link" control. */
    setSevered?(peerIds: string[]): void;
};

/**
 * The key material a node needs to prove who it is.
 *
 * Optional on the constructor: a node with no credentials still routes, still
 * searches and still replicates, it simply cannot answer a challenge and stays
 * permanently unverified to its peers. That is a real state a mesh can be in —
 * an older build, or a node whose keystore failed — and modelling it as
 * "unverified" is more useful than refusing to start.
 */
export interface NodeCredentials {
    publicKey: Uint8Array;
    sign(message: Uint8Array): Uint8Array;
}

const HELLO_INTERVAL_MS = 3_000;

/**
 * How long a peer may stay silent before it is presumed gone.
 *
 * Four missed beacons. Generous because BLE beacons are cheap but the link
 * carrying them is not: a node relaying a large DOC_RES can easily delay its
 * own HELLO past a tighter deadline, and dropping a peer that is merely busy
 * costs a route rebuild for nothing.
 */
const PEER_TIMEOUT_MS = 13_000;

/**
 * The same deadline for a node that is not a neighbour.
 *
 * Distant nodes are only refreshed by the occasional flooded beacon, so judging
 * them on the direct-link deadline would evict every one of them between floods
 * and make the mesh look like it kept losing half its nodes.
 */
const DISTANT_PEER_TIMEOUT_MS = 45_000;

/**
 * Flood every third beacon; send the rest one hop.
 *
 * A beacon has two jobs and they want different reach. Liveness is a statement
 * about a link and must be fast, and flooding it every three seconds would put
 * N x N packets on a radio that moves a few kilobytes a second. Identity — who
 * is out there and what they are called — is needed mesh-wide but changes
 * rarely, so it can travel at a third of the rate.
 */
const FLOOD_HELLO_EVERY = 3;

/**
 * How long to wait for the mesh before answering.
 *
 * Much longer than the browser build's window, because this radio is genuinely
 * slow. A BLE link with a negotiated 517-byte MTU moves a few kilobytes a
 * second, and a two-hop reply has to be received, re-encoded and re-transmitted
 * by a phone in the middle. Cutting this short does not make the answer arrive
 * faster — it drops the far half of the mesh.
 */
const COLLECT_WINDOW_MS = 6_000;

/** Stop waiting once every peer we know about has replied. */
const EARLY_EXIT_GRACE_MS = 400;

const HITS_PER_NODE = 4;
const DOC_FETCH_TIMEOUT_MS = 8_000;
const IDENT_TIMEOUT_MS = 10_000;
const OUTBOX_TTL_MS = 5 * 60 * 1000;
const OUTBOX_RETRY_MS = 5_000;
const ACTIVITY_CAPACITY = 200;

/**
 * How often coalesced snapshots reach the UI.
 *
 * `peers`, `activity`, `stats`, `outbox` and `routes` are snapshots: each one
 * carries the whole current value, so a later emission supersedes an earlier
 * one completely and nothing is lost by skipping the ones in between. They are
 * also the frequent ones — every packet produces at least three, a flooded
 * HELLO produces one `sent` per link, and on this build the radio's own
 * commentary arrives as activity too. Emitting each immediately meant a React
 * render per packet, measured at a dozen a second on an idle three-node mesh
 * and far more under load, on a phone that is simultaneously animating the
 * topology view.
 *
 * Four a second still reads as live and is an order of magnitude below the
 * packet rate. Events that carry a *decision* rather than a snapshot — a query
 * result, a catalog change, an identity verdict — are not coalesced.
 */
const UI_COALESCE_MS = 250;

/**
 * Queries kept for late-arriving bodies.
 *
 * A DOC_RES can land long after its query window closed, and `fetchFullText`
 * writes the passage back into every query still showing it. Keeping all of
 * them forever made that a scan over the node's entire history and leaked a
 * copy of every hit ever seen.
 */
const MAX_TRACKED_QUERIES = 8;

/** The snapshot events, coalesced onto one timer. */
type CoalescedEvent = 'peers' | 'activity' | 'stats' | 'outbox' | 'routes';
/**
 * Chunk entries a CATALOG_REQ reply will send in one go.
 *
 * Two hundred, as the browser build uses, is 130 KB of metadata poured into a
 * link that has existed for one second and moves a few kilobytes a second. This
 * is a catch-up, not a transfer: it exists so a node that joined after an upload
 * hears that the document exists at all. Whatever does not fit arrives over the
 * next few minutes on the replicator's re-announce cycle.
 */
const CATALOG_SYNC_MAX = 16;

/**
 * How long to let a new link settle before asking it for anything.
 *
 * The first seconds of a BLE link are the expensive ones — MTU negotiation,
 * service discovery, the subscribe — and the first thing that should cross it
 * is a beacon, because a peer that cannot get a HELLO through inside
 * PEER_TIMEOUT_MS is a peer this node will shortly declare dead. Sending a
 * catalog request into that window puts kilobytes of reply ahead of the packet
 * that keeps the peer alive.
 */
const CATALOG_SYNC_DELAY_MS = 5_000;

/**
 * How long to wait for a catalog reply before asking again, and how many times.
 *
 * A request that leaves this node is not a request that arrived. On this radio
 * a link routinely dies between the two, and the reply is kilobytes so it has
 * further to fall. The only other route an upload has to a peer that missed the
 * flood is the re-announcement walk, which covers one document a minute — many
 * minutes on a real library, which to a user is indistinguishable from never.
 *
 * Four attempts because the peer may simply have nothing to send: a node with
 * only the seed corpus answers a catalog request with silence, and retrying
 * that forever would spend the link on a question already answered.
 */
const CATALOG_SYNC_RETRY_MS = 9_000;
const CATALOG_SYNC_ATTEMPTS = 4;

export interface PeerState {
    nodeId: number;
    name: string;
    /** Chunks the peer has metadata for — what it can search. */
    known: number;
    /** Chunks it holds the body of — what it can serve. */
    stored: number;
    documents: number;
    /** Self-reported free storage. The one signal a node is the authority on. */
    freeBytes: number;
    /** Locally observed, never self-reported. 0..1. */
    reliability: number;
    lastSeen: number;
    hops: number;
    /**
     * Node id of the next hop toward this peer. Its own id when direct, 0 when
     * there is no route to it at all.
     *
     * Three states rather than two, and the third is the reason: a peer that
     * has beaconed but whose route has aged out is neither directly linked nor
     * reachable through anyone, and collapsing that into "direct" draws a radio
     * link that is not there.
     *
     * Resolved here rather than in the UI for the same reason `peerNodeId` on
     * an activity event is: the router names the next hop by transport peer id,
     * and turning one back into a node id means consulting the route table. A
     * view that tried would have to guess at the peer-id format, which differs
     * between radios.
     *
     * The topology view needs it because without it a two-hop peer is drawn on
     * a line straight to this node, which is a claim that there is a radio link
     * between them. There is not — there is a relay, and it is on the screen.
     */
    via: number;
    trust: TrustState;
    /** Whether this peer has proven the id it is using. */
    verified: boolean;
}

export interface MeshHit {
    docId: number;
    score: number;
    title: string;
    section: string;
    snippet: string;
    /** Full passage, once fetched. Undefined means only the snippet is held. */
    text?: string;
    /** The node that matched it — not necessarily one that holds it. */
    fromNodeId: number;
    fromNodeName: string;
    /** A node believed to hold the body, 0 when unknown. */
    holderId: number;
    holderName: string;
    hops: number;
    local: boolean;
    /** True when this node itself holds the body. */
    storedHere: boolean;
}

export interface QueryState {
    queryId: number;
    text: string;
    hits: MeshHit[];
    startedAt: number;
    /** Set when the collection window closes. */
    finishedAt?: number;
    answered: number[];
    /** Nodes that replied, for the map animation. */
    respondedNodeIds: number[];
}

/**
 * One line of the wire log.
 *
 * Structured rather than a formatted string, because the same events drive the
 * topology view: a pre-rendered "QUERY -> all" cannot be turned back into an
 * edge to animate. The UI formats; this records.
 */
export interface ActivityEvent {
    /**
     * Monotonic within this node's lifetime.
     *
     * The topology view replays only events it has not drawn yet, and several
     * packets routinely land inside the same millisecond — a flooded QUERY
     * produces one `sent` per link. Watermarking on `at` would silently drop
     * every one after the first.
     */
    seq: number;
    at: number;
    kind: 'sent' | 'forwarded' | 'received' | 'dropped' | 'replicated' | 'evicted' | 'radio';
    type: string;
    srcId: number;
    dstId: number;
    /** Transport peer id, `flood`, or `local` for events with no link behind them. */
    peer: string;
    /**
     * The node at the other end of `peer`, or 0 when there isn't one.
     *
     * Resolved here rather than in the UI because only this layer can do it:
     * the router names links by transport peer id, and mapping one back to a
     * node id means consulting the route table. A view that tried would have to
     * guess at the peer-id format, which differs between radios.
     */
    peerNodeId: number;
    reason?: string;
    detail?: string;
}

export interface MeshStats {
    sent: number;
    received: number;
    forwarded: number;
    dropped: number;
    duplicates: number;
    queued: number;
}

type Events = {
    peers(peers: PeerState[]): void;
    query(state: QueryState): void;
    activity(events: ActivityEvent[]): void;
    stats(stats: MeshStats): void;
    routes(routes: Map<number, RouteEntry>): void;
    /** The catalog changed — an upload here, or content pulled from a peer. */
    catalog(stats: CatalogStats): void;
    replication(stats: ReplicationStats): void;
    identities(peers: PeerIdentity[]): void;
    outbox(queued: number): void;
};

/**
 * The application protocol, over whatever radio is mounted.
 *
 * This is the browser build's `MeshNode` with the same storage model underneath
 * it: two tiers, and a replication policy that decides which bodies live here.
 * Metadata gossips on ANNOUNCE and is kept by whichever nodes rank for it;
 * bodies are pulled and evicted by `Replicator` against the shared policy in
 * `@core/replication/policy`. Meeting a peer for the first time this session
 * also triggers a one-shot CATALOG_REQ/CATALOG_RES catch-up, so content
 * uploaded before that peer joined still reaches it.
 *
 * The layers below are the same modules the web app uses and the same ones its
 * test suite covers: the packet codec, the flooding router with its TTL and
 * dedup LRU, the backward-learned unicast routes, and the store-and-forward
 * queue.
 */
export class MeshNode {
    readonly router: Router;
    readonly replicator: Replicator;

    /** Injected by the network controls to demonstrate loss tolerance. 0..1. */
    packetLoss = 0;
    /** Set once a generative model is loaded, and advertised in HELLO. */
    hasLlm = false;

    private helloTimer: ReturnType<typeof setInterval> | null = null;
    private outboxTimer: ReturnType<typeof setInterval> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private dirty = new Set<CoalescedEvent>();
    /**
     * Set by `stop`, checked after every await in `start`.
     *
     * `start` is asynchronous and the thing that owns it — a React effect — can
     * be torn down while it is still running. Without this the cleanup returns
     * having stopped nothing, `start` finishes afterwards, and the node comes up
     * anyway: a second node on the same radio, beaconing the same id and
     * answering every query twice.
     */
    private stopped = false;
    /** Challenge expiry timers, so teardown does not leave them armed. */
    private challengeTimers = new Set<ReturnType<typeof setTimeout>>();
    private peers = new Map<number, PeerState>();
    private queries = new Map<number, QueryState>();
    /**
     * Waiters per document, not one waiter per document.
     *
     * The user opening a hit and the replicator pulling the same body are
     * independent requests that routinely overlap. A single-slot map meant the
     * second overwrote the first, and the first then sat out its whole eight
     * second timeout with the answer already in hand — and, for the
     * replicator's half, marked a peer unreliable for a reply it did send.
     */
    private pendingDocs = new Map<number, Set<(payload: { text: string; source: string } | null) => void>>();
    /** Outstanding identity challenges, by the node they were sent to. */
    private challenges = new Map<number, { nonce: Uint8Array; sentAt: number }>();
    private identities = new Map<number, PeerIdentity>();
    /** Peers that have actually answered a CATALOG_REQ. */
    private syncedPeers = new Set<number>();
    /** Peers still owed a catalog request: when we first saw them and last asked. */
    private catalogSync = new Map<number, { since: number; asked: number; attempts: number }>();
    /** docId -> a peer that claimed to hold it, for the synchronous query path. */
    private holderHints = new Map<number, number>();
    private activity: ActivityEvent[] = [];
    private activitySeq = 0;
    private queued = 0;
    private helloCount = 0;
    private listeners: { [K in keyof Events]: Set<Events[K]> } = {
        peers: new Set(),
        query: new Set(),
        activity: new Set(),
        stats: new Set(),
        routes: new Set(),
        catalog: new Set(),
        replication: new Set(),
        identities: new Set(),
        outbox: new Set(),
    };
    private unsubscribes: (() => void)[] = [];

    constructor(
        /** Mutable only through `rename`: the id and key never change with it. */
        public identity: Identity,
        readonly transport: MeshTransport,
        private catalog: MeshCatalog,
        private credentials?: NodeCredentials,
    ) {
        this.router = new Router({
            nodeId: identity.id,
            transport,
            lossRate: () => this.packetLoss,
            onUndeliverable: (pkt, dstId) => void this.park(pkt, dstId),
        });

        this.replicator = new Replicator({
            selfId: identity.id,
            catalog,
            livePeers: () =>
                [...this.peers.values()].map((p) => ({ nodeId: p.nodeId, freeBytes: p.freeBytes })),
            announce: (payload, dstId) => this.sendAnnounce(payload, dstId),
            announceHolders: (payload) =>
                this.router.send(PacketType.HOLDERS, encodeHolders(payload), BROADCAST),
            fetchBody: (docId, from) => this.fetchBodyFrom(docId, from),
            onStats: (stats) => this.emit('replication', stats),
            onEvent: (e) =>
                this.note({
                    kind: e.kind === 'pull' ? 'replicated' : 'evicted',
                    type: e.kind === 'pull' ? 'BODY' : 'BODY',
                    srcId: this.identity.id,
                    dstId: this.identity.id,
                    peer: 'local',
                    detail: `${e.title}: ${e.detail}`,
                }),
        });
    }

    /* --------------------------- lifecycle --------------------------- */

    async start(): Promise<void> {
        this.stopped = false;
        await this.transport.start();
        if (this.stopped) {
            // Torn down while the radio was coming up. It is running now, so it
            // is ours to shut down; nothing above it was ever wired in.
            this.transport.stop();
            return;
        }
        this.router.start();

        this.unsubscribes.push(
            this.router.on('deliver', (pkt) => void this.onPacket(pkt)),
            this.router.on('forwarded', (pkt, to) =>
                this.note({
                    kind: 'forwarded',
                    type: name(pkt.type),
                    srcId: pkt.srcId,
                    dstId: pkt.dstId,
                    peer: to,
                }),
            ),
            this.router.on('dropped', (pkt, reason, from) =>
                this.note({
                    kind: 'dropped',
                    type: pkt ? name(pkt.type) : 'FRAME',
                    srcId: pkt?.srcId ?? 0,
                    dstId: pkt?.dstId ?? 0,
                    peer: from,
                    reason,
                }),
            ),
            this.router.on('sent', (pkt, to) =>
                this.note({
                    kind: 'sent',
                    type: name(pkt.type),
                    srcId: pkt.srcId,
                    dstId: pkt.dstId,
                    peer: to,
                }),
            ),
            this.router.on('routesChanged', () => this.emitSoon('routes')),
        );
        const offLog = this.transport.onLog?.((line) =>
            this.note({
                kind: 'radio',
                type: 'RADIO',
                srcId: this.identity.id,
                dstId: 0,
                peer: 'local',
                detail: line,
            }),
        );
        if (offLog) this.unsubscribes.push(offLog);

        await this.loadIdentities();
        // Anything parked in a previous session is still owed. Reading the count
        // once here is also what lets `flushOutbox` skip the database entirely
        // while the queue is empty, which is almost always.
        this.queued = await this.catalog.queuedCount();
        if (this.stopped) {
            this.stop();
            return;
        }

        this.sendHello();
        this.helloTimer = setInterval(() => {
            this.sendHello();
            this.expirePeers();
            this.syncCatalogs();
            void this.refreshReliability();
        }, HELLO_INTERVAL_MS);
        this.outboxTimer = setInterval(() => void this.flushOutbox(), OUTBOX_RETRY_MS);
    }

    /** Starts the replication loop. Separate from `start` so a UI can stage it. */
    startReplication(): void {
        this.replicator.start();
    }

    stop(): void {
        this.stopped = true;
        if (this.helloTimer) clearInterval(this.helloTimer);
        if (this.outboxTimer) clearInterval(this.outboxTimer);
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.helloTimer = null;
        this.outboxTimer = null;
        this.flushTimer = null;
        this.dirty.clear();
        for (const timer of this.challengeTimers) clearTimeout(timer);
        this.challengeTimers.clear();
        this.replicator.stop();
        for (const off of this.unsubscribes) off();
        this.unsubscribes = [];
        this.router.stop();
        this.transport.stop();

        // Release anything still waiting on a reply that can no longer arrive,
        // rather than leaving its caller to discover it by timeout.
        for (const waiters of this.pendingDocs.values()) {
            for (const resolve of waiters) resolve(null);
        }
        this.pendingDocs.clear();
        this.challenges.clear();
        this.catalogSync.clear();
        this.queries.clear();
        this.peers.clear();
        this.emit('peers', []);
    }

    on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
        this.listeners[event].add(cb);
        return () => this.listeners[event].delete(cb);
    }

    /* ----------------------------- upload ---------------------------- */

    /**
     * Ingests a document here and gossips its metadata to the mesh.
     *
     * The uploading node keeps every body it created — it is the first replica
     * by definition — and the replicator spreads them outward from there.
     */
    async upload(
        filename: string,
        raw: string,
        onProgress?: (done: number, total: number) => void,
        title?: string,
    ): Promise<void> {
        const { doc } = await this.catalog.upload(
            filename,
            raw,
            this.identity.id,
            onProgress,
            title,
        );
        await this.sign(doc);
        this.emit('catalog', this.catalog.stats());
        await this.replicator.announceDocument(doc.docKey);
        void this.replicator.reconcile();
    }

    /**
     * Attests to a document this node wrote, before anyone else sees it.
     *
     * Signed before the announce rather than after, so the first packet to
     * leave already carries the proof. A node with no credentials skips it and
     * the document travels unsigned, which is honest — an unsigned document
     * shows as unsigned rather than as somebody's word for it.
     */
    private async sign(doc: DocRow): Promise<void> {
        if (!this.credentials || !doc.docHash) return;
        const sig = this.credentials.sign(
            manifestBytes({
                docKey: doc.docKey,
                docHash: doc.docHash,
                title: doc.title,
                source: doc.source,
                chunkCount: doc.chunkCount,
                bytes: doc.bytes,
                createdAtSec: Math.floor(doc.createdAt / 1000),
                authorId: this.identity.id,
            }),
        );
        await this.catalog.attest(doc.docKey, this.credentials.publicKey, sig);
    }

    /**
     * Changes the label this node beacons and signs under.
     *
     * The key and therefore the id are untouched, so peers that verified this
     * node stay verified — what they verified was the key. The new name is
     * signed into the next IDENT_RES, which is what stops a rename from being a
     * way to display one name while having proven another.
     */
    rename(name: string): void {
        this.identity = { ...this.identity, name };
    }

    /** Forgets a document on this device only. Peers keep their copies. */
    async forget(docKey: number): Promise<void> {
        await this.catalog.forget(docKey);
        this.emit('catalog', this.catalog.stats());
        void this.replicator.reconcile();
    }

    /** Changes how much room this node offers the mesh, then acts on it. */
    async setBudget(bytes: number): Promise<void> {
        await this.catalog.setBudget(bytes);
        await this.replicator.reconcile();
    }

    private sendAnnounce(payload: AnnouncePayload, dstId?: number): void {
        this.router.send(
            dstId === undefined ? PacketType.ANNOUNCE : PacketType.CATALOG_RES,
            encodeAnnounce(payload),
            dstId ?? BROADCAST,
        );
    }

    /* ----------------------------- search ---------------------------- */

    /**
     * Search this node and everything it can reach.
     *
     * Local results are available before the first packet leaves, so the UI has
     * something to show immediately; mesh results merge in as they arrive and
     * the promise resolves when the collection window closes.
     */
    async search(text: string): Promise<QueryState> {
        const queryId = nextMsgId();
        const vector = embedder.embed(text);

        const state: QueryState = {
            queryId,
            text,
            hits: this.localHits(vector, text),
            startedAt: Date.now(),
            answered: [],
            respondedNodeIds: [],
        };
        this.queries.set(queryId, state);
        // Oldest first, so dropping from the front drops the least useful.
        while (this.queries.size > MAX_TRACKED_QUERIES) {
            const oldest = this.queries.keys().next();
            if (oldest.done) break;
            this.queries.delete(oldest.value);
        }
        this.emit('query', snapshot(state));

        const { q, scale } = quantize(vector);
        this.router.send(
            PacketType.QUERY,
            encodeQuery({ queryId, topK: HITS_PER_NODE, scale, vec: q, text: text.slice(0, 200) }),
        );

        await this.collect(state);

        // Popularity is counted where the passage was *wanted*, not where it
        // happened to be stored, and only ever as this node's own share of the
        // G-counter. That is what makes a chunk earn extra replicas across the
        // mesh rather than only on whichever node already had it.
        await this.replicator.recordHit(state.hits.map((h) => h.docId));
        return state;
    }

    /**
     * Wait out the collection window, but not pointlessly.
     *
     * If everyone we know about has answered there is nothing left to wait for,
     * so the window closes early after a short grace — long enough for a reply
     * one hop behind, short enough to feel immediate. A node with no peers
     * resolves almost instantly rather than staring at a timer.
     */
    private collect(state: QueryState): Promise<void> {
        return new Promise((resolve) => {
            const finish = () => {
                clearInterval(poll);
                clearTimeout(deadline);
                state.finishedAt = Date.now();
                state.hits.sort((a, b) => b.score - a.score);
                this.emit('query', snapshot(state));
                resolve();
            };

            const deadline = setTimeout(finish, COLLECT_WINDOW_MS);
            const poll = setInterval(() => {
                const expected = [...this.peers.keys()];
                if (!expected.length) {
                    if (Date.now() - state.startedAt > EARLY_EXIT_GRACE_MS) finish();
                    return;
                }
                if (expected.every((id) => state.answered.includes(id))) {
                    setTimeout(finish, EARLY_EXIT_GRACE_MS);
                    clearInterval(poll);
                }
            }, 200);
        });
    }

    /**
     * This node's own answers.
     *
     * Note what `storedHere` is doing: a hit from the local catalog is not proof
     * the passage is here. Metadata carries the embedding, so a node scores and
     * returns passages whose bodies live somewhere else entirely — and those
     * rows come back with the text absent and a holder named.
     */
    private localHits(vector: Float32Array, text: string): MeshHit[] {
        return this.catalog.searchLocal(vector, text, HITS_PER_NODE).map((hit) => {
            const holderId = hit.hasBody ? this.identity.id : this.knownHolder(hit.docId);
            return {
                docId: hit.docId,
                score: hit.score,
                title: hit.meta.title,
                section: hit.meta.section,
                snippet: hit.meta.snippet,
                text: hit.hasBody ? this.catalog.bodyOf(hit.docId) : undefined,
                fromNodeId: this.identity.id,
                fromNodeName: this.identity.name,
                holderId,
                holderName: this.nameOf(holderId),
                hops: 0,
                local: true,
                storedHere: hit.hasBody,
            };
        });
    }

    /**
     * Pull the full passage behind a hit.
     *
     * Snippets ride inside RESULT packets because a passage would not fit — a
     * RESULT with four 1 KB bodies is 4 KB of radio time per answering node,
     * most of it for hits the user will never open. The body is fetched only
     * when it is wanted, and from a node that holds it rather than necessarily
     * the one that answered.
     */
    async fetchFullText(hit: MeshHit): Promise<string> {
        if (hit.text) return hit.text;

        const local = await this.catalog.getBody(hit.docId);
        if (local) return local;

        const target =
            hit.holderId && hit.holderId !== this.identity.id ? hit.holderId : hit.fromNodeId;
        if (!target || target === this.identity.id) return hit.snippet;

        const reply = await this.requestDoc(hit.docId, target);
        if (!reply?.text) return hit.snippet;

        // Record it against every query still showing this passage, so the row
        // expands from snippet to body and a second open costs no radio time.
        for (const state of this.queries.values()) {
            let touched = false;
            for (const h of state.hits) {
                if (h.docId === hit.docId && !h.text) {
                    h.text = reply.text;
                    touched = true;
                }
            }
            if (touched) this.emit('query', snapshot(state));
        }
        return reply.text;
    }

    /** The replicator's body pull, with the peer's reliability observed around it. */
    private async fetchBodyFrom(docId: number, fromNodeId: number): Promise<string | null> {
        await this.replicator.noteRequest(fromNodeId);
        const reply = await this.requestDoc(docId, fromNodeId);
        if (reply?.text) {
            await this.replicator.noteResponse(fromNodeId);
            return reply.text;
        }
        return null;
    }

    /** Sends a DOC_REQ to `target` and waits for the DOC_RES, or null on timeout. */
    private requestDoc(
        docId: number,
        target: number,
    ): Promise<{ text: string; source: string } | null> {
        return new Promise((resolve) => {
            let waiters = this.pendingDocs.get(docId);
            if (!waiters) {
                waiters = new Set();
                this.pendingDocs.set(docId, waiters);
            }

            const settle = (payload: { text: string; source: string } | null) => {
                clearTimeout(timer);
                waiters!.delete(settle);
                if (!waiters!.size) this.pendingDocs.delete(docId);
                resolve(payload);
            };
            const timer = setTimeout(() => settle(null), DOC_FETCH_TIMEOUT_MS);

            waiters.add(settle);
            this.router.send(PacketType.DOC_REQ, encodeDocReq(docId), target);
        });
    }

    /* -------------------------- identity ----------------------------- */

    /**
     * Asks a peer to prove the node id it is using.
     *
     * Sent on first contact and re-sendable from the UI. The nonce is kept here
     * rather than derived from anything the peer can see: a response is only
     * evidence if it could not have been prepared in advance.
     */
    challenge(nodeId: number): void {
        const { bytes: nonce } = randomBytes(IDENT_NONCE_BYTES);
        this.challenges.set(nodeId, { nonce, sentAt: Date.now() });

        const existing = this.identities.get(nodeId);
        if (existing && existing.state === 'unknown') {
            this.setIdentity({ ...existing, state: 'pending', detail: 'waiting for a signature' });
        }

        this.router.send(PacketType.IDENT_REQ, encodeIdentReq(nonce), nodeId);

        const timer = setTimeout(() => {
            this.challengeTimers.delete(timer);
            const pending = this.challenges.get(nodeId);
            if (!pending || pending.nonce !== nonce) return;
            this.challenges.delete(nodeId);
            const peer = this.identities.get(nodeId);
            if (peer?.state === 'pending') {
                this.setIdentity({
                    ...peer,
                    state: 'unknown',
                    detail: 'no answer — it may be an older build',
                });
            }
        }, IDENT_TIMEOUT_MS);
        this.challengeTimers.add(timer);
    }

    /** Records that a person compared the safety number and it matched. */
    async markTrusted(nodeId: number): Promise<void> {
        const peer = this.identities.get(nodeId);
        if (!peer) return;
        await this.setIdentity(confirmInPerson(peer, Date.now()));
    }

    /** Undoes that confirmation, back to the cryptographic fact underneath. */
    async clearTrust(nodeId: number): Promise<void> {
        const peer = this.identities.get(nodeId);
        if (!peer) return;
        await this.setIdentity(revokeTrust(peer));
    }

    peerIdentities(): PeerIdentity[] {
        return [...this.identities.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    identityOf(nodeId: number): PeerIdentity | undefined {
        return this.identities.get(nodeId);
    }

    private async loadIdentities(): Promise<void> {
        for (const row of await this.catalog.peerIdentities()) {
            this.identities.set(row.nodeId, { ...row, state: row.state as TrustState });
        }
        this.emit('identities', this.peerIdentities());
    }

    private async setIdentity(peer: PeerIdentity): Promise<void> {
        this.identities.set(peer.nodeId, peer);
        await this.catalog.putPeerIdentity(peer);
        const known = this.peers.get(peer.nodeId);
        if (known) {
            this.peers.set(peer.nodeId, {
                ...known,
                trust: peer.state,
                verified: peer.state === 'verified' || peer.state === 'trusted',
            });
            this.emitSoon('peers');
        }
        this.emit('identities', this.peerIdentities());
    }

    /* --------------------------- packet handling --------------------- */

    private async onPacket(pkt: Packet): Promise<void> {
        this.note({
            kind: 'received',
            type: name(pkt.type),
            srcId: pkt.srcId,
            dstId: pkt.dstId,
            peer: peerIdOf(pkt.srcId),
            detail: `${hopsTravelled(pkt)}h`,
        });

        // Every branch runs before the stats are published, rather than each
        // one remembering to do it: the earlier shape returned from inside the
        // switch, so the traffic counters only ever updated for packet types
        // this node did not understand.
        switch (pkt.type) {
            case PacketType.HELLO:
                this.onHello(pkt);
                break;
            case PacketType.QUERY:
                this.onQuery(pkt);
                break;
            case PacketType.RESULT:
                this.onResult(pkt);
                break;
            case PacketType.DOC_REQ:
                await this.onDocReq(pkt);
                break;
            case PacketType.DOC_RES:
                this.onDocRes(pkt);
                break;
            case PacketType.CATALOG_RES:
                this.noteCatalogReply(pkt.srcId, await this.onAnnounce(pkt));
                break;
            case PacketType.ANNOUNCE:
                await this.onAnnounce(pkt);
                break;
            case PacketType.CATALOG_REQ:
                await this.onCatalogReq(pkt);
                break;
            case PacketType.HOLDERS:
                await this.onHolders(pkt);
                break;
            case PacketType.IDENT_REQ:
                this.onIdentReq(pkt);
                break;
            case PacketType.IDENT_RES:
                await this.onIdentRes(pkt);
                break;
            default:
                break;
        }
        this.emitStats();
    }

    private onHello(pkt: Packet): void {
        const hello = decodeHello(pkt.payload);
        const known = this.peers.get(pkt.srcId);
        const identity = this.identities.get(pkt.srcId);

        this.peers.set(pkt.srcId, {
            nodeId: pkt.srcId,
            // A *verified* peer's name is the one it signed, not the one it
            // beacons: HELLO is unauthenticated, so a node that has proven a
            // name must not be able to display a different one afterwards.
            name: identity?.verifiedAt ? identity.name : hello.name,
            known: hello.known,
            stored: hello.stored,
            documents: hello.documents,
            freeBytes: hello.freeKb * 1024,
            reliability: known?.reliability ?? 0.5,
            lastSeen: Date.now(),
            hops: hopsTravelled(pkt),
            // Filled in by `peerList`, from the route table rather than from
            // this packet: the relay can change without this peer's beacon
            // changing at all.
            via: 0,
            trust: identity?.state ?? 'unknown',
            verified: identity?.state === 'verified' || identity?.state === 'trusted',
        });

        void this.replicator.noteHello(pkt.srcId, hello.freeKb * 1024);

        if (!known) {
            this.note({
                kind: 'received',
                type: 'HELLO',
                srcId: pkt.srcId,
                dstId: this.identity.id,
                peer: peerIdOf(pkt.srcId),
                detail: `${hello.name} joined`,
            });

            if (!this.identities.has(pkt.srcId)) {
                void this.setIdentity(blankPeerIdentity(pkt.srcId, hello.name, Date.now()));
            }
            // Prove-who-you-are and catch-me-up are both first-contact business,
            // but they are independent: a peer that cannot sign is still worth
            // syncing with, and a peer with nothing to sync still has to prove
            // its id.
            this.challenge(pkt.srcId);

            // Note that this peer is owed a catalog request. Sending it is the
            // beacon tick's job: a request is only worth marking done once the
            // peer has answered it, and one shot from a timer here could never
            // know whether it had.
            if (!this.syncedPeers.has(pkt.srcId) && !this.catalogSync.has(pkt.srcId)) {
                this.catalogSync.set(pkt.srcId, { since: Date.now(), asked: 0, attempts: 0 });
            }
        }
        this.emitSoon('peers');
        // A beacon is proof of reachability, which is exactly the trigger
        // anything parked for that node has been waiting on.
        void this.flushOutbox(pkt.srcId);
    }

    private onQuery(pkt: Packet): void {
        const query = decodeQuery(pkt.payload);
        const vector = dequantize(query.vec, query.scale);
        const scored = this.catalog.searchLocal(vector, query.text, query.topK || HITS_PER_NODE);

        // A node with nothing relevant contributes no *hits* — the floor inside
        // searchLocal has already dropped them, and without it this would return
        // the four least-irrelevant passages it knows for the asking node to
        // cite as answers, which on a first-aid corpus is the worst failure
        // available.
        //
        // It still sends the packet. Saying nothing at all is what the browser
        // build does, and it is affordable there because the collection window
        // is five seconds on a fast link; here one silent node costs the asker
        // the entire six-second window, since the early exit waits on every
        // known peer having replied. An empty RESULT is not a claim of
        // relevance, it is "asked and answered".
        const hits: Hit[] = scored.map((s) => ({
            docId: s.docId,
            score: toWireScore(s.score),
            title: s.meta.title,
            snippet: s.meta.snippet,
            // Name a node that actually holds the body, which is frequently not
            // this one. Answering only requires metadata.
            holderId: s.hasBody ? this.identity.id : this.knownHolder(s.docId),
        }));

        this.router.send(
            PacketType.RESULT,
            encodeResult({ queryId: query.queryId, hopCount: hopsTravelled(pkt), hits }),
            pkt.srcId,
        );
    }

    private onResult(pkt: Packet): void {
        const result = decodeResult(pkt.payload);
        const state = this.queries.get(result.queryId);
        if (!state) return; // window already closed, or never ours

        // `answered` closes the collection window and counts every reply,
        // including the empty ones a node with nothing relevant sends.
        // `respondedNodeIds` lights a node up on the map, and should only mean
        // "this node had something" — otherwise every node flashes on every
        // query and the map stops distinguishing anything.
        if (!state.answered.includes(pkt.srcId)) state.answered.push(pkt.srcId);
        if (result.hits.length && !state.respondedNodeIds.includes(pkt.srcId)) {
            state.respondedNodeIds.push(pkt.srcId);
        }
        const peer = this.peers.get(pkt.srcId);
        const hops = hopsTravelled(pkt);

        for (const hit of result.hits) {
            const existing = state.hits.find((h) => h.docId === hit.docId);
            const score = fromWireScore(hit.score);
            if (existing) {
                // The same passage can come back from several nodes. Keep the
                // best score, and prefer the shortest path for the fetch that
                // may follow.
                if (score > existing.score) existing.score = score;
                if (hops < existing.hops && !existing.storedHere) {
                    existing.hops = hops;
                    existing.holderId = hit.holderId || pkt.srcId;
                    existing.holderName = this.nameOf(existing.holderId);
                }
                continue;
            }
            state.hits.push({
                docId: hit.docId,
                score,
                title: hit.title,
                section: '',
                snippet: hit.snippet,
                fromNodeId: pkt.srcId,
                fromNodeName: peer?.name ?? hex(pkt.srcId),
                holderId: hit.holderId || pkt.srcId,
                holderName: this.nameOf(hit.holderId || pkt.srcId),
                hops,
                local: false,
                storedHere: false,
            });
        }

        state.hits.sort((a, b) => b.score - a.score);
        this.emit('query', snapshot(state));
    }

    private async onDocReq(pkt: Packet): Promise<void> {
        const { docId } = decodeDocReq(pkt.payload);
        const meta = this.catalog.getMeta(docId);
        const text = await this.catalog.getBody(docId);
        this.router.send(
            PacketType.DOC_RES,
            encodeDocRes({
                docId,
                title: meta?.title ?? '',
                section: meta?.section ?? '',
                // An empty body is a real answer: "I was named as a holder and I
                // am not one". Silence would leave the asker waiting out the
                // full timeout for information it could have had at once.
                text: text ?? '',
                source: this.catalog.docRow(meta?.docKey ?? 0)?.source ?? '',
            }),
            pkt.srcId,
        );
    }

    private onDocRes(pkt: Packet): void {
        const doc = decodeDocRes(pkt.payload);
        const waiters = this.pendingDocs.get(doc.docId);
        if (!waiters) return;
        // Copied before calling, because each waiter removes itself from the set.
        for (const settle of [...waiters]) settle({ text: doc.text, source: doc.source });
    }

    /**
     * A peer gossiped chunk metadata.
     *
     * Handing it straight to the replicator is the whole change from the
     * previous build, which pulled every body it heard about immediately and
     * kept it forever. Now the metadata is kept if this node ranks as a carrier
     * for it, and the *body* is a separate decision made on the next reconcile
     * pass against how many live copies exist, how popular the chunk is, how
     * reliable the alternatives are, and whether there is room.
     */
    /**
     * Judge a catalog reply by what it taught us, not by its arrival.
     *
     * A peer answers a catalog request with one packet per few passages, and on
     * this radio each of those is several segments that either all arrive or
     * all vanish. Treating the first reply as "synced" leaves a node that got
     * slice one and lost slice two permanently half-informed about a document,
     * with nothing anywhere aware of it. A reply that adds nothing is the only
     * evidence that there is nothing left to add.
     */
    private noteCatalogReply(nodeId: number, added: number): void {
        const state = this.catalogSync.get(nodeId);
        if (!state) return;
        if (added > 0) {
            // Still learning. There may be more, and a slice lost on the way is
            // invisible from this end, so ask again rather than assume.
            state.attempts = 0;
            state.asked = Date.now();
            return;
        }
        this.syncedPeers.add(nodeId);
        this.catalogSync.delete(nodeId);
    }

    private async onAnnounce(pkt: Packet): Promise<number> {
        const payload = decodeAnnounce(pkt.payload);

        // Project the holder claims into the synchronous lookup the query path
        // uses. The authoritative copy goes to SQLite inside the replicator;
        // this is the same information in a form `onQuery` can read without
        // awaiting, and being slightly stale only ever costs a DOC_REQ to a
        // node that answers "not me".
        for (const entry of payload.entries) {
            for (const holder of entry.holders) {
                if (holder !== this.identity.id) this.holderHints.set(entry.docId, holder);
            }
        }

        const added = await this.replicator.onAnnounce(payload, pkt.srcId);
        if (added) {
            this.emit('catalog', this.catalog.stats());
            this.note({
                kind: 'received',
                type: name(pkt.type),
                srcId: pkt.srcId,
                dstId: this.identity.id,
                peer: peerIdOf(pkt.srcId),
                detail: `learned ${added} passage(s) of "${payload.title}"`,
            });
        }
        return added;
    }

    /**
     * A peer said what it holds.
     *
     * The same holder hints the query path reads are updated here as well as in
     * the replicator's store, because this is now the packet that carries them
     * most of the time — a full ANNOUNCE is comparatively rare.
     */
    private async onHolders(pkt: Packet): Promise<void> {
        const payload = decodeHolders(pkt.payload);
        for (const entry of payload.entries) {
            for (const holder of entry.holders) {
                if (holder !== this.identity.id) this.holderHints.set(entry.docId, holder);
            }
        }
        await this.replicator.onHolders(payload, pkt.srcId);
    }

    private async onCatalogReq(pkt: Packet): Promise<void> {
        const req = decodeCatalogReq(pkt.payload);
        await this.replicator.serveCatalogRequest(req.sinceSec, pkt.srcId, req.max);
    }

    /**
     * Answers "prove you are who you say you are".
     *
     * A node with no credentials stays silent rather than sending an empty
     * signature: an unanswered challenge reads as "unverified", which is true,
     * where a malformed answer would read as "failed", which is an accusation.
     */
    private onIdentReq(pkt: Packet): void {
        if (!this.credentials) return;
        const { nonce } = decodeIdentReq(pkt.payload);
        const message = identChallengeBytes(nonce, this.identity.id, this.identity.name);
        this.router.send(
            PacketType.IDENT_RES,
            encodeIdentRes({
                pubKey: this.credentials.publicKey,
                name: this.identity.name,
                nonce,
                sig: this.credentials.sign(message),
            }),
            pkt.srcId,
        );
    }

    private async onIdentRes(pkt: Packet): Promise<void> {
        const res = decodeIdentRes(pkt.payload);
        const pending = this.challenges.get(pkt.srcId);
        this.challenges.delete(pkt.srcId);

        const verdict = judge({
            res,
            srcId: pkt.srcId,
            expectedNonce: pending?.nonce ?? null,
            known: this.identities.get(pkt.srcId) ?? null,
            now: Date.now(),
        });
        await this.setIdentity(verdict);

        this.note({
            kind: verdict.state === 'failed' || verdict.state === 'mismatch' ? 'dropped' : 'received',
            type: 'IDENT_RES',
            srcId: pkt.srcId,
            dstId: this.identity.id,
            peer: peerIdOf(pkt.srcId),
            detail: `${verdict.name}: ${verdict.detail}`,
        });
    }

    /* ------------------------- store and forward --------------------- */

    /**
     * Park a packet whose destination is unreachable right now.
     *
     * This is the delay-tolerant half of the design and the reason a phone can
     * walk out of range mid-query and still get its answer when it walks back.
     * The queue lives in SQLite, so it also survives the app being killed.
     */
    private async park(pkt: Packet, dstId: number): Promise<void> {
        await this.catalog.enqueue(dstId, toBase64(encodePacket(pkt)), OUTBOX_TTL_MS);
        this.queued = await this.catalog.queuedCount();
        this.note({
            kind: 'dropped',
            type: name(pkt.type),
            srcId: pkt.srcId,
            dstId,
            peer: 'local',
            reason: 'no-route',
            detail: 'parked for later',
        });
        this.emitStats();
    }

    private async flushOutbox(dstId?: number): Promise<void> {
        // Called on every beacon from every peer. `queued` is authoritative —
        // it is read from the database at startup and maintained by `park` and
        // by this method — so an empty queue costs nothing rather than two
        // SQLite round trips per peer every three seconds.
        if (this.queued === 0) return;
        const rows = await this.catalog.dueFor(dstId);
        let delivered = 0;
        for (const row of rows) {
            const pkt = decodePacket(fromBase64(row.payload));
            if (!pkt) {
                await this.catalog.dequeue(row.id);
                continue;
            }
            if (this.router.deliverQueued(pkt)) {
                await this.catalog.dequeue(row.id);
                delivered++;
            }
        }
        if (delivered) {
            this.note({
                kind: 'sent',
                type: 'OUTBOX',
                srcId: this.identity.id,
                dstId: dstId ?? 0,
                peer: dstId === undefined ? 'flood' : peerIdOf(dstId),
                detail: `${delivered} parked packet(s) delivered`,
            });
        }
        this.queued = await this.catalog.queuedCount();
        this.emitStats();
    }

    /* ------------------------------ beacons -------------------------- */

    private sendHello(): void {
        const stats = this.catalog.stats();
        const free = Math.max(
            0,
            this.catalog.budget - stats.metaBytes - stats.bodyBytes,
        );
        // The first beacon always floods, so a node that has just joined is
        // known across the mesh immediately rather than after up to nine
        // seconds.
        const flood = this.helloCount % FLOOD_HELLO_EVERY === 0;
        this.helloCount++;

        this.router.send(
            PacketType.HELLO,
            encodeHello({
                caps: (this.hasLlm ? 0b01 : 0) | 0b10,
                known: stats.known,
                stored: stats.stored,
                documents: stats.documents,
                // Self-reported, and that is fine: capacity is the one signal a
                // node is the only authority on. Reliability deliberately is
                // not here — every node measures that itself.
                freeKb: Math.floor(free / 1024),
                name: this.identity.name,
            }),
            BROADCAST,
            flood ? undefined : 1,
        );
    }

    /**
     * Ask each peer we have not heard a catalog from, until it answers.
     *
     * Only ever addressed to a peer that is present right now, so a request is
     * never spent on a node that has already gone; a peer that leaves and comes
     * back is a fresh first contact and starts over.
     */
    private syncCatalogs(): void {
        if (!this.catalogSync.size) return;
        const now = Date.now();
        for (const [nodeId, state] of this.catalogSync) {
            if (!this.peers.has(nodeId)) continue;
            if (state.attempts >= CATALOG_SYNC_ATTEMPTS) {
                this.catalogSync.delete(nodeId);
                continue;
            }
            const due = state.asked
                ? state.asked + CATALOG_SYNC_RETRY_MS
                : state.since + CATALOG_SYNC_DELAY_MS;
            if (now < due) continue;
            state.asked = now;
            state.attempts++;
            this.router.send(
                PacketType.CATALOG_REQ,
                encodeCatalogReq({ sinceSec: 0, max: CATALOG_SYNC_MAX }),
                nodeId,
            );
        }
    }

    private expirePeers(): void {
        const now = Date.now();
        let changed = false;
        for (const [id, peer] of this.peers) {
            const deadline = peer.hops <= 1 ? PEER_TIMEOUT_MS : DISTANT_PEER_TIMEOUT_MS;
            if (peer.lastSeen < now - deadline) {
                this.peers.delete(id);
                // Also forget that it was ever caught up: a peer that dropped
                // before its CATALOG_REQ/CATALOG_RES round trip finished is
                // otherwise marked "synced" forever and never retried, even
                // after it reconnects.
                this.syncedPeers.delete(id);
                this.catalogSync.delete(id);
                this.note({
                    kind: 'dropped',
                    type: 'HELLO',
                    srcId: id,
                    dstId: this.identity.id,
                    peer: peerIdOf(id),
                    reason: 'link-loss',
                    detail: `${peer.name} went quiet`,
                });
                changed = true;
            }
        }
        if (changed) this.emitSoon('peers');
    }

    /** Refreshes the observed reliability shown against each peer. */
    async refreshReliability(): Promise<void> {
        const rows = await this.replicator.peerReliability();
        let changed = false;
        for (const row of rows) {
            const peer = this.peers.get(row.nodeId);
            if (!peer || peer.reliability === row.reliability) continue;
            this.peers.set(row.nodeId, { ...peer, reliability: row.reliability });
            changed = true;
        }
        if (changed) this.emitSoon('peers');
    }

    /* ------------------------------ helpers -------------------------- */

    /**
     * Peers as the router sees them, not as their last beacon happened to land.
     *
     * `hops` comes from the route table rather than from the beacon that
     * created the peer, and the two genuinely disagree. A peer record takes its
     * hop count off whichever HELLO arrived, while the router keeps the *best*
     * route it has seen and drops duplicates — so when a relayed copy of a
     * neighbour's beacon wins the race to the deduplicator, the peer record
     * says two hops about a phone the router has a direct link to. The router
     * decides how a packet actually travels, so it is the authority on the path.
     *
     * But only while it *has* an answer. The route table is deleted the instant
     * a link goes away, because its job is "how do I reach this node right
     * now"; the peer table deliberately keeps a neighbour for PEER_TIMEOUT_MS so
     * a phone that is merely busy is not evicted and every route through it
     * rebuilt. Reading the display straight off the router put those two in
     * disagreement, and BLE links blip constantly — a dropped notification, a
     * reconnect, a retune. Nodes flickered between connected and stranded
     * several times a minute with nothing actually leaving.
     *
     * So the last known path is remembered on the peer and only replaced, never
     * cleared. The peer table's cushion governs how long a node is believed in,
     * which is the one clock that should decide it; when that expires the peer
     * is reaped and takes its stale path with it.
     */
    peerList(): PeerState[] {
        const routes = this.router.getRoutes();
        for (const peer of this.peers.values()) {
            const route = routes.get(peer.nodeId);
            if (!route) continue;
            peer.hops = route.hops;
            peer.via = this.nodeIdOfPeer(route.peerId);
        }
        return [...this.peers.values()]
            .map((peer) => ({ ...peer }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    routes(): Map<number, RouteEntry> {
        return this.router.getRoutes();
    }

    activityLog(): ActivityEvent[] {
        return this.activity;
    }

    /**
     * A live peer believed to hold this body, or 0.
     *
     * Deliberately filtered to peers that are reachable right now: naming a
     * holder that has gone dark sends the asker off to fetch from nobody, and
     * "I do not know who has it" is a more useful answer than a stale one.
     */
    private knownHolder(docId: number): number {
        const claim = this.holderHints.get(docId);
        if (claim === undefined) return 0;
        return this.peers.has(claim) ? claim : 0;
    }

    private nameOf(nodeId: number): string {
        if (!nodeId) return '';
        if (nodeId === this.identity.id) return this.identity.name;
        return this.peers.get(nodeId)?.name ?? hex(nodeId);
    }

    /**
     * Maps a transport peer id back to the node behind it.
     *
     * The route table is the authority — it is built from packets that actually
     * arrived — and the hex fallback covers the window before a node's first
     * beacon has taught us a route, since the BLE transport names links by the
     * unsigned hex of the node id.
     */
    private nodeIdOfPeer(peerId: string): number {
        if (peerId === 'flood' || peerId === 'local') return 0;
        for (const [nodeId, entry] of this.router.getRoutes()) {
            if (entry.peerId === peerId) return nodeId;
        }
        const parsed = parseInt(peerId, 16);
        return Number.isFinite(parsed) ? parsed >>> 0 : 0;
    }

    private note(event: Omit<ActivityEvent, 'at' | 'seq' | 'peerNodeId'>): void {
        this.activity.push({
            seq: ++this.activitySeq,
            at: Date.now(),
            peerNodeId: this.nodeIdOfPeer(event.peer),
            ...event,
        });
        if (this.activity.length > ACTIVITY_CAPACITY) {
            this.activity.splice(0, this.activity.length - ACTIVITY_CAPACITY);
        }
        this.emitSoon('activity');
    }

    private emitStats(): void {
        this.emitSoon('stats');
        this.emitSoon('outbox');
    }

    /**
     * Mark a snapshot as stale and let the next flush publish it.
     *
     * The payload is deliberately *not* captured here — it is read at flush
     * time, so a burst of twenty updates costs one traversal of the current
     * state rather than twenty copies of intermediate states nobody will see.
     */
    private emitSoon(event: CoalescedEvent): void {
        if (this.stopped) return;
        this.dirty.add(event);
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushUi();
        }, UI_COALESCE_MS);
    }

    private flushUi(): void {
        if (!this.dirty.size) return;
        const due = this.dirty;
        this.dirty = new Set();
        if (due.has('peers')) this.emit('peers', this.peerList());
        if (due.has('routes')) this.emit('routes', this.router.getRoutes());
        if (due.has('activity')) this.emit('activity', [...this.activity]);
        if (due.has('stats')) this.emit('stats', { ...this.router.stats, queued: this.queued });
        if (due.has('outbox')) this.emit('outbox', this.queued);
    }

    private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
        for (const cb of this.listeners[event]) (cb as (...a: unknown[]) => void)(...args);
    }
}

/** Re-exported so callers have one import site for "a node and what it needs". */
export type { MeshCatalog };

/** A copy deep enough that React sees a change without sharing mutable state. */
function snapshot(state: QueryState): QueryState {
    return { ...state, hits: state.hits.map((h) => ({ ...h })) };
}

function name(type: number): string {
    return PACKET_TYPE_NAME[type] ?? `type ${type}`;
}

/**
 * A node id in the form the transports use for link ids.
 *
 * Events that name a peer must all name it the same way, whether the name came
 * from the router (which knows links) or from a packet header (which knows
 * nodes). Without this the wire log shows the same phone under two different
 * labels depending on which side of the exchange produced the line.
 */
function peerIdOf(nodeId: number): string {
    return (nodeId >>> 0).toString(16).padStart(8, '0');
}

/**
 * Short label for a node we have a route to but have never been introduced to.
 *
 * The low half of the id, not the high half: ids are 32-bit hashes in
 * production and either end would do, but a hand-assigned id in a test or a
 * demo is a small number whose top four digits are all zero.
 */
function hex(nodeId: number): string {
    return `#${(nodeId & 0xffff).toString(16).padStart(4, '0')}`;
}
