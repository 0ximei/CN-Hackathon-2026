import { describe, expect, it } from 'vitest';
import {
  BROADCAST,
  DEFAULT_TTL,
  PROTO_VERSION,
  PacketType,
  decodeDocRes,
  decodeHello,
  decodeQuery,
  decodeResult,
  encodeDocRes,
  encodeHello,
  encodePacket,
  encodeQuery,
  encodeResult,
  decodePacket,
  hopsTravelled,
} from './packet';
import { FRAME_HEADER_BYTES, Reassembler, fragment } from './framing';
import { Router } from './router';
import { MockTransport } from './testHarness';
import { EMBED_DIM, dequantize, dot, quantize, makeDocIds, topK } from '../search/vector';

describe('packet codec', () => {
  it('round-trips a header with all fields distinct', () => {
    const pkt = {
      ver: PROTO_VERSION,
      type: PacketType.QUERY,
      ttl: 4,
      flags: 0,
      msgId: 0xdeadbeef,
      srcId: 0x12345678,
      dstId: 0x9abcdef0,
      payload: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const decoded = decodePacket(encodePacket(pkt))!;
    expect(decoded).toEqual(pkt);
  });

  it('rejects a packet from a different protocol version', () => {
    const bytes = encodePacket({
      ver: 99,
      type: PacketType.HELLO,
      ttl: 1,
      flags: 0,
      msgId: 1,
      srcId: 2,
      dstId: 0,
      payload: new Uint8Array(),
    });
    expect(decodePacket(bytes)).toBeNull();
  });

  it('round-trips HELLO, QUERY, RESULT and DOC_RES payloads', () => {
    const hello = { shardId: 3, docCount: 412, caps: 0b11, name: 'Karo' };
    expect(decodeHello(encodeHello(hello))).toEqual(hello);

    const vec = new Int8Array(EMBED_DIM).map((_, i) => ((i * 7) % 255) - 127);
    const q = decodeQuery(encodeQuery({ queryId: 77, topK: 5, scale: 0.0081, vec, text: 'burn' }));
    expect(q.queryId).toBe(77);
    expect(q.topK).toBe(5);
    expect(q.text).toBe('burn');
    expect([...q.vec]).toEqual([...vec]);
    expect(q.scale).toBeCloseTo(0.0081, 6);

    const res = decodeResult(
      encodeResult({
        queryId: 77,
        hopCount: 2,
        shardId: 1,
        hits: [{ docId: 900, score: 0.75, title: 'Burns', snippet: 'Cool under water.' }],
      }),
    );
    expect(res.hopCount).toBe(2);
    expect(res.hits[0].title).toBe('Burns');
    expect(res.hits[0].score).toBeCloseTo(0.75, 4);

    const doc = {
      docId: 900,
      title: 'Burns',
      section: 'First aid',
      text: 'Cool the burn under running water for twenty minutes.',
      source: 'wikipedia:Burn',
    };
    expect(decodeDocRes(encodeDocRes(doc))).toEqual(doc);
  });

  it('truncates oversized strings instead of overflowing the length prefix', () => {
    const long = 'x'.repeat(5000);
    const res = decodeResult(
      encodeResult({
        queryId: 1,
        hopCount: 0,
        shardId: 0,
        hits: [{ docId: 1, score: 1, title: long, snippet: long }],
      }),
    );
    expect(res.hits[0].title.length).toBe(80);
    expect(res.hits[0].snippet.length).toBe(200);
  });
});

describe('framing', () => {
  it('round-trips a full QUERY packet at BLE MTU', () => {
    const vec = new Int8Array(EMBED_DIM).map((_, i) => (i % 200) - 100);
    const payload = encodeQuery({ queryId: 5, topK: 5, scale: 0.008, vec, text: 'chest pain' });
    const packet = encodePacket({
      ver: PROTO_VERSION,
      type: PacketType.QUERY,
      ttl: DEFAULT_TTL,
      flags: 0,
      msgId: 42,
      srcId: 7,
      dstId: 0,
      payload,
    });

    const mtu = 185;
    const frames = fragment(packet, mtu);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(mtu);

    const re = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of frames) out = re.push(f) ?? out;
    expect(out).not.toBeNull();
    expect([...out!]).toEqual([...packet]);
    expect(re.pendingCount).toBe(0);
  });

  it('reassembles frames that arrive out of order', () => {
    const packet = new Uint8Array(500).map((_, i) => i % 256);
    const frames = fragment(packet, 100);
    const re = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of [...frames].reverse()) out = re.push(f) ?? out;
    expect([...out!]).toEqual([...packet]);
  });

  it('ignores duplicate frames', () => {
    const packet = new Uint8Array(300).fill(9);
    const frames = fragment(packet, 100);
    const re = new Reassembler();
    expect(re.push(frames[0])).toBeNull();
    expect(re.push(frames[0])).toBeNull();
    let out: Uint8Array | null = null;
    for (const f of frames.slice(1)) out = re.push(f) ?? out;
    expect(out).not.toBeNull();
  });

  it('does not fragment when the packet fits the MTU', () => {
    const packet = new Uint8Array(50);
    expect(fragment(packet, 50 + FRAME_HEADER_BYTES).length).toBe(1);
  });
});

