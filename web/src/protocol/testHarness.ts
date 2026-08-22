/**
 * In-memory mesh simulator used by the protocol tests.
 *
 * Nodes are wired by an explicit adjacency list, so a test can build a line, a
 * ring, or a partition and assert what the routing layer actually does with it.
 * Delivery is synchronous, which keeps assertions free of timing flake.
 */

import { TransportEmitter, type Transport } from '../transport/Transport';

export class MockTransport extends TransportEmitter implements Transport {
  readonly kind = 'broadcast' as const;
  private links = new Map<string, MockTransport>();

  constructor(
    readonly id: string,
    readonly mtu = 65536,
  ) {
    super();
  }

  async start() {}
  stop() {}

  peers(): string[] {
    return [...this.links.keys()];
  }

  link(other: MockTransport) {
    this.links.set(other.id, other);
    other.links.set(this.id, this);
    this.emitPeers(this.peers());
    other.emitPeers(other.peers());
  }

  unlink(other: MockTransport) {
    this.links.delete(other.id);
    other.links.delete(this.id);
    this.emitPeers(this.peers());
    other.emitPeers(other.peers());
  }

  send(peerId: string, frame: Uint8Array) {
    const peer = this.links.get(peerId);
    if (!peer) return;
    peer.receive(this.id, frame);
  }

  broadcast(frame: Uint8Array, except?: string) {
    for (const [peerId, peer] of this.links) {
      if (peerId === except) continue;
      peer.receive(this.id, frame);
    }
  }

  /** Exposed so the harness can deliver without going through the event loop. */
  receive(fromPeerId: string, frame: Uint8Array) {
    this.emitFrame(fromPeerId, new Uint8Array(frame));
  }
}
