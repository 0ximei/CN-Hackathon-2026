import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_REPLICAS,
  META_REPLICAS,
  MIN_BODY_REPLICAS,
  evictionOrder,
  hrwScore,
  nodeWeight,
  planFor,
  rankNodes,
  reliabilityOf,
  shouldKeepMeta,
  targetMetaReplicas,
  targetReplicas,
  type NodeInfo,
} from './policy';

const GB = 1024 * 1024 * 1024;

function nodes(count: number, patch: Partial<NodeInfo> = {}): NodeInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: 1000 + i * 7919,
    reliability: 0.95,
    freeBytes: GB,
    ...patch,
  }));
}

describe('node weight', () => {
  it('excludes nodes with no room', () => {
    expect(nodeWeight({ nodeId: 1, reliability: 1, freeBytes: 0 })).toBe(0);
  });

  it('excludes nodes that are almost never around', () => {
    expect(nodeWeight({ nodeId: 1, reliability: 0.01, freeBytes: GB })).toBe(0);
  });

  it('tapers as free space runs down', () => {
    const full = nodeWeight({ nodeId: 1, reliability: 1, freeBytes: GB });
    const tight = nodeWeight({ nodeId: 1, reliability: 1, freeBytes: 256 * 1024 });
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBeLessThan(full);
  });
});

describe('rendezvous placement', () => {
  it('is deterministic and independent of input order', () => {
    const ns = nodes(6);
    const a = rankNodes(12345, ns);
    const b = rankNodes(12345, [...ns].reverse());
    expect(a).toEqual(b);
  });

  it('drops nodes that cannot hold anything', () => {
    const ns = nodes(4);
    ns[2].freeBytes = 0;
    expect(rankNodes(99, ns)).not.toContain(ns[2].nodeId);
  });

  it('spreads chunks roughly evenly across equal nodes', () => {
    const ns = nodes(5);
    const owners = new Map<number, number>();
    for (let docId = 1; docId <= 3000; docId++) {
      const top = rankNodes(docId, ns)[0];
      owners.set(top, (owners.get(top) ?? 0) + 1);
    }
    // Perfect balance is 600 each; allow generous slack for hash noise.
    for (const n of ns) expect(owners.get(n.nodeId)).toBeGreaterThan(420);
  });

  it('gives a heavier node proportionally more chunks', () => {
    const ns = nodes(4, { freeBytes: 256 * 1024 });
    ns[0].freeBytes = GB; // full headroom against ~1/8 headroom
    let heavy = 0;
    for (let docId = 1; docId <= 3000; docId++) {
      if (rankNodes(docId, ns)[0] === ns[0].nodeId) heavy++;
    }
    // Even shares would be 750. The weighting should lift it well past that.
    expect(heavy).toBeGreaterThan(1500);
  });

  it('only re-homes the departed node\'s chunks when a node leaves', () => {
    // The property that makes HRW worth using over a plain modulo mapping:
    // losing a node must not reshuffle chunks that had nothing to do with it.
    const ns = nodes(6);
    const gone = ns[3].nodeId;
    const survivors = ns.filter((n) => n.nodeId !== gone);

    let movedWithoutCause = 0;
    for (let docId = 1; docId <= 2000; docId++) {
      const before = rankNodes(docId, ns)[0];
      const after = rankNodes(docId, survivors)[0];
      if (before !== gone && before !== after) movedWithoutCause++;
    }
    expect(movedWithoutCause).toBe(0);
  });
});

describe('target replica count', () => {
  // These exercise the mechanism, so they pass explicit bounds rather than
  // reading the deployed constants. With the shipped MIN/MAX close together
  // there is no room for a signal to move anything, which is the point of the
  // "deployed bounds" test below — the mechanism is still correct, it is just
  // configured out.
  const WIDE = { min: 1, max: 5 };

  it('holds at the reliability-driven minimum for cold content', () => {
    // Not MIN_BODY_REPLICAS: wanting 1.5 copies online from nodes that are up
    // 95% of the time already costs two copies.
    expect(targetReplicas({ hits: 0, candidates: nodes(6), ...WIDE })).toBe(2);
  });

  it('adds replicas as a chunk gets popular', () => {
    const candidates = nodes(6);
    const cold = targetReplicas({ hits: 0, candidates, ...WIDE });
    const hot = targetReplicas({ hits: 500, candidates, ...WIDE });
    expect(hot).toBeGreaterThan(cold);
    expect(hot).toBeLessThanOrEqual(WIDE.max);
  });

  it('adds replicas when the available nodes are unreliable', () => {
    const solid = targetReplicas({ hits: 0, candidates: nodes(6, { reliability: 0.95 }), ...WIDE });
    const flaky = targetReplicas({ hits: 0, candidates: nodes(6, { reliability: 0.3 }), ...WIDE });
    expect(flaky).toBeGreaterThan(solid);
  });

  it('respects the deployed bounds', () => {
    const candidates = nodes(6);
    const cold = targetReplicas({ hits: 0, candidates });
    const hot = targetReplicas({ hits: 500, candidates });
    expect(cold).toBeGreaterThanOrEqual(Math.min(MIN_BODY_REPLICAS, 6));
    expect(hot).toBeLessThanOrEqual(MAX_BODY_REPLICAS);
    expect(hot).toBeGreaterThanOrEqual(cold);
  });

  it('never asks for more copies than there are nodes', () => {
    expect(targetReplicas({ hits: 10_000, candidates: nodes(2) })).toBe(2);
    expect(targetReplicas({ hits: 10_000, candidates: nodes(1) })).toBe(1);
  });

  it('is zero when nowhere can hold it', () => {
    expect(targetReplicas({ hits: 5, candidates: nodes(3, { freeBytes: 0 }) })).toBe(0);
  });
});

