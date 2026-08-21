/**
 * MeshNode — the orchestrator.
 *
 * Owns the transport, the router, the store-and-forward queue, this node's
 * catalog and its replicator, and implements the application protocol on top:
 *
 *   search(text)
 *     -> embed locally
 *     -> search the local catalog immediately
 *     -> flood QUERY carrying a 388-byte int8 embedding
 *     -> peers search their own catalogs and unicast RESULT back along the
 *        route the query taught them, each naming a node that holds the body
 *     -> collect for a window, merge, dedupe, rerank
 *     -> pull full text on demand with DOC_REQ, from a *holder* rather than
 *        necessarily from whoever answered
 *
 * The last point is the structural change from a sharded design. A node can
 * answer "this passage is relevant" from metadata it holds without holding the
 * passage itself, so the node that finds something and the node that can serve
 * it are frequently different machines.
 */

import {
  BROADCAST,
  PACKET_TYPE_NAME,
  PacketType,
  decodeAnnounce,
  decodeCatalogReq,
  decodeDocReq,
  decodeDocRes,
  decodeHello,
  decodeQuery,
  decodeResult,
  encodeAnnounce,
  encodeCatalogReq,
  encodeDocReq,
  encodeDocRes,
  encodeHello,
  encodeQuery,
  encodeResult,
  type AnnouncePayload,
  type Packet,
} from './packet';
import { Router, type DropReason, type RouteEntry } from './router';
import { StoreForward } from './storeForward';
import type { Transport } from '../transport/Transport';
import type { Identity } from '../lib/ids';
import { catalog } from '../search/catalog';
import { db } from '../search/db';
import { embedder } from '../search/embedder';
import { Replicator, type ReplicationStats } from '../replication/Replicator';
import { dequantize, fromWireScore, quantize, toWireScore } from '../search/vector';

const HELLO_INTERVAL_MS = 3000;
const PEER_TIMEOUT_MS = 12_000;
/**
 * How long to wait for the mesh before answering.
 *
 * Generous on purpose. Browsers throttle timers and rendering in background
 * tabs, and a two-hop reply has to be processed by an intermediate node that
 * may be one of those. A window tuned to a foreground round-trip produced
 * "not in the mesh" for queries whose answer landed 100ms later.
 */
const COLLECT_WINDOW_MS = 5000;

/** Stop waiting early once every peer we know about has answered. */
const EARLY_EXIT_GRACE_MS = 250;
const HITS_PER_NODE = 4;

/** Entries a joining node will accept in one anti-entropy burst. */
const CATALOG_SYNC_MAX = 400;

export interface PeerState {
  nodeId: number;
  name: string;
  /** Chunks this peer has metadata for — what it can search. */
  known: number;
  /** Chunks this peer holds the body of — what it can serve. */
  stored: number;
  documents: number;
  freeBytes: number;
  hasLlm: boolean;
  hops: number;
  lastSeen: number;
  /** Locally observed, 0..1. Refreshed from the replicator each pass. */
  reliability: number;
}

export interface MeshHit {
  docId: number;
  /** Cosine similarity, comparable across nodes because the model is shared. */
  score: number;
  title: string;
  section: string;
  snippet: string;
  /** Full passage, present once DOC_RES has come back (always set for local). */
  text?: string;
  /** Node that answered — it knows about this passage. */
  fromNodeId: number;
  fromNodeName: string;
  /** Node that can serve the body. Often not the one that answered. */
  holderId: number;
  hops: number;
  local: boolean;
  /** True when this node holds the body itself. */
  storedHere: boolean;
}

export interface QueryState {
  queryId: number;
  text: string;
  hits: MeshHit[];
  respondedNodeIds: number[];
  startedAt: number;
  /** Set when the collection window closes. */
  finishedAt?: number;
}

export interface ActivityEvent {
  at: number;
  kind: 'sent' | 'forwarded' | 'received' | 'dropped' | 'replicated' | 'evicted';
  type: string;
  srcId: number;
  dstId: number;
  peer: string;
  reason?: DropReason;
  detail?: string;
}

export interface MeshEvents {
  peers(peers: PeerState[]): void;
  activity(ev: ActivityEvent): void;
  query(state: QueryState): void;
  routes(routes: Map<number, RouteEntry>): void;
  outbox(queued: number): void;
  replication(stats: ReplicationStats): void;
  catalog(): void;
}

export class MeshNode {
  readonly identity: Identity;
  readonly router: Router;
  readonly transport: Transport;
  readonly storeForward: StoreForward;
  readonly replicator: Replicator;

