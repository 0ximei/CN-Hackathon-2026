import {
    BROADCAST,
    PACKET_TYPE_NAME,
    PacketType,
    decodeAnnounce,
    decodeDocReq,
    decodeDocRes,
    decodeHello,
    decodeQuery,
    decodeResult,
    encodeAnnounce,
    encodeDocReq,
    encodeDocRes,
    encodeHello,
    encodeQuery,
    encodeResult,
    decodePacket,
    encodePacket,
    hopsTravelled,
    type Hit,
    type MetaEntry,
    type Packet,
} from '@core/protocol/packet';
import { Router, type RouteEntry } from '@core/protocol/router';
import { dequantize, fromWireScore, quantize, toWireScore } from '@core/search/vector';
import type { Identity } from '@core/lib/ids';
import { nextMsgId } from '@core/lib/ids';
import { docKeyOf, parseDocument, type ParsedDoc } from '@core/lib/chunk';
import { normalizeUploadedText } from '@core/lib/textUpload';

import type { Transport } from '@core/transport/Transport';
import type { Scored } from '@core/search/vector';

import type { CatalogStats, StoredChunk } from '../storage/store';
import { embedder } from '../search/embedder';
import { fromBase64, toBase64 } from '../lib/base64';

/**
 * What the orchestrator needs from a radio.
 *
 * `Transport` plus one optional extra: BLE has a running commentary worth
 * surfacing — dialling, MTU negotiation, links lost — that the other transports
 * have no equivalent for, so it is optional rather than part of the interface
 * every radio must satisfy.
 */
export type MeshTransport = Transport & {
    onLog?(cb: (line: string) => void): () => void;
};

/**
 * What the orchestrator needs from storage.
 *
 * Narrower than `LocalCatalog` on purpose. Depending on the concrete class
 * would drag expo-sqlite into every place a node is constructed, including the
 * tests, and the routing behaviour worth testing has nothing to do with which
 * database is underneath.
 */
