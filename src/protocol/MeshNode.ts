/**
 * MeshNode — the orchestrator.
 *
 * Owns the transport, the router, the store-and-forward queue and this node's
 * shard, and implements the actual application protocol on top of them:
 *
 *   search(text)
 *     -> embed locally
 *     -> search own shard immediately (results appear before the network does)
 *     -> flood QUERY carrying a 388-byte int8 embedding
 *     -> peers search their own shards and unicast RESULT back along the
 *        route the query taught them
 *     -> collect for a fixed window, merge, dedupe, rerank
 *     -> pull full passage text on demand with DOC_REQ
 */

import {
  BROADCAST,
  PacketType,
  decodeDocReq,
  decodeDocRes,
  decodeHello,
  decodeQuery,
  decodeResult,
  encodeDocReq,
  encodeDocRes,
  encodeHello,
  encodeQuery,
  encodeResult,
  type Packet,
} from './packet';
import { Router, type DropReason, type RouteEntry } from './router';
import { StoreForward } from './storeForward';
import type { Transport } from '../transport/Transport';
import type { Identity } from '../lib/ids';
import { shardStore } from '../search/shard';
import { embedder } from '../search/embedder';
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

export interface PeerState {
  nodeId: number;
  name: string;
  shardId: number;
  docCount: number;
  hasLlm: boolean;
  hops: number;
  lastSeen: number;
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
  fromNodeId: number;
  fromNodeName: string;
  hops: number;
  shardId: number;
  local: boolean;
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
  kind: 'sent' | 'forwarded' | 'received' | 'dropped';
  type: string;
  srcId: number;
  dstId: number;
  peer: string;
  reason?: DropReason;
}

export interface MeshEvents {
  peers(peers: PeerState[]): void;
  activity(ev: ActivityEvent): void;
  query(state: QueryState): void;
  routes(routes: Map<number, RouteEntry>): void;
  outbox(queued: number): void;
}

export class MeshNode {
  readonly identity: Identity;
  readonly router: Router;
  readonly transport: Transport;
  readonly storeForward: StoreForward;

  private peersById = new Map<number, PeerState>();
  private queries = new Map<number, QueryState>();
  private docWaiters = new Map<number, (hit: MeshHit) => void>();
  private helloTimer: number | null = null;
  private peerTimer: number | null = null;
  private queryCounter = 1;

  /** Set by the dev panel; feeds the router's simulated link loss. */
  packetLoss = 0;