describe('per-chunk plan', () => {
  const ns = nodes(5);
  const docId = 4242;

  it('pulls when it ranks for a chunk it does not have', () => {
    const owner = rankNodes(docId, ns)[0];
    const plan = planFor({
      docId,
      selfId: owner,
      candidates: ns,
      liveHolders: [],
      hits: 0,
      haveBody: false,
    });
    expect(plan.action).toBe('pull');
  });

  it('does nothing when it ranks too low to be a holder', () => {
    const last = rankNodes(docId, ns).at(-1)!;
    const plan = planFor({
      docId,
      selfId: last,
      candidates: ns,
      liveHolders: rankNodes(docId, ns).slice(0, 2),
      hits: 0,
      haveBody: false,
    });
    expect(plan.action).toBe('none');
  });

  it('evicts a chunk it holds but does not rank for, once others cover it', () => {
    const ranked = rankNodes(docId, ns);
    const outsider = ranked.at(-1)!;
    const plan = planFor({
      docId,
      selfId: outsider,
      candidates: ns,
      liveHolders: [...ranked.slice(0, 3), outsider],
      hits: 0,
      haveBody: true,
    });
    expect(plan.action).toBe('evict');
  });

  it('never evicts the last live copy, even under storage pressure', () => {
    // The invariant that outranks every other rule here.
    const outsider = rankNodes(docId, ns).at(-1)!;
    const plan = planFor({
      docId,
      selfId: outsider,
      candidates: ns,
      liveHolders: [outsider],
      hits: 0,
      haveBody: true,
      underPressure: true,
    });
    expect(plan.action).toBe('hold');
    expect(plan.reason).toMatch(/only live copy/);
  });

  it('never evicts below the replica floor under storage pressure', () => {
    const ranked = rankNodes(docId, ns);
    const plan = planFor({
      docId,
      selfId: ranked[0],
      candidates: ns,
      liveHolders: ranked.slice(0, MIN_BODY_REPLICAS),
      hits: 0,
      haveBody: true,
      underPressure: true,
    });
    expect(plan.action).not.toBe('evict');
  });

  it('sheds a well-replicated chunk under pressure even when it ranks for it', () => {
    const ranked = rankNodes(docId, ns);
    const plan = planFor({
      docId,
      selfId: ranked[0],
      candidates: ns,
      liveHolders: ranked,
      hits: 0,
      haveBody: true,
      underPressure: true,
    });
    expect(plan.action).toBe('evict');
  });

  it('converges: enough nodes plan to pull to reach the target', () => {
    const hits = 0;
    const desired = targetReplicas({ hits, candidates: ns });
    const willHold = ns.filter(
      (n) =>
        planFor({
          docId,
          selfId: n.nodeId,
          candidates: ns,
          liveHolders: [],
          hits,
          haveBody: false,
        }).action === 'pull',
    );
    expect(willHold).toHaveLength(desired);
  });

  it('settles: once at target, no node wants to pull or evict', () => {
    const hits = 12;
    const desired = targetReplicas({ hits, candidates: ns });
    const holders = rankNodes(docId, ns).slice(0, desired);
    for (const n of ns) {
      const plan = planFor({
        docId,
        selfId: n.nodeId,
        candidates: ns,
        liveHolders: holders,
        hits,
        haveBody: holders.includes(n.nodeId),
      });
      expect(['hold', 'none']).toContain(plan.action);
    }
  });

  it('re-homes to a survivor when a holder disappears', () => {
    const hits = 0;
    const desired = targetReplicas({ hits, candidates: ns });
    const holders = rankNodes(docId, ns).slice(0, desired);
    const survivors = ns.filter((n) => n.nodeId !== holders[0]);
    const stillLive = holders.slice(1);

    const pullers = survivors.filter(
      (n) =>
        planFor({
          docId,
          selfId: n.nodeId,
          candidates: survivors,
          liveHolders: stillLive,
          hits,
          haveBody: stillLive.includes(n.nodeId),
        }).action === 'pull',
    );
    expect(pullers.length).toBeGreaterThan(0);
  });
});