export interface MeshCatalog {
    search(queryVec: Float32Array, queryText: string, k: number): Scored[];
    chunk(docId: number): StoredChunk | undefined;
    chunksOf(docKey: number): StoredChunk[];
    snippet(docId: number): string;
    stats(): CatalogStats;
    ingestDoc(
        doc: ParsedDoc,
        filter: ((docId: number) => boolean) | undefined,
        provenance: 'seed' | 'local',
    ): Promise<number>;
    ingestRemote(chunk: Omit<StoredChunk, 'provenance'>): Promise<boolean>;
    reload(): Promise<void>;
    enqueue(dstId: number, payload: string, ttlMs: number): Promise<void>;
    dueFor(dstId?: number): Promise<{ id: number; dstId: number; payload: string }[]>;
    dequeue(id: number): Promise<void>;
    queuedCount(): Promise<number>;
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
 * them on the direct-link deadline would evict every one of them between
 * floods and make the mesh look like it kept losing half its nodes.
 */
const DISTANT_PEER_TIMEOUT_MS = 45_000;

/**
 * Flood every third beacon; send the rest one hop.
 *
 * A beacon has two jobs and they want different reach. Liveness is a statement
 * about a link and must be fast, and flooding it every three seconds would put
 * N x N packets on a radio that moves a few kilobytes a second. Identity — who
 * is out there and what they are called — is needed mesh-wide but changes
 * rarely, so it can travel at a third of the rate. Without it, a node two hops
 * away has a route and a node id but no name, and its results come back
 * attributed to a hex number.
 */
const FLOOD_HELLO_EVERY = 3;

/**
 * How long to wait for the mesh before answering.
 *
 * Much longer than the browser build's window, because this radio is genuinely
 * slow. A BLE link with a negotiated 517-byte MTU moves a few kilobytes a
 * second in practice, and a two-hop reply has to be received, re-encoded and
 * re-transmitted by a phone in the middle. Cutting this short does not make the
 * answer arrive faster — it just drops the far half of the mesh.
 */
const COLLECT_WINDOW_MS = 6_000;

/** Stop waiting once every peer we know about has replied. */
const EARLY_EXIT_GRACE_MS = 400;

const HITS_PER_NODE = 4;
const DOC_FETCH_TIMEOUT_MS = 8_000;
const OUTBOX_TTL_MS = 5 * 60 * 1000;
const OUTBOX_RETRY_MS = 5_000;
const ACTIVITY_CAPACITY = 200;

export interface PeerState {
    nodeId: number;
    name: string;
    known: number;
    documents: number;
    lastSeen: number;
    hops: number;
}

export interface MeshHit {
    docId: number;
    score: number;
    title: string;
    section: string;
    snippet: string;
    /** Full passage, once fetched. Undefined means only the snippet is held. */
    text?: string;
    /** The node that matched it. */
    fromNodeId: number;
    fromNodeName: string;
    /** A node believed to hold the passage, 0 when unknown. */
    holderId: number;
    holderName: string;
    hops: number;
    local: boolean;
    /** True when this node itself holds the body, making it retrievable without a network fetch. */
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
}

export interface ActivityEvent {
    at: number;
    kind: 'sent' | 'recv' | 'forward' | 'drop' | 'radio';
    label: string;
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
    /** The catalog changed — this node's own upload, or content pulled from a peer. */
    catalog(stats: CatalogStats): void;
};

/** Chunk metadata entries per ANNOUNCE packet. Matches the web build's batch size. */
const ENTRIES_PER_ANNOUNCE = 4;

/** How much of a chunk rides in an ANNOUNCE entry, before the body itself is pulled. */
const ANNOUNCE_SNIPPET_CHARS = 200;

/**
 * The application protocol, over whatever radio is mounted.
 *
 * Structurally this is the browser build's `MeshNode` with the storage tier
 * simplified. There is no metadata/body split and no popularity-weighted
 * partial replication the way the web build's `Replicator` does it — no
 * eviction, no storage-pressure policy, no periodic reconcile timer. What
 * exists instead is flood-and-pull: an upload gossips its chunk metadata once
 * via ANNOUNCE, and any node that hears about a chunk it doesn't hold pulls
 * the body and keeps it, permanently. That is a real, intentional scope cut —
 * fine for a mesh sized at a handful of phones and documents, not something
 * that would hold up at web-scale library sizes. What is unchanged — and is
 * the point — is everything below it. The packet codec, the flooding router
 * with its TTL and dedup LRU, the backward-learned unicast routes and the
 * store-and-forward queue are the same modules the web app uses and the same
 * ones its test suite covers.
 */
export class MeshNode {
    private router: Router;
    private helloTimer: ReturnType<typeof setInterval> | null = null;
    private outboxTimer: ReturnType<typeof setInterval> | null = null;
    private peers = new Map<number, PeerState>();
    private queries = new Map<number, QueryState>();
    private pendingDocs = new Map<number, (payload: { text: string; source: string } | null) => void>();
    private activity: ActivityEvent[] = [];
    private queued = 0;
    private helloCount = 0;
    private listeners: { [K in keyof Events]: Set<Events[K]> } = {
        peers: new Set(),
        query: new Set(),
        activity: new Set(),
        stats: new Set(),
        routes: new Set(),
        catalog: new Set(),
    };
    private unsubscribes: (() => void)[] = [];

    constructor(
        readonly identity: Identity,
        private transport: MeshTransport,
        private catalog: MeshCatalog,
    ) {
        this.router = new Router({
            nodeId: identity.id,
            transport,
            onUndeliverable: (pkt, dstId) => void this.park(pkt, dstId),
        });
    }

    /* --------------------------- lifecycle --------------------------- */

    async start(): Promise<void> {
        await this.transport.start();
        this.router.start();

        this.unsubscribes.push(
            this.router.on('deliver', (pkt) => void this.onPacket(pkt)),
            this.router.on('forwarded', (pkt, to) =>
                this.note('forward', `${name(pkt.type)} -> ${to === 'flood' ? 'all' : short(to)}`),
            ),
            this.router.on('dropped', (pkt, reason) =>
                this.note('drop', `${pkt ? name(pkt.type) : 'frame'}: ${reason}`),
            ),
            this.router.on('sent', (pkt, to) =>
                this.note('sent', `${name(pkt.type)} -> ${to === 'flood' ? 'all' : short(to)}`),
            ),
            this.router.on('routesChanged', (routes) => this.emit('routes', routes)),
        );
        const offLog = this.transport.onLog?.((line) => this.note('radio', line));
        if (offLog) this.unsubscribes.push(offLog);

        this.sendHello();
        this.helloTimer = setInterval(() => {
            this.sendHello();
            this.expirePeers();
        }, HELLO_INTERVAL_MS);
        this.outboxTimer = setInterval(() => void this.flushOutbox(), OUTBOX_RETRY_MS);
    }

