/**
 * Link layer: MTU-aware fragmentation and reassembly.
 *
 * Applied per-hop, because MTU is a property of the link, not the route.
 * WebRTC gives ~64KB and never fragments; a BLE GATT characteristic gives
 * ~180 bytes and fragments every QUERY into three frames.
 *
 * Frame header — 6 bytes: fragId:u32 | fragIdx:u8 | fragCount:u8
 */

export const FRAME_HEADER_BYTES = 6;
const REASSEMBLY_TIMEOUT_MS = 10_000;
const MAX_PENDING = 64;

let fragCounter = Math.floor(Math.random() * 0xffff);

function nextFragId(): number {
  fragCounter = (fragCounter + 1) >>> 0;
  return (Math.imul(fragCounter, 0x85ebca6b) ^ (Date.now() & 0xffff)) >>> 0;
}

export function fragment(packet: Uint8Array, mtu: number): Uint8Array[] {
  const capacity = mtu - FRAME_HEADER_BYTES;
  if (capacity <= 0) throw new Error(`MTU ${mtu} too small for framing`);

  const count = Math.max(1, Math.ceil(packet.length / capacity));
  if (count > 255) {
    throw new Error(`Packet of ${packet.length}B needs ${count} frames at MTU ${mtu} (max 255)`);
  }

  const fragId = nextFragId();
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = packet.subarray(i * capacity, (i + 1) * capacity);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + chunk.length);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, fragId);
    dv.setUint8(4, i);
    dv.setUint8(5, count);
    frame.set(chunk, FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

interface Pending {
  parts: (Uint8Array | undefined)[];
  received: number;
  bytes: number;
  ts: number;
}

/** One instance per link. Frames from different links must not share state. */
export class Reassembler {
  private pending = new Map<number, Pending>();

  /** Returns a complete packet, or null while frames are still outstanding. */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length < FRAME_HEADER_BYTES) return null;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const fragId = dv.getUint32(0);
    const idx = dv.getUint8(4);
    const count = dv.getUint8(5);
    const chunk = frame.slice(FRAME_HEADER_BYTES);

    if (count === 1) return chunk;
    if (idx >= count) return null;

    this.sweep();

    let p = this.pending.get(fragId);
    if (!p) {
      if (this.pending.size >= MAX_PENDING) {
        // Drop the oldest rather than growing without bound under packet loss.
        const oldest = [...this.pending.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) this.pending.delete(oldest[0]);
      }
      p = { parts: new Array(count), received: 0, bytes: 0, ts: Date.now() };
      this.pending.set(fragId, p);
    }
    if (p.parts[idx]) return null; // duplicate frame
    p.parts[idx] = chunk;
    p.received++;
    p.bytes += chunk.length;
    if (p.received < count) return null;

    this.pending.delete(fragId);
    const out = new Uint8Array(p.bytes);
    let o = 0;
    for (const part of p.parts) {
      out.set(part!, o);
      o += part!.length;
    }
    return out;
  }

  private sweep() {
    const cutoff = Date.now() - REASSEMBLY_TIMEOUT_MS;
    for (const [id, p] of this.pending) {
      if (p.ts < cutoff) this.pending.delete(id);
    }
  }

  get pendingCount() {
    return this.pending.size;
  }

  reset() {
    this.pending.clear();
  }
}