describe('vector search', () => {
  it('keeps cosine similarity within 1% after int8 round-trip', () => {
    const a = new Float32Array(EMBED_DIM).map(() => Math.random() - 0.5);
    let n = Math.hypot(...a);
    for (let i = 0; i < a.length; i++) a[i] /= n;

    const { q, scale } = quantize(a);
    const back = dequantize(q, scale);
    expect(dot(a, back)).toBeGreaterThan(0.99);
  });

  it('ranks the planted vector first', () => {
    const n = 200;
    const matrix = new Float32Array(n * EMBED_DIM).map(() => Math.random() - 0.5);
    const docIds = new Uint32Array(n).map((_, i) => i + 1);
    for (let i = 0; i < n; i++) {
      const off = i * EMBED_DIM;
      let norm = 0;
      for (let d = 0; d < EMBED_DIM; d++) norm += matrix[off + d] ** 2;
      norm = Math.sqrt(norm);
      for (let d = 0; d < EMBED_DIM; d++) matrix[off + d] /= norm;
    }
    const target = matrix.slice(42 * EMBED_DIM, 43 * EMBED_DIM);
    const hits = topK(target, matrix, docIds, 5);
    expect(hits[0].docId).toBe(43);
    expect(hits[0].score).toBeCloseTo(1, 4);
    expect(hits).toHaveLength(5);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it('preserves docIds above 2^31 through storage and lookup', () => {
    // docIds are unsigned 32-bit hashes. Held in an Int32Array they wrapped
    // negative, missed the chunk map keyed on the unsigned value, and were
    // dropped by the `h.chunk &&` guard — silently costing this corpus 58% of
    // its passages with no error raised anywhere. Allocating through
    // makeDocIds is what keeps the shard store and the search path agreeing.
    const big = [178096950, 2907280096, 4140640039];
    const docIds = makeDocIds(big.length);
    big.forEach((id, i) => (docIds[i] = id));
    expect([...docIds]).toEqual(big);

    const matrix = new Float32Array(big.length * EMBED_DIM);
    for (let i = 0; i < big.length; i++) matrix[i * EMBED_DIM] = 1;
    const probe = new Float32Array(EMBED_DIM);
    probe[0] = 1;

    // The lookup the bug actually broke: a hit's docId must find its chunk.
    const chunkById = new Map(big.map((id) => [id, { docId: id }]));
    const hits = topK(probe, matrix, docIds, big.length);
    expect(hits).toHaveLength(big.length);
    for (const hit of hits) expect(chunkById.get(hit.docId)).toBeDefined();
  });
});

/* --------------------------------------------------------------- *
 * Routing — the invariants the whole system depends on
 * --------------------------------------------------------------- */

interface Node {
  id: number;
  transport: MockTransport;
  router: Router;
  delivered: number[];
}

function buildMesh(count: number, ttl = DEFAULT_TTL): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    const transport = new MockTransport(`t${i}`);
    const id = i + 1;
    const router = new Router({ nodeId: id, transport, defaultTtl: ttl });
    const delivered: number[] = [];
    router.on('deliver', (pkt) => delivered.push(pkt.msgId));
    router.start();
    nodes.push({ id, transport, router, delivered });
  }
  return nodes;
}

function line(nodes: Node[]) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].transport.link(nodes[i + 1].transport);
}

const HELLO = () => encodeHello({ shardId: 0, docCount: 0, caps: 0, name: 'n' });

