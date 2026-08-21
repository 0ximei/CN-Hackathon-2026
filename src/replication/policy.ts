/**
 * Replication policy — pure functions, no I/O, no clock.
 *
 * Every node runs this independently against the state it has gossiped its way
 * to, and they converge without a coordinator. Two ideas do the work.
 *
 * 1. *Where* a chunk belongs is decided by weighted rendezvous hashing (HRW).
 *    Each node scores itself for a chunk; the top-K scores are the replica set.
 *    Every node computes the same ranking from the same inputs, so no election
 *    or lock is needed. HRW's useful property over a plain hash ring is minimal
 *    disruption: when a node leaves, only the chunks *it* held move, and they
 *    spread across the survivors instead of landing entirely on one neighbour.
 *
 * 2. *How many* replicas a chunk gets is a function of the four signals:
 *
 *      popularity  — hot chunks earn more copies
 *      reliability — flaky holders earn more copies to compensate
 *      capacity    — full nodes stop being chosen (weight goes to zero)
 *      availability— the live replica count is what reconciliation acts on
 *
 * The one invariant that outranks everything: never drop the last copy of a
 * body. Storage pressure can evict anything except that.
 */

/**
 * Floor on body copies.
 *
 * Note this rarely binds: MIN_EXPECTED_ONLINE below is 1.5, and reliability can
 * never exceed 1, so the reliability term alone already asks for two copies.
 * The floor only shows through on a mesh too small to satisfy it.
 */
export const MIN_BODY_REPLICAS = 2;
/** Never more, however popular — past this the marginal availability is noise. */
export const MAX_BODY_REPLICAS = 5;

/**
 * Metadata target. Much higher than the body target so that discovery survives
 * nodes going dark even when the content on them does not.
 *
 * Note this is availability-driven, not primarily size-driven: metadata is a
 * fixed ~620 bytes per chunk, which is cheap against long passages and not
 * especially cheap against short ones. See the note in db.ts.
 */
export const META_REPLICAS = 4;

/** Hits at which a chunk is considered maximally popular. Log-scaled below. */
const POP_REFERENCE = 32;
/** Extra replicas a maximally popular chunk earns over the minimum. */
const POP_GAIN = 2;

/**
 * How many replicas we want to be online at any given moment.
 *
 * This is what turns reliability into replica count: if the nodes holding a
 * chunk are only up half the time, two copies buy one expected-online copy, so
 * the target rises until the expectation clears this bar.
 */
const MIN_EXPECTED_ONLINE = 1.5;

/** Reliability floor, so a single missed beacon cannot zero out a node. */
const MIN_RELIABILITY = 0.05;

export interface NodeInfo {
  nodeId: number;
  /** 0..1, locally observed. Never self-reported. */
  reliability: number;
  /** Bytes this node still has room for. */
  freeBytes: number;
}

/**
 * Free space at which a node is considered to have full headroom.
 *
 * Below it the node's weight tapers off, so placement drifts towards emptier
 * nodes before the full ones start rejecting writes.
 */
const HEADROOM_REFERENCE = 2 * 1024 * 1024;