  private peersById = new Map<number, PeerState>();
  private queries = new Map<number, QueryState>();
  /** Multiple callers can wait on the same body; each gets its own resolver. */
  private docWaiters = new Map<number, ((text: string | null) => void)[]>();
  private syncedPeers = new Set<number>();
  private helloTimer: number | null = null;
  private peerTimer: number | null = null;
  private queryCounter = 1;
  private freeBytes = 0;

  /** Set by the dev panel; feeds the router's simulated link loss. */
  packetLoss = 0;
  hasLlm = false;

  private listeners: { [K in keyof MeshEvents]: Set<MeshEvents[K]> } = {
    peers: new Set(),
    activity: new Set(),
    query: new Set(),
    routes: new Set(),
    outbox: new Set(),
    replication: new Set(),
    catalog: new Set(),
  };

  constructor(identity: Identity, transport: Transport) {
    this.identity = identity;
    this.transport = transport;

    this.router = new Router({
      nodeId: identity.id,
      transport,
      lossRate: () => this.packetLoss,
      onUndeliverable: (pkt, dstId) => {
        // The asker has gone offline. Hold the answer instead of losing it.
        void this.storeForward.enqueue(pkt, dstId);
      },
    });

    this.storeForward = new StoreForward(this.router, (queued) => this.emit('outbox', queued));

    this.replicator = new Replicator({
      selfId: identity.id,
      catalog,
      livePeers: () =>
        [...this.peersById.values()].map((p) => ({
          nodeId: p.nodeId,
          freeBytes: p.freeBytes,
        })),
      announce: (payload, dstId) => this.sendAnnounce(payload, dstId),
      fetchBody: (docId, from) => this.requestDoc(docId, from, 6000),
      onStats: (s) => {
        this.emit('replication', s);
        void this.refreshReliability();
      },
      onEvent: (e) =>
        this.emit('activity', {
          at: Date.now(),
          kind: e.kind === 'pull' ? 'replicated' : 'evicted',
          type: e.kind === 'pull' ? 'BODY' : 'EVICT',
          srcId: identity.id,
          dstId: 0,
          peer: e.title,
          detail: e.detail,
        }),
    });

    catalog.onChange = () => this.emit('catalog');

    this.router.on('deliver', (pkt, fromPeer) => this.handle(pkt, fromPeer));
    this.router.on('sent', (pkt, to) => this.trace('sent', pkt, String(to)));
    this.router.on('forwarded', (pkt, to) => this.trace('forwarded', pkt, String(to)));
    this.router.on('dropped', (pkt, reason, from) => {
      if (pkt) this.trace('dropped', pkt, from, reason);
    });
    this.router.on('routesChanged', (routes) => {
      this.emit('routes', routes);
      void this.storeForward.flush();
    });
  }

  async start() {
    await this.transport.start();
    this.router.start();
    this.storeForward.start();

    this.sendHello();
    this.helloTimer = setInterval(() => this.sendHello(), HELLO_INTERVAL_MS) as unknown as number;
    this.peerTimer = setInterval(() => this.reapPeers(), HELLO_INTERVAL_MS) as unknown as number;
  }

  /** Starts replication. Separate from start() because it needs a live catalog. */
  startReplication() {
    this.replicator.start();
  }

  stop() {
    if (this.helloTimer !== null) clearInterval(this.helloTimer);
    if (this.peerTimer !== null) clearInterval(this.peerTimer);
    this.replicator.stop();
    this.storeForward.stop();
    this.router.stop();
    this.transport.stop();
    catalog.onChange = undefined;
  }

  on<K extends keyof MeshEvents>(event: K, cb: MeshEvents[K]): () => void {
    this.listeners[event].add(cb);
    return () => void this.listeners[event].delete(cb);
  }

  private emit<K extends keyof MeshEvents>(event: K, ...args: Parameters<MeshEvents[K]>) {
    for (const cb of this.listeners[event]) (cb as (...a: unknown[]) => void)(...args);
  }

  private trace(kind: ActivityEvent['kind'], pkt: Packet, peer: string, reason?: DropReason) {
    this.emit('activity', {
      at: Date.now(),
      kind,
      type: PACKET_TYPE_NAME[pkt.type] ?? String(pkt.type),
      srcId: pkt.srcId,
      dstId: pkt.dstId,
      peer,
      reason,
    });
  }

