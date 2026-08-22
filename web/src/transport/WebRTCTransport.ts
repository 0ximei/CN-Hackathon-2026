/**
 * WebRTC transport: real devices, real radio, no internet and no server.
 *
 * Pairing is done once per *link*, not once per pair of nodes. Because the
 * MeshNet router does multi-hop forwarding, a phone only needs a direct
 * WebRTC connection to its neighbours — A pairs with B, B pairs with C, and
 * A still reaches C through B. That turns what would be O(n^2) QR scans into
 * O(n), and it is the multi-hop path that makes the topology interesting.
 */

import { TransportEmitter, type Transport } from './Transport';
import { decodeToken, encodeToken, expandSdp, minifySdp, type MiniSdp } from './signaling';

/** SCTP handles large messages, but staying well under the limit avoids stalls. */
const MTU = 16384;
const LABEL = 'meshnet';

interface Link {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  peerId: string;
}

export class WebRTCTransport extends TransportEmitter implements Transport {
  readonly kind = 'webrtc' as const;
  readonly mtu = MTU;

  private links = new Map<string, Link>();
  /** Half-open connections keyed by the token we handed out. */
  private pendingOffers = new Map<string, RTCPeerConnection>();

  constructor(private selfUuid: string) {
    super();
  }

  async start(): Promise<void> {
    /* Connections are established on demand through the pairing UI. */
  }

  stop(): void {
    for (const link of this.links.values()) link.pc.close();
    for (const pc of this.pendingOffers.values()) pc.close();
    this.links.clear();
    this.pendingOffers.clear();
    this.emitPeers([]);
  }

  peers(): string[] {
    return [...this.links.entries()]
      .filter(([, l]) => l.dc?.readyState === 'open')
      .map(([id]) => id);
  }

  send(peerId: string, frame: Uint8Array): void {
    const dc = this.links.get(peerId)?.dc;
    if (dc?.readyState !== 'open') return;
    dc.send(frame as Uint8Array<ArrayBuffer>);
  }

  broadcast(frame: Uint8Array, except?: string): void {
    for (const peerId of this.peers()) {
      if (peerId !== except) this.send(peerId, frame);
    }
  }

  /* ---------------- pairing ---------------- */

  private newConnection(): RTCPeerConnection {
    // No ICE servers: offline by design, host candidates only.
    return new RTCPeerConnection({ iceServers: [] });
  }

  /** Waits for ICE gathering so the token carries every candidate inline. */
  private async gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      // Some browsers never fire 'complete' on a hostless config; cap the wait.
      const timer = setTimeout(finish, 2000);
      function finish() {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
      function onChange() {
        if (pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  /** Step 1 (initiator): produce a token for the other device to scan. */
  async createInvite(): Promise<string> {
    const pc = this.newConnection();
    const dc = pc.createDataChannel(LABEL, { ordered: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.gathered(pc);

    const mini = minifySdp(pc.localDescription!.sdp, 'o', this.selfUuid);
    const token = await encodeToken(mini);
    this.pendingOffers.set(token, pc);

    // The peer id is not known until the answer arrives; wire the channel now
    // and rename the link when we learn who accepted.
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.pendingOffers.delete(token);
      }
    });
    (pc as RTCPeerConnection & { _dc?: RTCDataChannel })._dc = dc;

    return token;
  }

  /** Step 2 (joiner): consume an invite token and produce an answer token. */
  async acceptInvite(inviteToken: string): Promise<string> {
    const mini = await decodeToken(inviteToken);
    if (mini.t !== 'o') throw new Error('that token is an answer, not an invite');

    const pc = this.newConnection();
    const peerId = mini.n;

    pc.addEventListener('datachannel', (ev) => this.attach(peerId, pc, ev.channel));
    await pc.setRemoteDescription({ type: 'offer', sdp: expandSdp(mini) });

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.gathered(pc);

    this.links.set(peerId, { pc, dc: null, peerId });
    this.watch(peerId, pc);

    return encodeToken(minifySdp(pc.localDescription!.sdp, 'a', this.selfUuid));
  }

  /** Step 3 (initiator): consume the answer token to complete the link. */
  async completeInvite(inviteToken: string, answerToken: string): Promise<void> {
    const pc = this.pendingOffers.get(inviteToken);
    if (!pc) throw new Error('that invite has expired — generate a new one');

    const mini = await decodeToken(answerToken);
    if (mini.t !== 'a') throw new Error('that token is an invite, not an answer');

    await pc.setRemoteDescription({ type: 'answer', sdp: expandSdp(mini) });
    this.pendingOffers.delete(inviteToken);

    const peerId = mini.n;
    const dc = (pc as RTCPeerConnection & { _dc?: RTCDataChannel })._dc;
    this.links.set(peerId, { pc, dc: null, peerId });
    this.watch(peerId, pc);
    if (dc) this.attach(peerId, pc, dc);
  }

  private attach(peerId: string, pc: RTCPeerConnection, dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    this.links.set(peerId, { pc, dc, peerId });

    dc.onopen = () => this.emitPeers(this.peers());
    dc.onclose = () => this.emitPeers(this.peers());
    dc.onmessage = (ev) => this.emitFrame(peerId, new Uint8Array(ev.data as ArrayBuffer));
  }

  private watch(peerId: string, pc: RTCPeerConnection) {
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.links.delete(peerId);
        this.emitPeers(this.peers());
      }
    });
  }

  /** Diagnostics for the pairing UI. */
  linkStates(): { peerId: string; connection: string; channel: string }[] {
    return [...this.links.values()].map((l) => ({
      peerId: l.peerId,
      connection: l.pc.connectionState,
      channel: l.dc?.readyState ?? 'none',
    }));
  }
}

export type { MiniSdp };