describe('router', () => {
  it('floods a broadcast to every node in a line', () => {
    const nodes = buildMesh(5, 8);
    line(nodes);
    nodes[0].router.send(PacketType.HELLO, HELLO());
    for (const n of nodes.slice(1)) expect(n.delivered).toHaveLength(1);
    expect(nodes[0].delivered).toHaveLength(0); // never delivers to itself
  });

  it('stops a flood at the TTL horizon', () => {
    // TTL 2 from node 1: node 2 receives it (ttl 2), forwards at ttl 1 to node
    // 3, which receives and then drops. Nodes 4 and 5 never see it.
    const nodes = buildMesh(5, 2);
    line(nodes);
    nodes[0].router.send(PacketType.HELLO, HELLO());
    const reached = nodes.filter((n) => n.delivered.length > 0).map((n) => n.id);
    expect(reached).toEqual([2, 3]);
  });

  it('terminates in a ring without duplicate delivery', () => {
    const nodes = buildMesh(4, 16);
    line(nodes);
    nodes[3].transport.link(nodes[0].transport); // close the ring

    nodes[0].router.send(PacketType.HELLO, HELLO());

    for (const n of nodes.slice(1)) {
      expect(n.delivered).toHaveLength(1); // each node handles it exactly once
    }
    // The originator sees the packet come back around and discards it.
    expect(nodes[0].delivered).toHaveLength(0);
    for (const n of nodes) expect(n.router.stats.duplicates).toBeGreaterThanOrEqual(0);
    const totalDupes = nodes.reduce((s, n) => s + n.router.stats.duplicates, 0);
    expect(totalDupes).toBeGreaterThan(0); // proof the dedup cache did the work
  });

  it('learns a route backwards and unicasts the reply along it', () => {
    const nodes = buildMesh(3, 8);
    line(nodes); // 1 -- 2 -- 3

    // Node 1 floods a query; node 3 hears it two hops away.
    nodes[0].router.send(PacketType.QUERY, new Uint8Array([1]));
    expect(nodes[2].delivered).toHaveLength(1);

    // Node 3 now knows how to reach node 1 without flooding.
    const route = nodes[2].router.getRoutes().get(1);
    expect(route).toBeDefined();
    expect(route!.peerId).toBe('t1');

    const before = nodes[1].router.stats.forwarded;
    nodes[2].router.send(PacketType.RESULT, new Uint8Array([2]), 1);
    expect(nodes[0].delivered).toHaveLength(1);
    expect(nodes[1].router.stats.forwarded).toBe(before + 1);
    // The middle node relayed it but did not deliver it to itself.
    expect(nodes[1].delivered).toHaveLength(1); // only the original broadcast
  });

  it('reroutes around a broken link', () => {
    // Diamond: 1 reaches 4 via either 2 or 3.
    const nodes = buildMesh(4, 8);
    nodes[0].transport.link(nodes[1].transport);
    nodes[0].transport.link(nodes[2].transport);
    nodes[1].transport.link(nodes[3].transport);
    nodes[2].transport.link(nodes[3].transport);

    nodes[0].router.send(PacketType.QUERY, new Uint8Array([1]));
    expect(nodes[3].delivered).toHaveLength(1);

    const firstHop = nodes[3].router.getRoutes().get(1)!.peerId;
    const severed = firstHop === 't1' ? nodes[1] : nodes[2];
    nodes[3].transport.unlink(severed.transport);

    // The learned next hop is gone; the router must relearn rather than drop.
    nodes[0].router.send(PacketType.QUERY, new Uint8Array([2]));
    expect(nodes[3].delivered).toHaveLength(2);
    expect(nodes[3].router.getRoutes().get(1)!.peerId).not.toBe(firstHop);

    nodes[3].router.send(PacketType.RESULT, new Uint8Array([3]), 1);
    expect(nodes[0].delivered).toHaveLength(1);
  });

  it('reports an unreachable destination instead of silently dropping', () => {
    const nodes = buildMesh(2, 4);
    const undeliverable: number[] = [];
    const isolated = new MockTransport('t-alone');
    const router = new Router({
      nodeId: 99,
      transport: isolated,
      onUndeliverable: (pkt) => undeliverable.push(pkt.msgId),
    });
    router.start();
    router.send(PacketType.RESULT, new Uint8Array([1]), nodes[0].id);
    expect(undeliverable).toHaveLength(1);
  });
});

describe('hop counting', () => {
  it('reports 1 hop for a direct neighbour regardless of launch TTL', () => {
    // Regression: HELLO launches at TTL 2 while queries launch at 4. Deriving
    // hops from the local default made a direct peer look 3 hops away.
    const nodes = buildMesh(3, 4);
    line(nodes);

    nodes[0].router.send(PacketType.HELLO, HELLO(), BROADCAST, 2);
    expect(nodes[1].router.getRoutes().get(1)!.hops).toBe(1);

    nodes[0].router.send(PacketType.QUERY, new Uint8Array([1]), BROADCAST, 4);
    expect(nodes[1].router.getRoutes().get(1)!.hops).toBe(1);
    expect(nodes[2].router.getRoutes().get(1)!.hops).toBe(2);
  });

  it('computes hops from the packet, not the receiver settings', () => {
    expect(hopsTravelled({ flags: 4, ttl: 4 })).toBe(1);
    expect(hopsTravelled({ flags: 4, ttl: 3 })).toBe(2);
    expect(hopsTravelled({ flags: 2, ttl: 2 })).toBe(1);
    expect(hopsTravelled({ flags: 8, ttl: 5 })).toBe(4);
  });
});
