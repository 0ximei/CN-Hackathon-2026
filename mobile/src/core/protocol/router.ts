/**
 * MeshNet routing.
 *
 * Two mechanisms, both classic and both visible in the demo:
 *
 * 1. Controlled flooding for broadcast (QUERY). Every node re-broadcasts once,
 *    never back toward the peer it came from (split horizon), with a TTL bound
 *    and an LRU of seen message ids so cycles terminate.
 *
 * 2. Backward learning for unicast (RESULT, DOC_REQ/RES). Every packet that
 *    arrives teaches us "node `srcId` is reachable via link `fromPeer`, `hops`
 *    away" — the same trick a transparent bridge uses. Replies then follow that
 *    learned next hop instead of being flooded, so a RESULT costs one path, not
 *    a second flood.
 *
 * If a unicast destination is unknown or its next hop has gone offline, the
 * packet is handed to store-and-forward rather than dropped.
 */

import {
  BROADCAST,
  DEFAULT_TTL,
  HEADER_BYTES,
  PROTO_VERSION,
  PacketType,
  decodePacket,
  encodePacket,
  hopsTravelled,
  type Packet,
} from './packet';
import { Reassembler, fragment } from './framing';
import type { Transport } from '../transport/Transport';
import { nextMsgId } from '../lib/ids';

const SEEN_CAPACITY = 512;
const ROUTE_TTL_MS = 30_000;

export type DropReason =
  | 'duplicate'
  | 'ttl-expired'
  | 'own-echo'
  | 'bad-version'
  | 'no-route'
  | 'link-loss';

export interface RouteEntry {
  peerId: string;
  hops: number;
  updated: number;
}

export interface RouterEvents {
  /** A packet addressed to this node (or broadcast) is ready to handle. */
  deliver(pkt: Packet, fromPeer: string | null): void;
  /** Observability hooks — these drive the mesh graph animation. */
  forwarded(pkt: Packet, toPeer: string | 'flood'): void;
  dropped(pkt: Packet | null, reason: DropReason, fromPeer: string): void;
  sent(pkt: Packet, toPeer: string | 'flood'): void;
  routesChanged(routes: Map<number, RouteEntry>): void;
}

type Handler<K extends keyof RouterEvents> = RouterEvents[K];

/** Insertion-ordered Set used as a fixed-capacity LRU of message ids. */
class SeenCache {
  private set = new Set<number>();
  constructor(private capacity = SEEN_CAPACITY) {}
  has(id: number) {
    return this.set.has(id);
  }
  add(id: number) {
    this.set.add(id);
    if (this.set.size > this.capacity) {
      // Set iteration is insertion-ordered, so the first key is the oldest.
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }
  get size() {
    return this.set.size;
  }
  clear() {
    this.set.clear();
  }
}

export interface RouterOptions {
  nodeId: number;
  transport: Transport;
  defaultTtl?: number;
  /** Injected by the dev panel to demonstrate loss tolerance. Range 0..1. */
  lossRate?: () => number;
  /** Called when a unicast packet has nowhere to go right now. */
  onUndeliverable?: (pkt: Packet, dstId: number) => void;
}

export class Router {
  readonly nodeId: number;
  private transport: Transport;
  private defaultTtl: number;
  private lossRate: () => number;
  private onUndeliverable?: (pkt: Packet, dstId: number) => void;

  private seen = new SeenCache();
  private routes = new Map<number, RouteEntry>();
  private reassemblers = new Map<string, Reassembler>();
  private unsubscribes: (() => void)[] = [];

  private listeners: { [K in keyof RouterEvents]: Set<Handler<K>> } = {
    deliver: new Set(),
    forwarded: new Set(),
    dropped: new Set(),
    sent: new Set(),
    routesChanged: new Set(),
  };

  stats = { sent: 0, received: 0, forwarded: 0, dropped: 0, duplicates: 0 };

  constructor(opts: RouterOptions) {
    this.nodeId = opts.nodeId;
    this.transport = opts.transport;
    this.defaultTtl = opts.defaultTtl ?? DEFAULT_TTL;
    this.lossRate = opts.lossRate ?? (() => 0);
    this.onUndeliverable = opts.onUndeliverable;
  }

  start() {
    this.unsubscribes.push(
      this.transport.on('frame', (peerId, frame) => this.onFrame(peerId, frame)),
      this.transport.on('peers', (peerIds) => this.onPeersChanged(peerIds)),
    );
  }

  stop() {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
    this.reassemblers.clear();
    this.seen.clear();
  }

  on<K extends keyof RouterEvents>(event: K, cb: Handler<K>): () => void {
    this.listeners[event].add(cb);
    return () => void this.listeners[event].delete(cb);
  }

  private emit<K extends keyof RouterEvents>(event: K, ...args: Parameters<Handler<K>>) {
    for (const cb of this.listeners[event]) (cb as (...a: unknown[]) => void)(...args);
  }

  setTtl(ttl: number) {
    this.defaultTtl = Math.max(1, Math.min(255, ttl));
  }

  get ttl() {
    return this.defaultTtl;
  }

  getRoutes(): Map<number, RouteEntry> {
    return new Map(this.routes);
  }

  /* ---------------- outbound ---------------- */