/** 32-bit mix of two ids. Deterministic everywhere, which HRW requires. */
export function mix32(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A node's suitability to hold anything at all, independent of which chunk.
 *
 * Zero means "do not place here" — either the node is unreachable enough to be
 * useless or it has no room left.
 */
export function nodeWeight(node: NodeInfo): number {
  if (node.freeBytes <= 0) return 0;
  const reliability = clamp(node.reliability, 0, 1);
  if (reliability < MIN_RELIABILITY) return 0;
  const headroom = clamp(node.freeBytes / HEADROOM_REFERENCE, 0, 1);
  return reliability * headroom;
}

/**
 * Weighted rendezvous hash score for one (chunk, node) pair.
 *
 * The `weight / -ln(u)` form is what makes the weighting proportional: a node
 * with twice the weight wins twice as many chunks, rather than merely breaking
 * ties more often.
 */
export function hrwScore(docId: number, node: NodeInfo): number {
  const weight = nodeWeight(node);
  if (weight <= 0) return 0;
  // (h + 0.5) / 2^32 keeps u strictly inside (0, 1): u = 0 would divide by
  // infinity and u = 1 would divide by zero.
  const u = (mix32(docId >>> 0, node.nodeId >>> 0) + 0.5) / 4294967296;
  return weight / -Math.log(u);
}

/**
 * Every eligible node ranked best-first for this chunk.
 *
 * Nodes with zero weight are dropped rather than ranked last — they are not
 * candidates at all, and leaving them in would let a full node be counted
 * towards a replication target it cannot actually satisfy.
 */
export function rankNodes(docId: number, nodes: NodeInfo[]): number[] {
  return nodes
    .map((n) => ({ nodeId: n.nodeId, score: hrwScore(docId, n) }))
    .filter((r) => r.score > 0)
    // Ties break on node id so every node agrees on the order.
    .sort((a, b) => b.score - a.score || a.nodeId - b.nodeId)
    .map((r) => r.nodeId);
}

export interface TargetInput {
  /** Summed popularity across the mesh (a G-counter total). */
  hits: number;
  /** Nodes eligible to hold this chunk. */
  candidates: NodeInfo[];
  /** Bounds override, so the mechanism can be exercised apart from the
   *  deployed setting. Production callers pass neither. */
  min?: number;
  max?: number;
}

/**
 * How many body replicas this chunk should have.
 *
 * Two independent pressures, and the larger wins: how wanted the chunk is, and
 * how untrustworthy the nodes available to hold it are.
 */
export function targetReplicas({ hits, candidates, min, max }: TargetInput): number {
  const lo = min ?? MIN_BODY_REPLICAS;
  const hi = max ?? MAX_BODY_REPLICAS;
  const eligible = candidates.filter((n) => nodeWeight(n) > 0);
  if (!eligible.length) return 0;

  const popNorm = Math.min(1, Math.log1p(Math.max(0, hits)) / Math.log1p(POP_REFERENCE));
  const fromPopularity = lo + Math.round(POP_GAIN * popNorm);

  const meanReliability =
    eligible.reduce((s, n) => s + clamp(n.reliability, 0, 1), 0) / eligible.length;
  const fromReliability = meanReliability > 0
    ? Math.ceil(MIN_EXPECTED_ONLINE / meanReliability)
    : hi;

  const want = Math.max(fromPopularity, fromReliability);
  // Cannot want more copies than there are nodes to put them on. The cap is
  // applied before the floor, not clamped between the two: on a mesh smaller
  // than the floor the floor is unreachable, and asking for two copies on a
  // one-node mesh would leave reconciliation permanently unsatisfied.
  const cap = Math.min(hi, eligible.length);
  return Math.max(Math.min(want, cap), Math.min(lo, cap));
}

/** Metadata target: wide, but still bounded by the mesh size. */
export function targetMetaReplicas(candidateCount: number): number {
  return Math.min(META_REPLICAS, Math.max(1, candidateCount));
}

/**
 * Metadata placement ranking — deliberately blind to free space.
 *
 * `nodeWeight` folds storage headroom in, which is right for bodies and wrong
 * for metadata. A node that has run out of room for bodies is exactly the node
 * that should still be able to say "I know something relevant, and here is who
 * has it". Ranking metadata on headroom would make the metadata tier move
 * whenever the body tier moved, which is the coupling the split exists to
 * avoid: META_REPLICAS should control metadata copies and nothing else.
 *
 * Reliability still counts — metadata on a node that is never up is not
 * discovery.
 */
export function rankForMeta(docId: number, nodes: NodeInfo[]): number[] {
  return rankNodes(
    docId,
    nodes.map((n) => ({ ...n, freeBytes: HEADROOM_REFERENCE })),
  );
}

/** Whether `selfId` is one of the nodes that should carry this chunk's metadata. */
export function shouldKeepMeta(docId: number, selfId: number, nodes: NodeInfo[]): boolean {
  const target = targetMetaReplicas(nodes.length);
  const rank = rankForMeta(docId, nodes).indexOf(selfId);
  return rank >= 0 && rank < target;
}

export type Action = 'pull' | 'evict' | 'hold' | 'none';

export interface PlanInput {
  docId: number;
  selfId: number;
  /** Everyone who could hold this, self included. */
  candidates: NodeInfo[];
  /** Nodes believed to hold the body right now, self included if we do. */
  liveHolders: number[];
  hits: number;
  haveBody: boolean;
  /** True when this node is over its storage budget and wants to shed load. */
  underPressure?: boolean;
}

export interface Plan {
  action: Action;
  /** Target replica count this decision was made against. */
  desired: number;
  /** Where self ranks for this chunk; -1 when self is not a candidate. */
  rank: number;
  live: number;
  reason: string;
}

/**
 * What this node should do about one chunk, right now.
 *
 * Decisions are made against *observed* holders rather than purely computed
 * ones. That matters: nodes weight each other on locally-observed reliability,
 * so two nodes can rank candidates slightly differently. Acting on the real
 * replica count means disagreement converges to slightly-too-many copies
 * instead of a gap, and over-replication is safe where under-replication is not.
 */
export function planFor(input: PlanInput): Plan {
  const { docId, selfId, candidates, liveHolders, hits, haveBody } = input;
  const desired = targetReplicas({ hits, candidates });
  const ranked = rankNodes(docId, candidates);
  const rank = ranked.indexOf(selfId);
  const live = new Set(liveHolders).size;
  const base = { desired, rank, live };

  // Never drop the last copy. This outranks storage pressure, eviction policy,
  // and the ranking itself — a node that is not supposed to hold a chunk still
  // holds it rather than let it disappear from the mesh.
  const lastCopy = haveBody && live <= 1;
  if (lastCopy) return { ...base, action: 'hold', reason: 'only live copy' };

  const shouldHold = rank >= 0 && rank < desired;

  if (shouldHold && !haveBody) {
    // Under-replicated and we are one of the nodes that ought to fix it.
    return { ...base, action: 'pull', reason: `rank ${rank} < target ${desired}` };
  }

  if (haveBody && input.underPressure && live > MIN_BODY_REPLICAS) {
    // Over budget: shed even chunks we rank for, as long as the mesh keeps
    // enough copies without us.
    return { ...base, action: 'evict', reason: 'over storage budget' };
  }

  if (haveBody && !shouldHold && live > desired) {
    return { ...base, action: 'evict', reason: `${live} copies exceeds target ${desired}` };
  }

  if (haveBody) return { ...base, action: 'hold', reason: 'within target' };
  return { ...base, action: 'none', reason: shouldHold ? 'pending pull' : 'not a holder' };
}

/**
 * Eviction order when a node is over budget: least worth keeping first.
 *
 * Ranked by how many copies already exist (shedding a well-replicated chunk
 * costs the mesh least), then by popularity, then by recency of use.
 */
export interface EvictCandidate {
  docId: number;
  live: number;
  hits: number;
  touchedAt: number;
  bytes: number;
}

export function evictionOrder<T extends EvictCandidate>(candidates: T[]): T[] {
  return [...candidates].sort(
    (a, b) => b.live - a.live || a.hits - b.hits || a.touchedAt - b.touchedAt,
  );
}

/* ------------------------------------------------------------------ *
 * Reliability
 * ------------------------------------------------------------------ */

export interface ReliabilityInput {
  helloSeen: number;
  helloExpected: number;
  requests: number;
  responses: number;
}

/**
 * How much this node trusts a peer to still be there later, in 0..1.
 *
 * Beacon regularity is the main signal; answered requests are a secondary one
 * that catches a peer which is reachable but not actually serving. Both use
 * Laplace smoothing so a peer we have barely met sits near the prior instead of
 * scoring 0 or 1 off a single observation — otherwise a node that just joined
 * would either be excluded outright or immediately trusted with replicas.
 */
export function reliabilityOf(s: ReliabilityInput): number {
  const beacon = (s.helloSeen + 2) / (Math.max(s.helloSeen, s.helloExpected) + 4);
  const serve = (s.responses + 1) / (Math.max(s.responses, s.requests) + 2);
  return clamp(0.7 * beacon + 0.3 * serve, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
