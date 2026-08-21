/**
 * MeshNet network layer.
 *
 * A Packet is the routable unit. Link-layer fragmentation lives in `framing.ts`
 * and is applied per-hop, so the router only ever sees whole packets.
 *
 * Header — 16 bytes, big-endian:
 *   ver:u8 type:u8 ttl:u8 flags:u8 | msgId:u32 | srcId:u32 | dstId:u32
 *
 * `flags` carries the TTL the originator started with. Hop count is then
 * `flags - ttl + 1` at any point along the path. Without it a receiver has to
 * assume every packet launched at the local default TTL, which is wrong for
 * any packet type that uses a different one (HELLO deliberately does).
 *
 * dstId === 0 means broadcast (flood). Anything else is unicast and is
 * forwarded via the router's backward-learned next-hop table.
 */

export const PROTO_VERSION = 1;
export const HEADER_BYTES = 16;
export const BROADCAST = 0;
export const DEFAULT_TTL = 4;

export const PacketType = {
  HELLO: 0,
  QUERY: 1,
  RESULT: 2,
  DOC_REQ: 3,
  DOC_RES: 4,
  ACK: 5,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export const PACKET_TYPE_NAME: Record<number, string> = {
  0: 'HELLO',
  1: 'QUERY',
  2: 'RESULT',
  3: 'DOC_REQ',
  4: 'DOC_RES',
  5: 'ACK',
};

export interface Packet {
  ver: number;
  type: PacketType;
  ttl: number;
  /** The TTL this packet was originated with. See the header note above. */
  flags: number;
  msgId: number;
  srcId: number;
  dstId: number;
  payload: Uint8Array;
}

export function encodePacket(p: Packet): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + p.payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, p.ver);
  dv.setUint8(1, p.type);
  dv.setUint8(2, p.ttl);
  dv.setUint8(3, p.flags);
  dv.setUint32(4, p.msgId >>> 0);
  dv.setUint32(8, p.srcId >>> 0);
  dv.setUint32(12, p.dstId >>> 0);
  out.set(p.payload, HEADER_BYTES);
  return out;
}

/** Hops travelled so far, derived from the originating TTL in `flags`. */
export function hopsTravelled(pkt: Pick<Packet, 'flags' | 'ttl'>): number {
  const initial = pkt.flags || DEFAULT_TTL;
  return Math.max(1, initial - pkt.ttl + 1);
}

export function decodePacket(buf: Uint8Array): Packet | null {
  if (buf.length < HEADER_BYTES) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ver = dv.getUint8(0);
  if (ver !== PROTO_VERSION) return null;
  return {
    ver,
    type: dv.getUint8(1) as PacketType,
    ttl: dv.getUint8(2),
    flags: dv.getUint8(3),
    msgId: dv.getUint32(4),
    srcId: dv.getUint32(8),
    dstId: dv.getUint32(12),
    // Copy: the caller's buffer may be a reused transport scratch buffer.
    payload: buf.slice(HEADER_BYTES),
  };
}

/* ------------------------------------------------------------------ *
 * Payload codecs
 * ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Small helper for building variable-length payloads without manual offset math. */