  /** Originate a packet from this node. `dstId` 0 floods. */
  send(type: PacketType, payload: Uint8Array, dstId = BROADCAST, ttl = this.defaultTtl): Packet {
    const pkt: Packet = {
      ver: PROTO_VERSION,
      type,
      ttl,
      // Record the launch TTL so every receiver can compute its own hop count.
      flags: ttl,
      msgId: nextMsgId(),
      srcId: this.nodeId,
      dstId,
      payload,
    };
    // Remember our own message so an echo off a neighbour is not reprocessed.
    this.seen.add(pkt.msgId);
    this.stats.sent++;

    if (dstId === BROADCAST) {
      this.writeBroadcast(pkt);
      this.emit('sent', pkt, 'flood');
    } else {
      const peer = this.nextHop(dstId);
      if (!peer) {
        this.onUndeliverable?.(pkt, dstId);
        this.emit('dropped', pkt, 'no-route', 'local');
        return pkt;
      }
      this.writeTo(peer, pkt);
      this.emit('sent', pkt, peer);
    }
    return pkt;
  }

  /** Re-attempt a previously undeliverable packet (store-and-forward flush). */
  deliverQueued(pkt: Packet): boolean {
    const peer = this.nextHop(pkt.dstId);
    if (!peer) return false;
    this.writeTo(peer, pkt);
    this.emit('sent', pkt, peer);
    return true;
  }

  private nextHop(dstId: number): string | null {
    const route = this.routes.get(dstId);
    if (!route) return null;
    if (Date.now() - route.updated > ROUTE_TTL_MS) return null;
    if (!this.transport.peers().includes(route.peerId)) {
      // The learned link went away; forget it so we can relearn a new path.
      this.routes.delete(dstId);
      this.emit('routesChanged', this.getRoutes());
      return null;
    }
    return route.peerId;
  }

  private writeTo(peerId: string, pkt: Packet) {
    const bytes = encodePacket(pkt);
    for (const f of fragment(bytes, this.transport.mtu)) this.transport.send(peerId, f);
  }

  private writeBroadcast(pkt: Packet, except?: string) {
    const bytes = encodePacket(pkt);
    for (const f of fragment(bytes, this.transport.mtu)) this.transport.broadcast(f, except);
  }

  /* ---------------- inbound ---------------- */

  private onFrame(peerId: string, frame: Uint8Array) {
    // Simulated link loss lives here, below the router, so the protocol's
    // recovery behaviour is what gets exercised — not a mocked-out shortcut.
    const loss = this.lossRate();
    if (loss > 0 && Math.random() < loss) return;

    let re = this.reassemblers.get(peerId);
    if (!re) {
      re = new Reassembler();
      this.reassemblers.set(peerId, re);
    }
    const complete = re.push(frame);
    if (!complete) return;

    const pkt = decodePacket(complete);
    if (!pkt) {
      this.stats.dropped++;
      this.emit('dropped', null, 'bad-version', peerId);
      return;
    }
    this.onPacket(peerId, pkt);
  }

  private onPacket(fromPeer: string, pkt: Packet) {
    if (pkt.srcId === this.nodeId) {
      this.emit('dropped', pkt, 'own-echo', fromPeer);
      return;
    }

    this.stats.received++;

    // Backward learning: whatever path this packet took, its reverse is a
    // working path back to its source.
    this.learn(pkt.srcId, fromPeer, hopsTravelled(pkt));

    if (this.seen.has(pkt.msgId)) {
      this.stats.duplicates++;
      this.stats.dropped++;
      this.emit('dropped', pkt, 'duplicate', fromPeer);
      return;
    }
    this.seen.add(pkt.msgId);

    const forMe = pkt.dstId === this.nodeId;
    const isBroadcast = pkt.dstId === BROADCAST;

    if (forMe || isBroadcast) {
      this.emit('deliver', pkt, fromPeer);
    }
    if (forMe) return; // unicast terminates here

    const forwarded: Packet = { ...pkt, ttl: pkt.ttl - 1 };
    if (forwarded.ttl <= 0) {
      this.stats.dropped++;
      this.emit('dropped', pkt, 'ttl-expired', fromPeer);
      return;
    }

    if (isBroadcast) {
      this.writeBroadcast(forwarded, fromPeer);
      this.stats.forwarded++;
      this.emit('forwarded', forwarded, 'flood');
      return;
    }

    const peer = this.nextHop(forwarded.dstId);
    if (peer && peer !== fromPeer) {
      this.writeTo(peer, forwarded);
      this.stats.forwarded++;
      this.emit('forwarded', forwarded, peer);
    } else if (!peer) {
      // No learned route: fall back to flooding so the packet still has a
      // chance, then let the destination's reply teach us the way.
      this.writeBroadcast(forwarded, fromPeer);
      this.stats.forwarded++;
      this.emit('forwarded', forwarded, 'flood');
    } else {
      this.stats.dropped++;
      this.emit('dropped', pkt, 'no-route', fromPeer);
    }
  }

  private learn(nodeId: number, peerId: string, hops: number) {
    if (nodeId === this.nodeId || nodeId === BROADCAST) return;
    const existing = this.routes.get(nodeId);
    const stale = existing && Date.now() - existing.updated > ROUTE_TTL_MS;
    if (!existing || stale || hops < existing.hops || existing.peerId === peerId) {
      const changed = !existing || existing.peerId !== peerId || existing.hops !== hops;
      this.routes.set(nodeId, { peerId, hops, updated: Date.now() });
      if (changed) this.emit('routesChanged', this.getRoutes());
    }
  }

  private onPeersChanged(peerIds: string[]) {
    const live = new Set(peerIds);
    let changed = false;
    for (const [nodeId, route] of this.routes) {
      if (!live.has(route.peerId)) {
        this.routes.delete(nodeId);
        changed = true;
      }
    }
    for (const peerId of this.reassemblers.keys()) {
      if (!live.has(peerId)) this.reassemblers.delete(peerId);
    }
    if (changed) this.emit('routesChanged', this.getRoutes());
  }

  /** Largest packet payload that fits before fragmentation kicks in. */
  get singleFramePayload() {
    return this.transport.mtu - HEADER_BYTES - 6;
  }
}