describe('eviction order', () => {
  it('sheds the most-replicated, least-wanted, stalest chunk first', () => {
    const order = evictionOrder([
      { docId: 1, live: 2, hits: 0, touchedAt: 10, bytes: 100 },
      { docId: 2, live: 5, hits: 0, touchedAt: 50, bytes: 100 },
      { docId: 3, live: 5, hits: 9, touchedAt: 50, bytes: 100 },
    ]);
    expect(order.map((c) => c.docId)).toEqual([2, 3, 1]);
  });
});

describe('reliability', () => {
  it('starts a stranger near the middle rather than at either extreme', () => {
    const fresh = reliabilityOf({ helloSeen: 1, helloExpected: 1, requests: 0, responses: 0 });
    expect(fresh).toBeGreaterThan(0.4);
    expect(fresh).toBeLessThan(0.95);
  });

  it('rewards a peer that keeps showing up', () => {
    const steady = reliabilityOf({
      helloSeen: 200,
      helloExpected: 200,
      requests: 20,
      responses: 20,
    });
    const patchy = reliabilityOf({
      helloSeen: 100,
      helloExpected: 200,
      requests: 20,
      responses: 20,
    });
    expect(steady).toBeGreaterThan(patchy);
    expect(steady).toBeGreaterThan(0.9);
  });

  it('marks down a peer that is reachable but will not serve', () => {
    const serving = reliabilityOf({
      helloSeen: 200,
      helloExpected: 200,
      requests: 40,
      responses: 40,
    });
    const silent = reliabilityOf({
      helloSeen: 200,
      helloExpected: 200,
      requests: 40,
      responses: 2,
    });
    expect(silent).toBeLessThan(serving);
  });

  it('stays inside 0..1 for absurd inputs', () => {
    const r = reliabilityOf({ helloSeen: 5, helloExpected: 0, requests: 0, responses: 99 });
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});

describe('hrw score', () => {
  it('is finite and positive for every id pair', () => {
    for (let i = 0; i < 500; i++) {
      const s = hrwScore(i * 2654435761, { nodeId: i * 40503, reliability: 1, freeBytes: GB });
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe('metadata placement', () => {
  it('bounds carriers at the metadata target', () => {
    const ns = nodes(12);
    for (let docId = 1; docId <= 300; docId++) {
      const carriers = ns.filter((n) => shouldKeepMeta(docId, n.nodeId, ns));
      expect(carriers.length).toBe(targetMetaReplicas(ns.length));
    }
  });

  it('keeps every node a carrier on a mesh no larger than the target', () => {
    const ns = nodes(META_REPLICAS);
    for (const n of ns) expect(shouldKeepMeta(42, n.nodeId, ns)).toBe(true);
  });

  it('ignores free space, so the body tier cannot move the metadata tier', () => {
    const roomy = nodes(9);
    // Same mesh, same ids, wildly different headroom. Metadata placement must
    // not notice: META_REPLICAS controls metadata copies and nothing else.
    const cramped = roomy.map((n, i) => ({ ...n, freeBytes: i % 2 ? 1024 : 8 * GB }));
    for (let docId = 1; docId <= 200; docId++) {
      for (const n of roomy) {
        expect(shouldKeepMeta(docId, n.nodeId, cramped)).toBe(
          shouldKeepMeta(docId, n.nodeId, roomy),
        );
      }
    }
  });

  it('spreads carriers evenly across the mesh', () => {
    const ns = nodes(10);
    const counts = new Map(ns.map((n) => [n.nodeId, 0]));
    for (let docId = 1; docId <= 4000; docId++) {
      for (const n of ns) {
        if (shouldKeepMeta(docId, n.nodeId, ns)) counts.set(n.nodeId, counts.get(n.nodeId)! + 1);
      }
    }
    const expected = (4000 * targetMetaReplicas(ns.length)) / ns.length;
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(expected * 0.7);
      expect(c).toBeLessThan(expected * 1.3);
    }
  });
});

describe('placement symmetry', () => {
  /**
   * Each node ranks candidates from its own view, so the only way the mesh as
   * a whole lands on the target is if no node systematically overrates itself.
   * Scoring self at a perfect 1 does exactly that, and the target is exceeded
   * without any single node doing anything wrong.
   */
  function meanCopies(selfReliability: (peerRel: number) => number): number {
    const ids = [1000, 8919, 16838];
    let held = 0;
    for (let docId = 1; docId <= 3000; docId++) {
      for (const self of ids) {
        const view = ids.map((id) => ({
          nodeId: id,
          reliability: id === self ? selfReliability(0.6) : 0.6,
          freeBytes: GB,
        }));
        const rank = rankNodes(docId, view).indexOf(self);
        if (rank >= 0 && rank < 2) held++;
      }
    }
    return held / 3000;
  }

  it('lands on the target when a node weights itself like its peers', () => {
    expect(meanCopies((peer) => peer)).toBeCloseTo(2, 1);
  });

  it('overshoots the target when a node weights itself at a perfect 1', () => {
    expect(meanCopies(() => 1)).toBeGreaterThan(2.2);
  });
});