    stop(): void {
        if (this.helloTimer) clearInterval(this.helloTimer);
        if (this.outboxTimer) clearInterval(this.outboxTimer);
        this.helloTimer = null;
        this.outboxTimer = null;
        for (const off of this.unsubscribes) off();
        this.unsubscribes = [];
        this.router.stop();
        this.transport.stop();
        this.peers.clear();
        this.emit('peers', []);
    }

    on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
        this.listeners[event].add(cb);
        return () => this.listeners[event].delete(cb);
    }

    /* ----------------------------- upload ---------------------------- */

    /** Ingests a document here and gossips its metadata to the mesh. */
    async upload(filename: string, raw: string): Promise<void> {
        const text = normalizeUploadedText(raw);
        if (!text) throw new Error(`${filename} has no readable text`);
        const parsed = parseDocument(filename, text);
        if (!parsed.chunks.length) throw new Error(`${filename} has no readable text`);

        const body = parsed.chunks.map((c) => c.text).join('\n');
        const docKey = docKeyOf(parsed.title, body);

        await this.catalog.ingestDoc(parsed, undefined, 'local');
        await this.catalog.reload();
        this.emit('catalog', this.catalog.stats());

        await this.announce(docKey);
    }

    /**
     * Broadcasts one document's chunk metadata so the mesh learns it exists.
     *
     * A one-shot flood, not a recurring reconcile pass — an upload's worth of
     * ANNOUNCE packets is a brief burst well inside the radio's real throughput,
     * unlike re-announcing the whole catalog on a timer.
     */
    private async announce(docKey: number): Promise<void> {
        const chunks = this.catalog.chunksOf(docKey);
        if (!chunks.length) return;

        const docBytes = chunks.reduce((n, c) => n + c.text.length, 0);
        const createdAtSec = Math.floor(Date.now() / 1000);

        for (let i = 0; i < chunks.length; i += ENTRIES_PER_ANNOUNCE) {
            const batch = chunks.slice(i, i + ENTRIES_PER_ANNOUNCE);
            const entries: MetaEntry[] = batch.map((c) => {
                const { q, scale } = quantize(embedder.embed(c.text));
                return {
                    docId: c.docId,
                    seq: c.seq,
                    version: 1,
                    section: c.section,
                    snippet: c.text.slice(0, ANNOUNCE_SNIPPET_CHARS),
                    bytes: c.text.length,
                    originId: this.identity.id,
                    scale,
                    vec: q,
                    holders: [this.identity.id],
                    hits: 0,
                };
            });

            this.router.send(
                PacketType.ANNOUNCE,
                encodeAnnounce({
                    docKey,
                    title: chunks[0].title,
                    source: chunks[0].source,
                    docBytes,
                    chunkCount: chunks.length,
                    docOriginId: this.identity.id,
                    createdAtSec,
                    entries,
                }),
                BROADCAST,
            );
        }
    }

    /* ----------------------------- search ---------------------------- */

    /**
     * Search this node and everything it can reach.
     *
     * Local results are available before the first packet leaves, so the UI has
     * something to show immediately; mesh results merge in as they arrive and the
     * promise resolves when the collection window closes.
     */
    async search(text: string): Promise<QueryState> {
        const queryId = nextMsgId();
        const vector = embedder.embed(text);

        const state: QueryState = {
            queryId,
            text,
            hits: this.localHits(vector, text).map((hit) => ({
                ...hit,
                fromNodeId: this.identity.id,
                fromNodeName: this.identity.name,
                holderId: this.identity.id,
                holderName: this.identity.name,
                hops: 0,
                local: true,
                storedHere: true,
            })),
            startedAt: Date.now(),
            answered: [],
        };
        this.queries.set(queryId, state);
        this.emit('query', state);

        const { q, scale } = quantize(vector);
        this.router.send(
            PacketType.QUERY,
            encodeQuery({ queryId, topK: HITS_PER_NODE, scale, vec: q, text: text.slice(0, 200) }),
        );

        await this.collect(state);
        return state;
    }