  peers(): PeerState[] {
    return [...this.peersById.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ---------------- beacons ---------------- */

  private sendHello() {
    const caps = (catalog.ready ? 0b10 : 0) | (this.hasLlm ? 0b01 : 0);
    // Cached rather than awaited: HELLO fires on a timer and a storage estimate
    // is slow enough that awaiting it here would skew the beacon interval.
    void catalog.usage().then((u) => (this.freeBytes = u.freeBytes));

    this.router.send(
      PacketType.HELLO,
      encodeHello({
        caps,
        known: catalog.knownCount,
        stored: catalog.storedCount,
        documents: catalog.status.documents,
        freeKb: Math.floor(this.freeBytes / 1024),
        name: this.identity.name,
      }),
      BROADCAST,
      // Beacons are deliberately short-range: peers beyond two hops are
      // discovered through the routes their traffic teaches us instead.
      2,
    );
  }

  private reapPeers() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    let changed = false;
    for (const [id, peer] of this.peersById) {
      if (peer.lastSeen < cutoff) {
        this.peersById.delete(id);
        this.syncedPeers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.peers());
  }

  private async refreshReliability() {
    const rows = await this.replicator.peerReliability();
    let changed = false;
    for (const r of rows) {
      const peer = this.peersById.get(r.nodeId);
      if (peer && Math.abs(peer.reliability - r.reliability) > 0.005) {
        peer.reliability = r.reliability;
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.peers());
  }

  /* ---------------- inbound application logic ---------------- */

  private handle(pkt: Packet, fromPeer: string | null) {
    this.trace('received', pkt, fromPeer ?? 'local');

    switch (pkt.type) {
      case PacketType.HELLO:
        return this.onHello(pkt);
      case PacketType.QUERY:
        return this.onQuery(pkt);
      case PacketType.RESULT:
        return this.onResult(pkt);
      case PacketType.DOC_REQ:
        return void this.onDocReq(pkt);
      case PacketType.DOC_RES:
        return this.onDocRes(pkt);
      case PacketType.ANNOUNCE:
      case PacketType.CATALOG_RES:
        return void this.onAnnounce(pkt);
      case PacketType.CATALOG_REQ:
        return void this.onCatalogReq(pkt);
    }
  }

  private onHello(pkt: Packet) {
    const hello = decodeHello(pkt.payload);
    const hops = this.router.getRoutes().get(pkt.srcId)?.hops ?? 1;
    const existing = this.peersById.get(pkt.srcId);
    const freeBytes = hello.freeKb * 1024;

    this.peersById.set(pkt.srcId, {
      nodeId: pkt.srcId,
      name: hello.name,
      known: hello.known,
      stored: hello.stored,
      documents: hello.documents,
      freeBytes,
      hasLlm: (hello.caps & 0b01) !== 0,
      hops,
      lastSeen: Date.now(),
      reliability: existing?.reliability ?? 0.5,
    });

    void this.replicator.noteHello(pkt.srcId, freeBytes);

    if (!existing) {
      this.emit('peers', this.peers());
      // A peer we could not reach may now be reachable — retry held answers.
      void this.storeForward.flush(pkt.srcId);
      // ...and we have never synced catalogs with it.
      if (!this.syncedPeers.has(pkt.srcId)) {
        this.syncedPeers.add(pkt.srcId);
        this.router.send(
          PacketType.CATALOG_REQ,
          encodeCatalogReq({ sinceSec: 0, max: CATALOG_SYNC_MAX }),
          pkt.srcId,
        );
      }
    } else if (
      existing.known !== hello.known ||
      existing.stored !== hello.stored ||
      existing.hops !== hops
    ) {
      this.emit('peers', this.peers());
    }
  }

  /** A peer asked the mesh a question. Search our catalog and reply. */
  private onQuery(pkt: Packet) {
    if (!catalog.ready) return;

    const q = decodeQuery(pkt.payload);
    // The vector arrives quantized; dequantizing re-normalizes it so the
    // cosine scores are directly comparable with the asker's own.
    const vec = dequantize(q.vec, q.scale);

    const hits = catalog.searchLocal(vec, Math.min(q.topK, HITS_PER_NODE), q.text);
    if (!hits.length) return;

    // Answering counts as an access: a chunk that keeps winning searches is
    // what "popular" means here, and popularity buys replicas.
    void this.replicator.recordHit(hits.map((h) => h.docId));

    void (async () => {
      const holders = await this.holdersFor(hits.map((h) => h.docId));
      this.router.send(
        PacketType.RESULT,
        encodeResult({
          queryId: q.queryId,
          hopCount: this.router.getRoutes().get(pkt.srcId)?.hops ?? 1,
          hits: hits.map((h) => ({
            docId: h.docId,
            score: toWireScore(h.score),
            holderId: h.hasBody ? this.identity.id : (holders.get(h.docId) ?? 0),
            title: h.meta.title,
            snippet: `${h.meta.section}: ${h.meta.snippet}`.slice(0, 200),
          })),
        }),
        pkt.srcId,
      );
    })();
  }

  /** Picks one live holder per chunk, preferring ourselves. */
  private async holdersFor(docIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const live = new Set([this.identity.id, ...this.peersById.keys()]);
    const rows = await db().holders.toArray();
    for (const r of rows) {
      if (!docIds.includes(r.docId) || !live.has(r.nodeId)) continue;
      if (!out.has(r.docId) || r.nodeId === this.identity.id) out.set(r.docId, r.nodeId);
    }
    return out;
  }

  private onResult(pkt: Packet) {
    const res = decodeResult(pkt.payload);
    const state = this.queries.get(res.queryId);
    if (!state) return; // window already closed, or not our query

    const peer = this.peersById.get(pkt.srcId);
    const name = peer?.name ?? `#${pkt.srcId.toString(16).slice(0, 4)}`;

    for (const hit of res.hits) {
      const existing = state.hits.find((h) => h.docId === hit.docId);
      if (existing) {
        // The same passage legitimately lives on several nodes now. Keep the
        // first answer but remember a holder if this one named a better route.
        if (!existing.holderId && hit.holderId) existing.holderId = hit.holderId;
        continue;
      }
      const [section, ...rest] = hit.snippet.split(': ');
      state.hits.push({
        docId: hit.docId,
        score: fromWireScore(hit.score),
        title: hit.title,
        section: rest.length ? section : '',
        snippet: rest.length ? rest.join(': ') : hit.snippet,
        fromNodeId: pkt.srcId,
        fromNodeName: name,
        holderId: hit.holderId || pkt.srcId,
        hops: res.hopCount,
        local: false,
        storedHere: catalog.holdsBody(hit.docId),
      });
    }

    if (!state.respondedNodeIds.includes(pkt.srcId)) state.respondedNodeIds.push(pkt.srcId);
    state.hits.sort((a, b) => b.score - a.score);
    this.emit('query', { ...state, hits: [...state.hits] });
  }

  private async onDocReq(pkt: Packet) {
    const { docId } = decodeDocReq(pkt.payload);
    const meta = catalog.getMeta(docId);
    const text = await catalog.getBody(docId);
    // Answer even when we do not have the body: an empty text tells the asker
    // to stop waiting and try another holder, where silence would cost it the
    // full timeout before it learned anything.
    this.router.send(
      PacketType.DOC_RES,
      encodeDocRes({
        docId,
        title: meta?.title ?? '',
        section: meta?.section ?? '',
        text: text ?? '',
        source: '',
      }),
      pkt.srcId,
    );
  }

  private onDocRes(pkt: Packet) {
    const doc = decodeDocRes(pkt.payload);
    void this.replicator.noteResponse(pkt.srcId);

    const waiters = this.docWaiters.get(doc.docId);
    if (waiters) {
      this.docWaiters.delete(doc.docId);
      for (const w of waiters) w(doc.text || null);
    }

    if (!doc.text) return;
    for (const state of this.queries.values()) {
      const hit = state.hits.find((h) => h.docId === doc.docId);
      if (hit) {
        hit.text = doc.text;
        if (doc.section) hit.section = doc.section;
        this.emit('query', { ...state, hits: [...state.hits] });
      }
    }
  }

  private async onAnnounce(pkt: Packet) {
    const payload = decodeAnnounce(pkt.payload);
    const added = await this.replicator.onAnnounce(payload, pkt.srcId);
    if (added) this.emit('catalog');
  }

  private async onCatalogReq(pkt: Packet) {
    const req = decodeCatalogReq(pkt.payload);
    await this.replicator.serveCatalogRequest(req.sinceSec, pkt.srcId, req.max);
  }

  private sendAnnounce(payload: AnnouncePayload, dstId?: number) {
    this.router.send(
      dstId ? PacketType.CATALOG_RES : PacketType.ANNOUNCE,
      encodeAnnounce(payload),
      dstId ?? BROADCAST,
    );
  }

  /* ---------------- outbound application logic ---------------- */

  /** Ingests a document here and gossips its metadata to the mesh. */
  async upload(
    filename: string,
    text: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ title: string; chunks: number }> {
    const { doc } = await catalog.upload(filename, text, this.identity.id, onProgress);
    await this.replicator.announceDocument(doc.docKey);
    // Replicate immediately rather than waiting for the next timer tick, so an
    // upload visibly spreads instead of sitting on one node for six seconds.
    void this.replicator.reconcile();
    return { title: doc.title, chunks: doc.chunkCount };
  }

  /**
   * Runs a search across the mesh. Resolves when the collection window closes;
   * subscribe to the `query` event to render partial results as they stream in.
   */
  async search(text: string, topK = 5): Promise<QueryState> {
    const queryId = this.queryCounter++;
    const state: QueryState = {
      queryId,
      text,
      hits: [],
      respondedNodeIds: [],
      startedAt: Date.now(),
    };
    this.queries.set(queryId, state);

    const vec = await embedder.embedOne(text);

    // Our own catalog answers instantly — no radio involved.
    if (catalog.ready) {
      const local = catalog.searchLocal(vec, topK, text);
      const holders = await this.holdersFor(local.map((h) => h.docId));
      for (const hit of local) {
        state.hits.push({
          docId: hit.docId,
          score: hit.score,
          title: hit.meta.title,
          section: hit.meta.section,
          snippet: hit.meta.snippet,
          text: hit.hasBody ? await catalog.getBody(hit.docId) : undefined,
          fromNodeId: this.identity.id,
          fromNodeName: this.identity.name,
          holderId: hit.hasBody ? this.identity.id : (holders.get(hit.docId) ?? 0),
          hops: 0,
          local: true,
          storedHere: hit.hasBody,
        });
      }
      void this.replicator.recordHit(local.map((h) => h.docId));
      state.respondedNodeIds.push(this.identity.id);
      this.emit('query', { ...state, hits: [...state.hits] });
    }

    const { q, scale } = quantize(vec);
    this.router.send(
      PacketType.QUERY,
      encodeQuery({ queryId, topK, scale, vec: q, text: text.slice(0, 160) }),
    );

    await this.collect(state);

    state.finishedAt = Date.now();
    state.hits.sort((a, b) => b.score - a.score);
    this.emit('query', { ...state, hits: [...state.hits] });

    // Keep the state alive briefly so late DOC_RES packets can still land.
    setTimeout(() => this.queries.delete(queryId), 60_000);
    return { ...state, hits: [...state.hits] };
  }

  /**
   * Waits for replies, returning as soon as every known peer has answered
   * rather than always burning the full window. A node with nothing relevant
   * stays silent, so "all peers replied" is only reachable when every peer
   * had something to say — hence the hard timeout is still the common exit.
   */
  private collect(state: QueryState): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(finish, COLLECT_WINDOW_MS);
      const poll = setInterval(() => {
        if (Date.now() - started < EARLY_EXIT_GRACE_MS) return;
        const expected = this.peers().map((p) => p.nodeId);
        if (expected.length && expected.every((id) => state.respondedNodeIds.includes(id))) {
          finish();
        }
      }, 120) as unknown as number;
    });
  }