class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;
  private push(a: Uint8Array) {
    this.parts.push(a);
    this.len += a.length;
  }
  u8(v: number) {
    this.push(new Uint8Array([v & 0xff]));
    return this;
  }
  u16(v: number) {
    const a = new Uint8Array(2);
    new DataView(a.buffer).setUint16(0, v & 0xffff);
    this.push(a);
    return this;
  }
  u32(v: number) {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, v >>> 0);
    this.push(a);
    return this;
  }
  f32(v: number) {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setFloat32(0, v);
    this.push(a);
    return this;
  }
  bytes(a: Uint8Array) {
    this.push(a);
    return this;
  }
  /** Length-prefixed UTF-8, truncated to `max` bytes so packets stay bounded. */
  str(s: string, max = 65535) {
    let b = enc.encode(s);
    if (b.length > max) b = b.slice(0, max);
    this.u16(b.length);
    this.push(b);
    return this;
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

class Reader {
  private o = 0;
  private dv: DataView;
  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done() {
    return this.o >= this.buf.length;
  }
  u8() {
    return this.dv.getUint8(this.o++);
  }
  u16() {
    const v = this.dv.getUint16(this.o);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.o);
    this.o += 4;
    return v;
  }
  f32() {
    const v = this.dv.getFloat32(this.o);
    this.o += 4;
    return v;
  }
  bytes(n: number) {
    const v = this.buf.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
  str() {
    return dec.decode(this.bytes(this.u16()));
  }
}

/* ---- HELLO: periodic beacon; also the store-and-forward flush trigger ---- */

export interface HelloPayload {
  shardId: number;
  docCount: number;
  /** bit0 = has LLM, bit1 = index ready */
  caps: number;
  name: string;
}

export function encodeHello(h: HelloPayload): Uint8Array {
  return new Writer().u8(h.shardId).u32(h.docCount).u8(h.caps).str(h.name, 32).finish();
}

export function decodeHello(b: Uint8Array): HelloPayload {
  const r = new Reader(b);
  return { shardId: r.u8(), docCount: r.u32(), caps: r.u8(), name: r.str() };
}

/* ---- QUERY: int8-quantized embedding, ~395 bytes for a 384-dim model ---- */

export interface QueryPayload {
  queryId: number;
  topK: number;
  /** Symmetric int8 quantization scale: real = q * scale. */
  scale: number;
  vec: Int8Array;
  /** Plain text, capped — lets receivers run lexical (BM25) scoring too. */
  text: string;
}

export function encodeQuery(q: QueryPayload): Uint8Array {
  return new Writer()
    .u32(q.queryId)
    .u8(q.topK)
    .u16(q.vec.length)
    .f32(q.scale)
    .bytes(new Uint8Array(q.vec.buffer, q.vec.byteOffset, q.vec.byteLength))
    .str(q.text, 160)
    .finish();
}

export function decodeQuery(b: Uint8Array): QueryPayload {
  const r = new Reader(b);
  const queryId = r.u32();
  const topK = r.u8();
  const dim = r.u16();
  const scale = r.f32();
  const raw = r.bytes(dim);
  return {
    queryId,
    topK,
    scale,
    vec: new Int8Array(raw.buffer, raw.byteOffset, dim),
    text: r.done ? '' : r.str(),
  };
}

/* ---- RESULT: top hits travelling home along the reverse path ---- */

export interface Hit {
  docId: number;
  /** 0..1, transmitted as u16 fixed-point to save 2 bytes per hit. */
  score: number;
  title: string;
  snippet: string;
}

export interface ResultPayload {
  queryId: number;
  hopCount: number;
  shardId: number;
  hits: Hit[];
}

export function encodeResult(res: ResultPayload): Uint8Array {
  const w = new Writer().u32(res.queryId).u8(res.hopCount).u8(res.shardId).u8(res.hits.length);
  for (const h of res.hits) {
    w.u32(h.docId)
      .u16(Math.max(0, Math.min(65535, Math.round(h.score * 65535))))
      .str(h.title, 80)
      .str(h.snippet, 200);
  }
  return w.finish();
}

export function decodeResult(b: Uint8Array): ResultPayload {
  const r = new Reader(b);
  const queryId = r.u32();
  const hopCount = r.u8();
  const shardId = r.u8();
  const n = r.u8();
  const hits: Hit[] = [];
  for (let i = 0; i < n; i++) {
    hits.push({ docId: r.u32(), score: r.u16() / 65535, title: r.str(), snippet: r.str() });
  }
  return { queryId, hopCount, shardId, hits };
}

/* ---- DOC_REQ / DOC_RES: lazy full-text fetch, keeps RESULT packets small ---- */

export function encodeDocReq(docId: number): Uint8Array {
  return new Writer().u32(docId).finish();
}

export function decodeDocReq(b: Uint8Array): { docId: number } {
  return { docId: new Reader(b).u32() };
}

export interface DocResPayload {
  docId: number;
  title: string;
  section: string;
  text: string;
  source: string;
}

export function encodeDocRes(d: DocResPayload): Uint8Array {
  return new Writer()
    .u32(d.docId)
    .str(d.title, 120)
    .str(d.section, 120)
    .str(d.text, 4000)
    .str(d.source, 200)
    .finish();
}

export function decodeDocRes(b: Uint8Array): DocResPayload {
  const r = new Reader(b);
  return { docId: r.u32(), title: r.str(), section: r.str(), text: r.str(), source: r.str() };
}
