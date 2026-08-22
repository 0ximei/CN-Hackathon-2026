/**
 * The transport abstraction that makes the "Bluetooth" question moot.
 *
 * Web Bluetooth implements the GATT *Central* role only — a browser can connect
 * to a peripheral but cannot advertise as one, so two PWAs can never see each
 * other over BLE. Rather than pretend otherwise, the mesh is written against
 * this interface and each radio is an implementation:
 *
 *   BroadcastTransport  same-machine tabs        MTU 64KB   (always works)
 *   WebRTCTransport     LAN / hotspot, no server MTU 16KB   (real devices)
 *   BleBridgeTransport  phone -> own ESP32 -> RF MTU 180B   (real radio mesh)
 *
 * `peerId` here is a *link-local* address (who I can physically reach).
 * The 32-bit `nodeId` in the packet header is the *network* address.
 */

export type TransportKind = 'broadcast' | 'webrtc' | 'ble';

export interface TransportEvents {
  /** A single link-layer frame arrived from a directly-connected peer. */
  frame(peerId: string, frame: Uint8Array): void;
  /** The set of directly-reachable peers changed. */
  peers(peerIds: string[]): void;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Largest link-layer frame, in bytes, including the 6-byte frame header. */
  readonly mtu: number;

  start(): Promise<void>;
  stop(): void;

  /** Directly-connected peers (one hop away on this radio). */
  peers(): string[];

  send(peerId: string, frame: Uint8Array): void;
  /** Send to every direct peer. `except` implements split-horizon flooding. */
  broadcast(frame: Uint8Array, except?: string): void;

  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]): () => void;
}

/** Shared listener bookkeeping so each transport doesn't reimplement it. */
export class TransportEmitter {
  private listeners: { [K in keyof TransportEvents]: Set<TransportEvents[K]> } = {
    frame: new Set(),
    peers: new Set(),
  };

  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]): () => void {
    this.listeners[event].add(cb as never);
    return () => this.listeners[event].delete(cb as never);
  }

  protected emitFrame(peerId: string, frame: Uint8Array) {
    for (const cb of this.listeners.frame) cb(peerId, frame);
  }

  protected emitPeers(peerIds: string[]) {
    for (const cb of this.listeners.peers) cb(peerIds);
  }
}