  private listeners: { [K in keyof MeshEvents]: Set<MeshEvents[K]> } = {
    peers: new Set(),
    activity: new Set(),
    query: new Set(),
    routes: new Set(),
    outbox: new Set(),
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

  stop() {
    if (this.helloTimer !== null) clearInterval(this.helloTimer);
    if (this.peerTimer !== null) clearInterval(this.peerTimer);
    this.storeForward.stop();
    this.router.stop();
    this.transport.stop();
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
      type: PACKET_NAMES[pkt.type] ?? String(pkt.type),
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
    const caps = (shardStore.ready ? 0b10 : 0) | (this.hasLlm ? 0b01 : 0);
    this.router.send(
      PacketType.HELLO,
      encodeHello({
        shardId: shardStore.shardId ?? 255,
        docCount: shardStore.chunkCount,
        caps,
        name: this.identity.name,
      }),
      BROADCAST,
      // Beacons are deliberately short-range: peers beyond two hops are
      // discovered through the routes their traffic teaches us instead.
      2,
    );
  }

  hasLlm = false;

  private reapPeers() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    let changed = false;
    for (const [id, peer] of this.peersById) {
      if (peer.lastSeen < cutoff) {
        this.peersById.delete(id);
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
        return this.onDocReq(pkt);
      case PacketType.DOC_RES:
        return this.onDocRes(pkt);
    }
  }

  private onHello(pkt: Packet) {
    const hello = decodeHello(pkt.payload);
    const hops = this.router.getRoutes().get(pkt.srcId)?.hops ?? 1;
    const existing = this.peersById.get(pkt.srcId);

    this.peersById.set(pkt.srcId, {
      nodeId: pkt.srcId,
      name: hello.name,
      shardId: hello.shardId,
      docCount: hello.docCount,
      hasLlm: (hello.caps & 0b01) !== 0,
      hops,
      lastSeen: Date.now(),
    });

    if (!existing) {
      this.emit('peers', this.peers());
      // A peer we could not reach may now be reachable — retry held answers.
      void this.storeForward.flush(pkt.srcId);
    } else if (existing.docCount !== hello.docCount || existing.hops !== hops) {
      this.emit('peers', this.peers());
    }
  }

  /** A peer asked the mesh a question. Search our own shard and reply. */
  private onQuery(pkt: Packet) {
    if (!shardStore.ready) return;

    const q = decodeQuery(pkt.payload);
    // The vector arrives quantized; dequantizing re-normalizes it so the
    // cosine scores are directly comparable with the asker's own.
    const vec = dequantize(q.vec, q.scale);

    const hits = shardStore.searchLocal(vec, Math.min(q.topK, HITS_PER_NODE), q.text);
    if (!hits.length) return;

    this.router.send(
      PacketType.RESULT,
      encodeResult({
        queryId: q.queryId,
        hopCount: this.router.getRoutes().get(pkt.srcId)?.hops ?? 1,
        shardId: shardStore.shardId ?? 255,
        hits: hits.map((h) => ({
          docId: h.docId,
          score: toWireScore(h.score),
          title: h.chunk.title,
          snippet: `${h.chunk.section}: ${h.chunk.text}`.slice(0, 200),
        })),
      }),
      pkt.srcId,
    );
  }

  private onResult(pkt: Packet) {
    const res = decodeResult(pkt.payload);
    const state = this.queries.get(res.queryId);
    if (!state) return; // window already closed, or not our query

    const peer = this.peersById.get(pkt.srcId);
    const name = peer?.name ?? `#${pkt.srcId.toString(16).slice(0, 4)}`;

    for (const hit of res.hits) {
      const existing = state.hits.find((h) => h.docId === hit.docId);
      if (existing) continue; // the same passage cannot live on two shards
      const [section, ...rest] = hit.snippet.split(': ');
      state.hits.push({
        docId: hit.docId,
        score: fromWireScore(hit.score),
        title: hit.title,
        section: rest.length ? section : '',
        snippet: rest.length ? rest.join(': ') : hit.snippet,
        fromNodeId: pkt.srcId,
        fromNodeName: name,
        hops: res.hopCount,
        shardId: res.shardId,
        local: false,
      });
    }

    if (!state.respondedNodeIds.includes(pkt.srcId)) state.respondedNodeIds.push(pkt.srcId);
    state.hits.sort((a, b) => b.score - a.score);
    this.emit('query', { ...state, hits: [...state.hits] });
  }

  private onDocReq(pkt: Packet) {
    const { docId } = decodeDocReq(pkt.payload);
    const chunk = shardStore.getChunk(docId);
    if (!chunk) return;
    this.router.send(
      PacketType.DOC_RES,
      encodeDocRes({
        docId,
        title: chunk.title,
        section: chunk.section,
        text: chunk.text,
        source: chunk.source,
      }),
      pkt.srcId,
    );
  }

  private onDocRes(pkt: Packet) {
    const doc = decodeDocRes(pkt.payload);
    const waiter = this.docWaiters.get(doc.docId);
    if (!waiter) return;
    this.docWaiters.delete(doc.docId);

    for (const state of this.queries.values()) {
      const hit = state.hits.find((h) => h.docId === doc.docId);
      if (hit) {
        hit.text = doc.text;
        hit.section = doc.section;
        waiter(hit);
        this.emit('query', { ...state, hits: [...state.hits] });
        return;
      }
    }
  }

  /* ---------------- outbound application logic ---------------- */

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

    // Our own shard answers instantly — no radio involved.
    if (shardStore.ready) {
      for (const hit of shardStore.searchLocal(vec, topK, text)) {
        state.hits.push({
          docId: hit.docId,
          score: hit.score,
          title: hit.chunk.title,
          section: hit.chunk.section,
          snippet: hit.chunk.text.slice(0, 200),
          text: hit.chunk.text,
          fromNodeId: this.identity.id,
          fromNodeName: this.identity.name,
          hops: 0,
          shardId: hit.chunk.shardId,
          local: true,
        });
      }
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

  /** Fetches the full passage behind a remote hit. Local hits already have it. */
  async fetchFullText(hit: MeshHit, timeoutMs = 4000): Promise<string> {
    if (hit.text) return hit.text;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.docWaiters.delete(hit.docId);
        resolve(hit.snippet); // degrade to the snippet rather than blocking
      }, timeoutMs);

      this.docWaiters.set(hit.docId, (filled) => {
        clearTimeout(timer);
        resolve(filled.text ?? hit.snippet);
      });

      this.router.send(PacketType.DOC_REQ, encodeDocReq(hit.docId), hit.fromNodeId);
    });
  }
}

const PACKET_NAMES: Record<number, string> = {
  0: 'HELLO',
  1: 'QUERY',
  2: 'RESULT',
  3: 'DOC_REQ',
  4: 'DOC_RES',
  5: 'ACK',
};
