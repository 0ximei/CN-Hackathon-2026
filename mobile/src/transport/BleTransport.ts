import type { EventSubscription } from 'expo-modules-core';

import { TransportEmitter, type Transport } from '@core/transport/Transport';
import BleMesh, { type BleCapabilities, type BlePeer } from '../../modules/ble-mesh';
import { fromBase64, toBase64 } from '../lib/base64';
import { ensureBlePermissions } from '../lib/permissions';

/**
 * The radio the web app could not have.
 *
 * `BroadcastTransport` and `WebRTCTransport` in the web build both fake or
 * sidestep the physical layer — one is same-machine tabs, the other needs an IP
 * network. This one is Bluetooth LE with nothing underneath it: no router, no
 * access point, no pairing, no internet. Two phones in a room with radios on
 * find each other and route.
 *
 * The interface is unchanged from the browser's, so `Router` and the packet
 * codec above it do not know or care which of the three is mounted.
 */
export class BleTransport extends TransportEmitter implements Transport {
  readonly kind = 'ble' as const;

  /**
   * Network-layer MTU, not the ATT MTU.
   *
   * The native side already segments every frame against the MTU actually
   * negotiated for each link, which varies per peer and is not known when this
   * value is read. Declaring a small one here would fragment twice — once in
   * `framing.ts` against a guess, again in Kotlin against the truth — and pay
   * six bytes of frame header for each. So this is set well above any real
   * packet and per-hop fragmentation is left to the layer that can measure.
   */
  readonly mtu = 4096;

  private subscriptions: EventSubscription[] = [];
  private current: BlePeer[] = [];
  private started = false;
  /**
   * The in-flight `start`, so a second caller joins it rather than racing it.
   *
   * `started` only becomes true once the native call has resolved, so two
   * overlapping starts both got past the guard and both subscribed — every
   * frame then reached the router twice, which reads as a mesh that duplicates
   * everything it hears.
   */
  private starting: Promise<void> | null = null;
  /** Set by `stop`, so a start still in flight tears itself down on arrival. */
  private stopping = false;

  private logListeners = new Set<(line: string) => void>();
  private stateListeners = new Set<(state: string, detail: string) => void>();

  /**
   * Peers to behave as though they were out of range.
   *
   * The browser build cuts a link by refusing to publish it from
   * `BroadcastTransport`; there is no equivalent here, because the link is a
   * real GATT connection and tearing it down would take fifteen seconds to
   * rebuild — far too slow to demonstrate anything on stage. So the connection
   * stays up and this layer drops frames in both directions instead, which is
   * what the router above it would see either way: a peer it can no longer
   * reach, forcing it to relearn a path through a relay.
   *
   * Frames are dropped rather than errored so store-and-forward runs for real —
   * the router asks for a route, finds none, and parks the packet.
   */
  private severed = new Set<string>();

  /** Radio-level lines, newest last. Bounded so a long session cannot grow it. */
  readonly log: string[] = [];
  private static readonly LOG_CAPACITY = 300;

  private readonly nodeId: number;

  constructor(nodeId: number) {
    super();
    // Node ids are unsigned 32-bit — `hash32` ends in `>>> 0` — but Kotlin's
    // `Int` is signed, and anything above 2^31 does not survive the bridge as a
    // number. Coercing to the signed representation of the same 32 bits is
    // lossless: the native side only ever compares ids with
    // `Integer.compareUnsigned` and formats them with `%08x`, both of which
    // read the bit pattern rather than the sign.
    this.nodeId = nodeId | 0;
  }

  static capabilities(): BleCapabilities {
    return BleMesh.capabilities();
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async open(): Promise<void> {
    const granted = await ensureBlePermissions();
    if (!granted.ok) throw new Error(granted.reason);
    if (this.stopping) return;

    this.subscriptions = [
      BleMesh.addListener('onFrame', ({ peerId, data }) => {
        if (this.severed.has(peerId)) return;
        this.emitFrame(peerId, fromBase64(data));
      }),
      BleMesh.addListener('onPeers', ({ peers }) => {
        this.current = peers;
        this.publishPeers();
      }),
      BleMesh.addListener('onLog', ({ message }) => this.note(message)),
      BleMesh.addListener('onState', ({ state, detail }) => {
        for (const cb of this.stateListeners) cb(state, detail);
      }),
    ];

    const result = await BleMesh.start(this.nodeId);
    if (!result.ok) {
      this.teardownSubscriptions();
      throw new Error(result.error ?? 'the Bluetooth radio refused to start');
    }
    this.started = true;

    // Stopped while the radio was coming up. It is running now, so shut it down
    // rather than leave a radio nothing holds a reference to.
    if (this.stopping) this.stop();
  }

  /**
   * Keeps the radio alive with the app closed, behind a foreground service.
   *
   * Safe to call before `start`: the native side records the preference and
   * raises the service when there is a radio to announce.
   */
  async setBackground(on: boolean): Promise<void> {
    await BleMesh.setBackground(on);
  }

  stop(): void {
    this.stopping = true;
    // Deliberately not guarded on `started`: a stop that arrives mid-start still
    // has to detach the subscriptions, whether or not the start ever finished.
    this.teardownSubscriptions();
    this.current = [];
    if (!this.started) return;
    this.started = false;
    void BleMesh.stop();
  }

  peers(): string[] {
    return this.current.map((p) => p.peerId).filter((id) => !this.severed.has(id));
  }

  /**
   * Marks links as severed for the demo. Ids are the transport's peer ids —
   * eight lowercase hex digits, the same form `peers()` returns.
   */
  setSevered(peerIds: string[]): void {
    this.severed = new Set(peerIds);
    for (const id of this.severed) this.note(`link to ${id} severed by the operator`);
    this.publishPeers();
  }

  private publishPeers(): void {
    this.emitPeers(this.peers());
  }

  /** Richer than `peers()` — role, MTU and signal, for the UI. */
  peerDetails(): BlePeer[] {
    return this.current;
  }

  send(peerId: string, frame: Uint8Array): void {
    if (this.severed.has(peerId)) return;
    // Fire and forget by design: `Transport.send` is synchronous, and the
    // native queue is what actually guarantees ordering and delivery. A false
    // here only means the link closed between the router picking a next hop and
    // the frame reaching the radio, which store-and-forward is there to absorb.
    void BleMesh.send(peerId, toBase64(frame)).then((accepted) => {
      if (!accepted) this.note(`no open link to ${peerId}, frame dropped`);
    });
  }

  broadcast(frame: Uint8Array, except?: string): void {
    if (!this.severed.size) {
      void BleMesh.broadcast(toBase64(frame), except ?? null);
      return;
    }
    // A native broadcast cannot exclude an arbitrary set, only the one peer the
    // frame came from. With links severed the flood is unrolled into unicasts
    // so the severed ones can be left out — slower, and only ever on a path the
    // operator deliberately entered.
    for (const peer of this.peers()) {
      if (peer === except) continue;
      this.send(peer, frame);
    }
  }

  onLog(cb: (line: string) => void): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  onStateChange(cb: (state: string, detail: string) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private note(line: string): void {
    this.log.push(line);
    if (this.log.length > BleTransport.LOG_CAPACITY) {
      this.log.splice(0, this.log.length - BleTransport.LOG_CAPACITY);
    }
    for (const cb of this.logListeners) cb(line);
  }

  private teardownSubscriptions(): void {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
  }
}