  /**
   * Fetches the full passage behind a hit.
   *
   * Goes to the named holder rather than to whoever answered, and falls back to
   * the answering node if the holder is silent — which happens when a holder
   * was evicted between announcing and being asked.
   */
  async fetchFullText(hit: MeshHit, timeoutMs = 4000): Promise<string> {
    if (hit.text) return hit.text;
    if (catalog.holdsBody(hit.docId)) {
      const local = await catalog.getBody(hit.docId);
      if (local) return local;
    }

    const targets = [hit.holderId, hit.fromNodeId].filter(
      (id, i, arr) => id && id !== this.identity.id && arr.indexOf(id) === i,
    );
    for (const target of targets) {
      const text = await this.requestDoc(hit.docId, target, timeoutMs);
      if (text) return text;
    }
    return hit.snippet; // degrade to the snippet rather than blocking
  }

  /**
   * Asks one specific node for one body.
   *
   * Also the replicator's pull primitive, which is why it resolves null rather
   * than throwing: a failed pull is ordinary, and it feeds the peer's
   * reliability score instead of being an error.
   */
  private requestDoc(docId: number, fromNodeId: number, timeoutMs: number): Promise<string | null> {
    void this.replicator.noteRequest(fromNodeId);
    return new Promise((resolve) => {
      const settle = (text: string | null) => {
        clearTimeout(timer);
        resolve(text);
      };

      const timer = setTimeout(() => {
        const list = this.docWaiters.get(docId);
        if (list) {
          const rest = list.filter((w) => w !== settle);
          if (rest.length) this.docWaiters.set(docId, rest);
          else this.docWaiters.delete(docId);
        }
        resolve(null);
      }, timeoutMs);

      const existing = this.docWaiters.get(docId);
      if (existing) existing.push(settle);
      else this.docWaiters.set(docId, [settle]);

      this.router.send(PacketType.DOC_REQ, encodeDocReq(docId), fromNodeId);
    });
  }
}
