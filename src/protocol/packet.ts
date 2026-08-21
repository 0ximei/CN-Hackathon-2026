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

export const PROTO_VERSION = 2;
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
  /** Metadata gossip — the cheap tier spreading outward from an upload. */
  ANNOUNCE: 6,
  /** Anti-entropy: "what have I missed?" */
  CATALOG_REQ: 7,
  CATALOG_RES: 8,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export const PACKET_TYPE_NAME: Record<number, string> = {
  0: 'HELLO',
  1: 'QUERY',
  2: 'RESULT',
  3: 'DOC_REQ',
  4: 'DOC_RES',
  5: 'ACK',
  6: 'ANNOUNCE',
  7: 'CATALOG_REQ',
  8: 'CATALOG_RES',
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
  /** bit0 = has LLM, bit1 = catalog ready */
  caps: number;
  /** Chunks this node has metadata for — what it can search. */
  known: number;
  /** Chunks this node holds the body of — what it can serve. */
  stored: number;
  documents: number;
  /**
   * Free storage in KiB.
   *
   * Self-reported, and that is fine: capacity is the one signal a node is the
   * only authority on. Reliability deliberately is *not* here — a peer's claim
   * about its own uptime is worth nothing, so every node measures that itself.
   */
  freeKb: number;
  name: string;
}

export function encodeHello(h: HelloPayload): Uint8Array {
  return new Writer()
    .u8(h.caps)
    .u32(h.known)
    .u32(h.stored)
    .u16(h.documents)
    .u32(h.freeKb)
    .str(h.name, 32)
    .finish();
}

export function decodeHello(b: Uint8Array): HelloPayload {
  const r = new Reader(b);
  return {
    caps: r.u8(),
    known: r.u32(),
    stored: r.u32(),
    documents: r.u16(),
    freeKb: r.u32(),
    name: r.str(),
  };
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
  /**
   * A node believed to hold the body, or 0 if the answerer knows of none.
   *
   * The answering node is often *not* the one to fetch from: it may know a
   * passage is relevant from metadata alone. Naming a holder here saves the
   * asker a round trip that would otherwise end in "I know of it, ask someone
   * else".
   */
  holderId: number;
}

export interface ResultPayload {
  queryId: number;
  hopCount: number;
  hits: Hit[];
}

export function encodeResult(res: ResultPayload): Uint8Array {
  const w = new Writer().u32(res.queryId).u8(res.hopCount).u8(res.hits.length);
  for (const h of res.hits) {
    w.u32(h.docId)
      .u16(Math.max(0, Math.min(65535, Math.round(h.score * 65535))))
      .u32(h.holderId)
      .str(h.title, 80)
      .str(h.snippet, 200);
  }
  return w.finish();
}

export function decodeResult(b: Uint8Array): ResultPayload {
  const r = new Reader(b);
  const queryId = r.u32();
  const hopCount = r.u8();
  const n = r.u8();
  const hits: Hit[] = [];
  for (let i = 0; i < n; i++) {
    hits.push({
      docId: r.u32(),
      score: r.u16() / 65535,
      holderId: r.u32(),
      title: r.str(),
      snippet: r.str(),
    });
  }
  return { queryId, hopCount, hits };
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
  /** Empty when the responder turned out not to hold the body after all. */
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

/* ---- ANNOUNCE / CATALOG_RES: metadata gossip, the cheap tier ---- */

/**
 * One chunk's metadata on the wire.
 *
 * ~660 bytes, of which 384 is the embedding. That is roughly a quarter of a
 * typical body, which is the entire economic argument for the split: this can
 * be sent to everyone, the body cannot.
 *
 * `title` and `source` live on the enclosing document rather than being
 * repeated per chunk — a 30-chunk document would otherwise carry its title
 * thirty times.
 */
export interface MetaEntry {
  docId: number;
  seq: number;
  version: number;
  section: string;
  snippet: string;
  /** Body size in bytes, so a receiver can budget before pulling it. */
  bytes: number;
  originId: number;
  scale: number;
  vec: Int8Array;
  /** Nodes the announcer believes hold the body. */
  holders: number[];
  /** The announcer's own access count for this chunk (a G-counter share). */
  hits: number;
}

export interface AnnouncePayload {
  docKey: number;
  title: string;
  source: string;
  /** Total body bytes across the whole document. */
  docBytes: number;
  chunkCount: number;
  docOriginId: number;
  /** Seconds since epoch — milliseconds do not fit in u32. */
  createdAtSec: number;
  entries: MetaEntry[];
}

/** Holders listed per chunk. Bounded so one entry cannot inflate a packet. */
const MAX_HOLDERS = 8;

export function encodeAnnounce(a: AnnouncePayload): Uint8Array {
  const w = new Writer()
    .u32(a.docKey)
    .str(a.title, 120)
    .str(a.source, 120)
    .u32(a.docBytes)
    .u16(a.chunkCount)
    .u32(a.docOriginId)
    .u32(a.createdAtSec)
    .u8(a.entries.length);

  for (const e of a.entries) {
    const holders = e.holders.slice(0, MAX_HOLDERS);
    w.u32(e.docId)
      .u16(e.seq)
      .u16(e.version)
      .u16(Math.min(65535, e.bytes))
      .u32(e.originId)
      .u32(e.hits)
      .str(e.section, 100)
      .str(e.snippet, 200)
      .f32(e.scale)
      .u16(e.vec.length)
      .bytes(new Uint8Array(e.vec.buffer, e.vec.byteOffset, e.vec.byteLength))
      .u8(holders.length);
    for (const h of holders) w.u32(h);
  }
  return w.finish();
}

export function decodeAnnounce(b: Uint8Array): AnnouncePayload {
  const r = new Reader(b);
  const docKey = r.u32();
  const title = r.str();
  const source = r.str();
  const docBytes = r.u32();
  const chunkCount = r.u16();
  const docOriginId = r.u32();
  const createdAtSec = r.u32();
  const n = r.u8();

  const entries: MetaEntry[] = [];
  for (let i = 0; i < n; i++) {
    const docId = r.u32();
    const seq = r.u16();
    const version = r.u16();
    const bytes = r.u16();
    const originId = r.u32();
    const hits = r.u32();
    const section = r.str();
    const snippet = r.str();
    const scale = r.f32();
    const dim = r.u16();
    const raw = r.bytes(dim);
    const holderCount = r.u8();
    const holders: number[] = [];
    for (let h = 0; h < holderCount; h++) holders.push(r.u32());
    entries.push({
      docId,
      seq,
      version,
      section,
      snippet,
      bytes,
      originId,
      scale,
      vec: new Int8Array(raw.buffer, raw.byteOffset, dim),
      holders,
      hits,
    });
  }
  return { docKey, title, source, docBytes, chunkCount, docOriginId, createdAtSec, entries };
}

/* ---- CATALOG_REQ: anti-entropy for a node that just joined ---- */

export interface CatalogReqPayload {
  /**
   * Only send metadata updated after this (seconds since epoch).
   *
   * A joining node sends 0 and gets everything; a node that has been away
   * sends its high-water mark, so re-syncing costs a delta rather than a full
   * catalog transfer every time a link flaps.
   */
  sinceSec: number;
  /** Cap on entries the requester wants back, so a reply stays bounded. */
  max: number;
}

export function encodeCatalogReq(c: CatalogReqPayload): Uint8Array {
  return new Writer().u32(c.sinceSec).u16(c.max).finish();
}

export function decodeCatalogReq(b: Uint8Array): CatalogReqPayload {
  const r = new Reader(b);
  return { sinceSec: r.u32(), max: r.u16() };
}
