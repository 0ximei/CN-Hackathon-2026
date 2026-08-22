/**
 * Same-machine transport over BroadcastChannel — one browser tab per mesh node.
 *
 * This is not a mock: real packets, real fragmentation, real flooding. What it
 * simulates is only the *link* — latency and range. `setLink()` lets the dev
 * panel cut a specific edge so multi-hop routing can be demonstrated on one
 * laptop, which is the difference between "everyone hears everyone" and an
 * actual topology.
 */

import { TransportEmitter, type Transport } from './Transport';

const CHANNEL = 'meshnet.link.v1';
const PRESENCE_INTERVAL_MS = 1500;
const PEER_TIMEOUT_MS = 5000;

type Wire =
  | { t: 'hello'; from: string }
  | { t: 'bye'; from: string }
  /** Which peers the sender has severed. Announced so cuts stay symmetric. */
  | { t: 'cuts'; from: string; cut: string[] }
  | { t: 'frame'; from: string; to: string | null; data: number[] };

export interface BroadcastTransportOptions {
  selfId: string;
  /** One-way link delay in ms, to make hop counts visible in the UI. */
  latencyMs?: () => number;
  /** Return false to simulate two nodes being out of range of each other. */
  linkUp?: (peerId: string) => boolean;
}

export class BroadcastTransport extends TransportEmitter implements Transport {
  readonly kind = 'broadcast' as const;
  readonly mtu = 65536;

  private ch: BroadcastChannel | null = null;
  private selfId: string;
  private lastSeen = new Map<string, number>();
  /**
   * Peers that have severed *us*.
   *
   * A cut has to be symmetric or it isn't a downed link, it's a one-way black
   * hole: the far side would keep unicasting down a path we silently discard,
   * instead of rerouting. Real radios lose each other in both directions, so
   * each side announces its cuts and both drop the link.
   */
  private cutByPeer = new Set<string>();
  private timer: number | null = null;
  private latencyMs: () => number;
  private linkUp: (peerId: string) => boolean;

  constructor(opts: BroadcastTransportOptions) {
    super();
    this.selfId = opts.selfId;
    this.latencyMs = opts.latencyMs ?? (() => 25);
    this.linkUp = opts.linkUp ?? (() => true);
  }

  async start(): Promise<void> {
    this.ch = new BroadcastChannel(CHANNEL);
    this.ch.onmessage = (ev: MessageEvent<Wire>) => this.onWire(ev.data);
    this.announce();
    this.timer = setInterval(() => {
      this.announce();
      // Re-announced periodically so a node that joins after a cut was made
      // still learns about it.
      this.announceCuts();
      this.reapStalePeers();
    }, PRESENCE_INTERVAL_MS) as unknown as number;
    window.addEventListener('pagehide', this.sayBye);
  }

  stop(): void {
    window.removeEventListener('pagehide', this.sayBye);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.ch?.postMessage({ t: 'bye', from: this.selfId } satisfies Wire);
    this.ch?.close();
    this.ch = null;
    this.lastSeen.clear();
    this.cutByPeer.clear();
  }

  private sayBye = () => {
    this.ch?.postMessage({ t: 'bye', from: this.selfId } satisfies Wire);
  };

  peers(): string[] {
    return [...this.lastSeen.keys()].filter((p) => this.linkUp(p) && !this.cutByPeer.has(p));
  }

  /**
   * Re-publishes the peer set after `linkUp` starts answering differently.
   *
   * Severing a link changes what `peers()` returns but produces no wire event,
   * so without this the router would keep forwarding down a link the operator
   * has cut, until the route aged out ~30s later. Calling this makes the cut
   * take effect on the next packet.
   */
  refreshLinks(): void {
    this.announceCuts();
    this.emitPeers(this.peers());
  }

  private announceCuts() {
    const cut = [...this.lastSeen.keys()].filter((p) => !this.linkUp(p));
    this.ch?.postMessage({ t: 'cuts', from: this.selfId, cut } satisfies Wire);
  }

  send(peerId: string, frame: Uint8Array): void {
    if (!this.linkUp(peerId)) return;
    this.post({ t: 'frame', from: this.selfId, to: peerId, data: [...frame] });
  }

  broadcast(frame: Uint8Array, except?: string): void {
    // Addressed per-peer rather than sent once, so a downed link really is down.
    for (const peerId of this.peers()) {
      if (peerId === except) continue;
      this.send(peerId, frame);
    }
  }

  private post(msg: Wire) {
    const delay = this.latencyMs();
    if (delay <= 0) this.ch?.postMessage(msg);
    else setTimeout(() => this.ch?.postMessage(msg), delay);
  }

  private announce() {
    this.ch?.postMessage({ t: 'hello', from: this.selfId } satisfies Wire);
  }

  private onWire(msg: Wire) {
    if (msg.from === this.selfId) return;

    if (msg.t === 'bye') {
      this.cutByPeer.delete(msg.from);
      if (this.lastSeen.delete(msg.from)) this.emitPeers(this.peers());
      return;
    }

    if (msg.t === 'cuts') {
      const wasCut = this.cutByPeer.has(msg.from);
      const isCut = msg.cut.includes(this.selfId);
      if (isCut) this.cutByPeer.add(msg.from);
      else this.cutByPeer.delete(msg.from);
      this.lastSeen.set(msg.from, Date.now());
      if (wasCut !== isCut) this.emitPeers(this.peers());
      return;
    }

    const known = this.lastSeen.has(msg.from);
    this.lastSeen.set(msg.from, Date.now());
    if (!known) {
      this.emitPeers(this.peers());
      this.announce(); // let the newcomer learn about us immediately
    }

    if (msg.t !== 'frame') return;
    if (msg.to !== null && msg.to !== this.selfId) return;
    if (!this.linkUp(msg.from) || this.cutByPeer.has(msg.from)) return;
    this.emitFrame(msg.from, new Uint8Array(msg.data));
  }

  private reapStalePeers() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    let changed = false;
    for (const [peerId, ts] of this.lastSeen) {
      if (ts < cutoff) {
        this.lastSeen.delete(peerId);
        changed = true;
      }
    }
    if (changed) this.emitPeers(this.peers());
  }
}