    /**
     * Wait out the collection window, but not pointlessly.
     *
     * If everyone we know about has answered there is nothing left to wait for,
     * so the window closes early after a short grace — long enough for a reply
     * that is one hop behind, short enough to feel immediate. A node with no
     * peers at all resolves almost instantly rather than staring at a timer.
     */
    private collect(state: QueryState): Promise<void> {
        return new Promise((resolve) => {
            const finish = () => {
                clearInterval(poll);
                clearTimeout(deadline);
                state.finishedAt = Date.now();
                state.hits.sort((a, b) => b.score - a.score);
                this.emit('query', state);
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

    private localHits(vector: Float32Array, text: string): Omit<MeshHit, 'fromNodeId' | 'fromNodeName' | 'holderId' | 'holderName' | 'hops' | 'local'>[] {
        return this.catalog.search(vector, text, HITS_PER_NODE).map((scored) => {
            const chunk = this.catalog.chunk(scored.docId);
            return {
                docId: scored.docId,
                score: scored.score,
                title: chunk?.title ?? '',
                section: chunk?.section ?? '',
                snippet: this.catalog.snippet(scored.docId),
                text: chunk?.text, storedHere: true,
            };
        });
    }

    /**
     * Pull the full passage behind a hit.
     *
     * Snippets ride inside RESULT packets because a passage would not fit — a
     * RESULT with four 1 KB bodies is 4 KB of radio time per answering node, most
     * of it for hits the user will never open. The body is fetched only when it
     * is actually wanted, and from a node that holds it rather than necessarily
     * the one that answered.
     */
    async fetchFullText(hit: MeshHit): Promise<string> {
        if (hit.text) return hit.text;

        const local = this.catalog.chunk(hit.docId);
        if (local) return local.text;

        const target = hit.holderId && hit.holderId !== this.identity.id ? hit.holderId : hit.fromNodeId;
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
            if (touched) this.emit('query', { ...state, hits: [...state.hits] });
        }
        return reply.text;
    }

    /** Sends a DOC_REQ to `target` and waits for the matching DOC_RES, or null on timeout. */
    private requestDoc(docId: number, target: number): Promise<{ text: string; source: string } | null> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingDocs.delete(docId);
                resolve(null);
            }, DOC_FETCH_TIMEOUT_MS);

            this.pendingDocs.set(docId, (payload) => {
                clearTimeout(timer);
                this.pendingDocs.delete(docId);
                resolve(payload);
            });

            this.router.send(PacketType.DOC_REQ, encodeDocReq(docId), target);
        });
    }

    /* --------------------------- packet handling --------------------- */

    private async onPacket(pkt: Packet): Promise<void> {
        this.note('recv', `${name(pkt.type)} from ${hex(pkt.srcId)} (${hopsTravelled(pkt)}h)`);

        switch (pkt.type) {
            case PacketType.HELLO:
                return this.onHello(pkt);
            case PacketType.QUERY:
                return this.onQuery(pkt);
            case PacketType.RESULT:
                return this.onResult(pkt);
            case PacketType.DOC_REQ:
                return this.onDocReq(pkt);
            case PacketType.DOC_RES:
                return this.onDocRes(pkt);
            case PacketType.ANNOUNCE:
                return this.onAnnounce(pkt);
            default:
                break;
        }
        this.emitStats();
    }

    private onHello(pkt: Packet): void {
        const hello = decodeHello(pkt.payload);
        const known = this.peers.get(pkt.srcId);
        this.peers.set(pkt.srcId, {
            nodeId: pkt.srcId,
            name: hello.name,
            known: hello.known,
            documents: hello.documents,
            lastSeen: Date.now(),
            hops: hopsTravelled(pkt),
        });
        if (!known) this.note('recv', `${hello.name} joined`);
        this.emit('peers', this.peerList());
        // A beacon is proof of reachability, which is exactly the trigger anything
        // parked for that node has been waiting on.
        void this.flushOutbox(pkt.srcId);
    }

    private onQuery(pkt: Packet): void {
        const query = decodeQuery(pkt.payload);
        const vector = dequantize(query.vec, query.scale);
        const scored = this.catalog.search(vector, query.text, query.topK || HITS_PER_NODE);

        // Answering with nothing still costs a packet and a slot in the asker's
        // early-exit check, and staying silent would make it wait the full window.
        const hits: Hit[] = scored.map((s) => ({
            docId: s.docId,
            score: toWireScore(s.score),
            title: this.catalog.chunk(s.docId)?.title ?? '',
            snippet: this.catalog.snippet(s.docId),
            holderId: this.identity.id,
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

        if (!state.answered.includes(pkt.srcId)) state.answered.push(pkt.srcId);
        const peer = this.peers.get(pkt.srcId);
        const hops = hopsTravelled(pkt);

        for (const hit of result.hits) {
            const existing = state.hits.find((h) => h.docId === hit.docId);
            const score = fromWireScore(hit.score);
            if (existing) {
                // The same passage can come back from several nodes. Keep the best
                // score, and prefer the shortest path for the fetch that may follow.
                if (score > existing.score) existing.score = score;
                if (hops < existing.hops) {
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
        this.emit('query', { ...state, hits: [...state.hits] });
    }

    private onDocReq(pkt: Packet): void {
        const { docId } = decodeDocReq(pkt.payload);
        const chunk = this.catalog.chunk(docId);
        this.router.send(
            PacketType.DOC_RES,
            encodeDocRes({
                docId,
                title: chunk?.title ?? '',
                section: chunk?.section ?? '',
                // An empty body is a real answer: "I was named as a holder and I am
                // not one". Silence would leave the asker waiting out the full timeout.
                text: chunk?.text ?? '',
                source: chunk?.source ?? '',
            }),
            pkt.srcId,
        );
    }

    private onDocRes(pkt: Packet): void {
        const doc = decodeDocRes(pkt.payload);
        this.pendingDocs.get(doc.docId)?.({ text: doc.text, source: doc.source });
    }

    /**
     * A peer gossiped chunk metadata. Pull the body for anything not already
     * held — this node's half of flood-and-pull replication.
     */
    private async onAnnounce(pkt: Packet): Promise<void> {
        const payload = decodeAnnounce(pkt.payload);
        const missing = payload.entries.filter((e) => !this.catalog.chunk(e.docId));
        if (!missing.length) return;

        let pulled = 0;
        for (const entry of missing) {
            const reply = await this.requestDoc(entry.docId, pkt.srcId);
            if (!reply?.text) continue;
            const wrote = await this.catalog.ingestRemote({
                docId: entry.docId,
                docKey: payload.docKey,
                seq: entry.seq,
                title: payload.title,
                section: entry.section,
                source: reply.source || payload.source,
                text: reply.text,
            });
            if (wrote) pulled++;
        }

        if (pulled) {
            await this.catalog.reload();
            this.emit('catalog', this.catalog.stats());
            this.note('recv', `pulled ${pulled} passage(s) of "${payload.title}"`);
        }
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
        this.note('drop', `${name(pkt.type)} for ${hex(dstId)} parked`);
        this.emitStats();
    }

    private async flushOutbox(dstId?: number): Promise<void> {
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
        if (delivered) this.note('sent', `${delivered} parked packet(s) delivered`);
        this.queued = await this.catalog.queuedCount();
        this.emitStats();
    }

    /* ------------------------------ beacons -------------------------- */

    private sendHello(): void {
        const stats = this.catalog.stats();
        // The first beacon always floods, so a node that has just joined is known
        // across the mesh immediately rather than after up to nine seconds.
        const flood = this.helloCount % FLOOD_HELLO_EVERY === 0;
        this.helloCount++;

        this.router.send(
            PacketType.HELLO,
            encodeHello({
                caps: 0b10,
                known: stats.chunks,
                stored: stats.chunks,
                documents: stats.documents,
                freeKb: 0,
                name: this.identity.name,
            }),
            BROADCAST,
            flood ? undefined : 1,
        );
    }

    private expirePeers(): void {
        const now = Date.now();
        let changed = false;
        for (const [id, peer] of this.peers) {
            const deadline = peer.hops <= 1 ? PEER_TIMEOUT_MS : DISTANT_PEER_TIMEOUT_MS;
            if (peer.lastSeen < now - deadline) {
                this.peers.delete(id);
                this.note('drop', `${peer.name} went quiet`);
                changed = true;
            }
        }
        if (changed) this.emit('peers', this.peerList());
    }

    /* ------------------------------ helpers -------------------------- */

    peerList(): PeerState[] {
        return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    routes(): Map<number, RouteEntry> {
        return this.router.getRoutes();
    }

    activityLog(): ActivityEvent[] {
        return this.activity;
    }

    private nameOf(nodeId: number): string {
        if (!nodeId) return '';
        if (nodeId === this.identity.id) return this.identity.name;
        return this.peers.get(nodeId)?.name ?? hex(nodeId);
    }

    private note(kind: ActivityEvent['kind'], label: string): void {
        this.activity.push({ at: Date.now(), kind, label });
        if (this.activity.length > ACTIVITY_CAPACITY) {
            this.activity.splice(0, this.activity.length - ACTIVITY_CAPACITY);
        }
        this.emit('activity', [...this.activity]);
    }

    private emitStats(): void {
        this.emit('stats', { ...this.router.stats, queued: this.queued });
    }

    private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
        for (const cb of this.listeners[event]) (cb as (...a: unknown[]) => void)(...args);
    }
}

function name(type: number): string {
    return PACKET_TYPE_NAME[type] ?? `type ${type}`;
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

function short(peerId: string): string {
    return `#${peerId.slice(0, 4)}`;
}
