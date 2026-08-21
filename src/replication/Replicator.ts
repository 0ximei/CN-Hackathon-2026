/**
 * The replication control loop.
 *
 * Runs on every node, independently, with no coordinator and no consensus.
 * Each pass asks the same question of every chunk this node knows about —
 * "given who is online, how reliable they are, how full they are, and how
 * popular this chunk is, should I be holding it?" — and acts on the answer.
 *
 * The decisions themselves live in policy.ts as pure functions. This file is
 * the part that touches the network, the clock and the database: gathering the
 * inputs, rate-limiting the actions, and gossiping the results.
 *
 * Two rate limits keep a reconcile pass from turning into a stampede: at most
 * a few body pulls per pass, and metadata announcements batched into small
 * packets. A mesh that reacts instantly to every change spends all its
 * bandwidth reacting.
 */

import {
  META_REPLICAS,
  evictionOrder,
  planFor,
  reliabilityOf,
  targetReplicas,
  type NodeInfo,
} from './policy';
import { db, type MetaRow, type PeerStatRow } from '../search/db';
import type { Catalog } from '../search/catalog';
import type { AnnouncePayload, MetaEntry } from '../protocol/packet';

/** How often to reconcile. Slow enough to be cheap, fast enough to demo. */
const RECONCILE_MS = 6000;
/** Bodies pulled per pass, so a node joining an established mesh trickles in. */
const MAX_PULLS_PER_PASS = 3;
/** Chunks per ANNOUNCE packet. Each entry is ~660 bytes. */
const ENTRIES_PER_ANNOUNCE = 4;
/** Documents re-announced per pass to refresh holder information. */
const REANNOUNCE_PER_PASS = 1;

/**
 * Counter window before halving.
 *
 * Reliability has to be able to recover: a node that was flaky for an hour and
 * has been solid since should not be judged on the hour forever. Halving both
 * numerator and denominator keeps the ratio while letting recent behaviour
 * dominate — an EWMA in integer clothing.
 */
const STAT_WINDOW = 200;

/** A holder record older than this is not evidence anybody still has it. */
const HOLDER_TTL_MS = 60_000;

/**
 * Headroom multiple required before pulling a body.
 *
 * Hysteresis, not caution. Pulling right up to the budget means the next pass
 * finds the node over budget and evicts what it just pulled, then has room and
 * pulls again — a node on a tight budget thrashes forever, burning bandwidth
 * and never settling. Requiring room for the body several times over makes it
 * come to rest holding metadata plus whatever genuinely fits.
 */
const PULL_HEADROOM = 3;

export interface ReplicaInfo {
  docId: number;
  title: string;
  section: string;
  bytes: number;
  hits: number;
  liveHolders: number[];
  desired: number;
  haveBody: boolean;
}

export interface DocReplicaInfo {
  docKey: number;
  title: string;
  source: string;
  chunkCount: number;
  bytes: number;
  originId: number;
  /** Mean live body replicas across this document's chunks. */
  meanReplicas: number;
  /** Chunks of this document whose body is stored here. */
  storedHere: number;
  desired: number;
  hits: number;
}

export interface ReplicationStats {
  /** Chunks known (metadata) vs stored (body). */
  known: number;
  stored: number;
  /** Chunks whose live replica count is below target. */
  underReplicated: number;
  /** Chunks with exactly one live copy — the ones at risk. */
  atRisk: number;
  metaBytes: number;
  bodyBytes: number;
  budgetBytes: number;
  freeBytes: number;
  underPressure: boolean;
  lastPass: number;
  pulls: number;
  evictions: number;
}

export interface PeerReliability {
  nodeId: number;
  reliability: number;
  freeBytes: number;
}

export interface ReplicatorDeps {
  selfId: number;
  catalog: Catalog;
  /** Live peers, from the mesh node's beacon table. */
  livePeers: () => { nodeId: number; freeBytes: number }[];
  announce: (payload: AnnouncePayload, dstId?: number) => void;
  /** Pulls one body from a specific peer. Resolves null on timeout. */
  fetchBody: (docId: number, fromNodeId: number) => Promise<string | null>;
  onStats?: (s: ReplicationStats) => void;
  /** Surfaced in the activity log so replication is visible, not magic. */
  onEvent?: (e: { kind: 'pull' | 'evict'; docId: number; title: string; detail: string }) => void;
}

export class Replicator {
  private timer: number | null = null;
  private stats: ReplicationStats = {
    known: 0,
    stored: 0,
    underReplicated: 0,
    atRisk: 0,
    metaBytes: 0,
    bodyBytes: 0,
    budgetBytes: 0,
    freeBytes: 0,
    underPressure: false,
    lastPass: 0,
    pulls: 0,
    evictions: 0,
  };

  /** Cached per-peer reliability, refreshed each pass. */
  private reliabilityCache = new Map<number, number>();
  private reannounceCursor = 0;
  private running = false;

  constructor(private deps: ReplicatorDeps) {}

  start() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS) as unknown as number;
    // One immediate pass so a fresh node does not wait a full interval before
    // discovering it should be holding something.
    void this.reconcile();
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  getStats(): ReplicationStats {
    return { ...this.stats };
  }

  /* ---------------- peer observation ---------------- */

  /**
   * Records that a peer's beacon arrived.
   *
   * `helloExpected` is advanced by tickExpectations on a timer rather than
   * here, so a peer that goes quiet accrues misses while a peer that beacons
   * normally stays level.
   */
  async noteHello(nodeId: number, freeBytes: number): Promise<void> {
    const now = Date.now();
    const row = (await db().peerStats.get(nodeId)) ?? blankStat(nodeId, now);
    row.lastSeen = now;
    row.helloSeen += 1;
    row.freeBytes = freeBytes;
    if (row.helloSeen > row.helloExpected) row.helloExpected = row.helloSeen;
    await db().peerStats.put(decay(row));
  }

  /** Advances the "should have heard from you" counter for every known peer. */
  async tickExpectations(livePeerIds: number[]): Promise<void> {
    const live = new Set(livePeerIds);
    const rows = await db().peerStats.toArray();
    const updates = rows
      .filter((r) => live.has(r.nodeId))
      .map((r) => decay({ ...r, helloExpected: r.helloExpected + 1 }));
    if (updates.length) await db().peerStats.bulkPut(updates);
  }

  async noteRequest(nodeId: number): Promise<void> {
    const now = Date.now();
    const row = (await db().peerStats.get(nodeId)) ?? blankStat(nodeId, now);
    row.requests += 1;
    await db().peerStats.put(decay(row));
  }

  async noteResponse(nodeId: number): Promise<void> {
    const now = Date.now();
    const row = (await db().peerStats.get(nodeId)) ?? blankStat(nodeId, now);
    row.responses += 1;
    row.lastSeen = now;
    await db().peerStats.put(decay(row));
  }

  async peerReliability(): Promise<PeerReliability[]> {
    const rows = await db().peerStats.toArray();
    return rows.map((r) => ({
      nodeId: r.nodeId,
      reliability: reliabilityOf(r),
      freeBytes: r.freeBytes,
    }));
  }

  /* ---------------- popularity ---------------- */

  /**
   * Counts an access to a chunk.
   *
   * Only ever increments this node's own share of the counter. Summing shares
   * across nodes is what makes popularity a G-counter rather than a number two
   * nodes can disagree about permanently.
   */
  async recordHit(docIds: number[]): Promise<void> {
    if (!docIds.length) return;
    const now = Date.now();
    const self = this.deps.selfId;
    await db().transaction('rw', db().pop, async () => {
      for (const docId of docIds) {
        const row = await db().pop.get([docId, self]);
        await db().pop.put({
          docId,
          nodeId: self,
          hits: (row?.hits ?? 0) + 1,
          updatedAt: now,
        });
      }
    });
  }

  private async popularityMap(): Promise<Map<number, number>> {
    const rows = await db().pop.toArray();
    const out = new Map<number, number>();
    for (const r of rows) out.set(r.docId, (out.get(r.docId) ?? 0) + r.hits);
    return out;
  }

  /* ---------------- holders ---------------- */

  /**
   * Who holds what, as best this node can tell.
   *
   * Remote claims expire, because a peer that stopped announcing is not
   * evidence of anything. Our *own* holdings never do: the body store is
   * ground truth, not a claim, and ageing it out made a restarted node stop
   * telling anyone it had the only copy of a document it was still holding —
   * which left every peer seeing zero live replicas and nobody pulling.
   */
  private async holderMap(): Promise<Map<number, Set<number>>> {
    const cutoff = Date.now() - HOLDER_TTL_MS;
    const rows = await db().holders.toArray();
    const out = new Map<number, Set<number>>();
    const add = (docId: number, nodeId: number) => {
      let set = out.get(docId);
      if (!set) out.set(docId, (set = new Set()));
      set.add(nodeId);
    };

    for (const r of rows) {
      if (r.seenAt < cutoff && r.nodeId !== this.deps.selfId) continue;
      add(r.docId, r.nodeId);
    }
    for (const meta of this.deps.catalog.metas()) {
      if (this.deps.catalog.holdsBody(meta.docId)) add(meta.docId, this.deps.selfId);
    }
    return out;
  }

  /**
   * Re-stamps our own holder rows so peers keep hearing a live claim.
   *
   * Without this the rows we wrote at upload time age past HOLDER_TTL_MS on
   * every *other* node and our copies vanish from their replica counts.
   */
  private async refreshOwnHolders(): Promise<void> {
    const now = Date.now();
    const mine = this.deps.catalog
      .metas()
      .filter((m) => this.deps.catalog.holdsBody(m.docId))
      .map((m) => ({ docId: m.docId, nodeId: this.deps.selfId, seenAt: now }));
    if (mine.length) await db().holders.bulkPut(mine);
  }

  /** Records that a node holds a body, from gossip or from our own action. */
  async noteHolder(docId: number, nodeId: number): Promise<void> {
    await db().holders.put({ docId, nodeId, seenAt: Date.now() });
  }

  private async dropHolder(docId: number, nodeId: number): Promise<void> {
    await db().holders.delete([docId, nodeId]);
  }

  /* ---------------- gossip ---------------- */

  /** Applies metadata, holder claims and popularity shares learned from a peer. */
  async onAnnounce(payload: AnnouncePayload, fromNodeId: number): Promise<number> {
    const now = Date.now();
    const metas: MetaRow[] = payload.entries.map((e) => ({
      docId: e.docId,
      docKey: payload.docKey,
      seq: e.seq,
      title: payload.title,
      section: e.section,
      snippet: e.snippet,
      q: e.vec.buffer.slice(e.vec.byteOffset, e.vec.byteOffset + e.vec.byteLength) as ArrayBuffer,
      scale: e.scale,
      bytes: e.bytes,
      originId: e.originId,
      version: e.version,
      updatedAt: now,
    }));

    const added = await this.deps.catalog.ingestMeta(metas, {
      docKey: payload.docKey,
      title: payload.title,
      source: payload.source,
      bytes: payload.docBytes,
      chunkCount: payload.chunkCount,
      originId: payload.docOriginId,
      createdAt: payload.createdAtSec * 1000,
    });

    // Holder claims and popularity shares are recorded whether or not the
    // metadata was new — a re-announcement exists precisely to refresh these.
    await db().transaction('rw', db().holders, db().pop, async () => {
      for (const e of payload.entries) {
        for (const holder of e.holders) {
          await db().holders.put({ docId: e.docId, nodeId: holder, seenAt: now });
        }
        if (e.hits > 0) {
          const existing = await db().pop.get([e.docId, fromNodeId]);
          // max, not add: a re-announcement of the same share must not inflate
          // the total. G-counter shares are monotonic per node.
          await db().pop.put({
            docId: e.docId,
            nodeId: fromNodeId,
            hits: Math.max(existing?.hits ?? 0, e.hits),
            updatedAt: now,
          });
        }
      }
    });

    return added;
  }

  /** Builds ANNOUNCE packets for a document and hands them to the sender. */
  async announceDocument(docKey: number, dstId?: number): Promise<void> {
    const doc = await db().docs.get(docKey);
    if (!doc) return;
    const metas = await db().catalog.where('docKey').equals(docKey).sortBy('seq');
    if (!metas.length) return;

    const [holders, pop] = await Promise.all([this.holderMap(), this.popularityMap()]);
    const selfPop = await db().pop.where('nodeId').equals(this.deps.selfId).toArray();
    const selfHits = new Map(selfPop.map((r) => [r.docId, r.hits]));

    for (let i = 0; i < metas.length; i += ENTRIES_PER_ANNOUNCE) {
      const slice = metas.slice(i, i + ENTRIES_PER_ANNOUNCE);
      const entries: MetaEntry[] = slice.map((m) => ({
        docId: m.docId,
        seq: m.seq,
        version: m.version,
        section: m.section,
        snippet: m.snippet,
        bytes: m.bytes,
        originId: m.originId,
        scale: m.scale,
        vec: new Int8Array(m.q),
        holders: [...(holders.get(m.docId) ?? [])],
        // Only ever gossip *our own* share of the counter. Forwarding someone
        // else's share under our node id would double-count it on the receiver.
        hits: selfHits.get(m.docId) ?? 0,
      }));
      void pop;

      this.deps.announce(
        {
          docKey: doc.docKey,
          title: doc.title,
          source: doc.source,
          docBytes: doc.bytes,
          chunkCount: doc.chunkCount,
          docOriginId: doc.originId,
          createdAtSec: Math.floor(doc.createdAt / 1000),
          entries,
        },
        dstId,
      );
    }
  }

  /** Answers a joining node's anti-entropy request. */
  async serveCatalogRequest(sinceSec: number, dstId: number, max: number): Promise<void> {
    const since = sinceSec * 1000;
    const docs = await db().docs.toArray();
    let sent = 0;
    for (const doc of docs.sort((a, b) => a.createdAt - b.createdAt)) {
      if (sent >= max) break;
      if (doc.createdAt < since) continue;
      await this.announceDocument(doc.docKey, dstId);
      sent += doc.chunkCount;
    }
  }

  /* ---------------- the loop ---------------- */

  /**
   * One reconciliation pass.
   *
   * Deliberately serial and re-entrant-guarded: two overlapping passes would
   * both see the same under-replication and both pull, which is how you get a
   * thundering herd against whichever node happens to hold a popular chunk.
   */
  async reconcile(): Promise<void> {
    if (this.running || !this.deps.catalog.ready) return;
    this.running = true;
    try {
      const catalog = this.deps.catalog;
      const selfId = this.deps.selfId;

      const usage = await catalog.usage();
      const underPressure = usage.freeBytes <= 0;

      // Assert what we hold before reading anyone's view of it.
      await this.refreshOwnHolders();

      const live = this.deps.livePeers();
      await this.tickExpectations(live.map((p) => p.nodeId));

      const reliabilities = await this.peerReliability();
      this.reliabilityCache = new Map(reliabilities.map((r) => [r.nodeId, r.reliability]));

      // Candidates are the nodes that could hold a body *right now*: live peers
      // plus ourselves. A node that has gone dark is not a placement target, no
      // matter how reliable it used to be.
      const candidates: NodeInfo[] = [
        { nodeId: selfId, reliability: 1, freeBytes: usage.freeBytes },
        ...live.map((p) => ({
          nodeId: p.nodeId,
          reliability: this.reliabilityCache.get(p.nodeId) ?? 0.5,
          freeBytes: p.freeBytes,
        })),
      ];
      const liveIds = new Set(candidates.map((c) => c.nodeId));

      const [holders, pop] = await Promise.all([this.holderMap(), this.popularityMap()]);
      const metas = catalog.metas();

      const pulls: { docId: number; from: number; meta: MetaRow }[] = [];
      const evicts: {
        docId: number;
        live: number;
        hits: number;
        touchedAt: number;
        bytes: number;
        meta: MetaRow;
      }[] = [];
      let underReplicated = 0;
      let atRisk = 0;

      for (const meta of metas) {
        const claimed = holders.get(meta.docId) ?? new Set<number>();
        const haveBody = catalog.holdsBody(meta.docId);
        // Only count holders we can actually see. A holder that is offline is
        // not availability, and treating it as such is how data quietly goes to
        // zero replicas while the UI reports it as safe.
        const liveHolders = [...claimed].filter((id) => liveIds.has(id));
        if (haveBody && !liveHolders.includes(selfId)) liveHolders.push(selfId);

        const hits = pop.get(meta.docId) ?? 0;
        const plan = planFor({
          docId: meta.docId,
          selfId,
          candidates,
          liveHolders,
          hits,
          haveBody,
          underPressure,
        });

        if (liveHolders.length < plan.desired) underReplicated++;
        if (liveHolders.length <= 1) atRisk++;

        if (plan.action === 'pull') {
          const source = liveHolders.find((id) => id !== selfId);
          if (source !== undefined) pulls.push({ docId: meta.docId, from: source, meta });
        } else if (plan.action === 'evict') {
          evicts.push({
            docId: meta.docId,
            live: liveHolders.length,
            hits,
            touchedAt: 0,
            bytes: meta.bytes,
            meta,
          });
        }
      }

      // Pull the most at-risk chunks first: fewest live copies, then most
      // wanted. Without the ordering a pass spends its budget on whatever
      // happened to be early in the catalog.
      pulls.sort((a, b) => {
        const la = (holders.get(a.docId)?.size ?? 0) - (holders.get(b.docId)?.size ?? 0);
        return la || (pop.get(b.docId) ?? 0) - (pop.get(a.docId) ?? 0);
      });

      let pulled = 0;
      let budgetLeft = usage.freeBytes;
      for (const p of pulls.slice(0, MAX_PULLS_PER_PASS)) {
        if (budgetLeft < p.meta.bytes * PULL_HEADROOM) break;
        const text = await this.deps.fetchBody(p.docId, p.from);
        if (text === null) {
          // The holder did not answer. Its reliability already took the hit via
          // noteRequest/noteResponse; drop the stale claim so the next pass
          // looks elsewhere instead of retrying the same dead peer.
          await this.dropHolder(p.docId, p.from);
          continue;
        }
        await catalog.putBody(p.docId, text);
        await this.noteHolder(p.docId, selfId);
        budgetLeft -= text.length;
        pulled++;
        this.deps.onEvent?.({
          kind: 'pull',
          docId: p.docId,
          title: p.meta.title,
          detail: `${p.meta.section || 'passage'} — replicated here`,
        });
      }

      let evicted = 0;
      if (evicts.length) {
        const bodies = await db().bodies.bulkGet(evicts.map((e) => e.docId));
        evicts.forEach((e, i) => (e.touchedAt = bodies[i]?.touchedAt ?? 0));
        for (const e of evictionOrder(evicts)) {
          await catalog.evictBody(e.docId);
          await this.dropHolder(e.docId, selfId);
          evicted++;
          this.deps.onEvent?.({
            kind: 'evict',
            docId: e.docId,
            title: e.meta.title,
            detail: `${e.live} copies elsewhere — freed ${e.bytes} B`,
          });
          // Under pressure keep going until back inside budget; otherwise one
          // eviction per pass is enough to converge without thrashing.
          if (!underPressure) break;
        }
      }

      // Refresh a rotating slice of our documents so holder claims and
      // popularity shares stay live rather than ageing out of everyone's map.
      await this.reannounceSlice();

      const after = await catalog.usage();
      this.stats = {
        known: catalog.knownCount,
        stored: catalog.storedCount,
        underReplicated,
        atRisk,
        metaBytes: after.metaBytes,
        bodyBytes: after.bodyBytes,
        budgetBytes: after.budgetBytes,
        freeBytes: after.freeBytes,
        underPressure,
        lastPass: Date.now(),
        pulls: this.stats.pulls + pulled,
        evictions: this.stats.evictions + evicted,
      };
      this.deps.onStats?.(this.getStats());
    } finally {
      this.running = false;
    }
  }

  private async reannounceSlice(): Promise<void> {
    const docs = await db().docs.toArray();
    if (!docs.length) return;
    for (let i = 0; i < REANNOUNCE_PER_PASS; i++) {
      const doc = docs[this.reannounceCursor % docs.length];
      this.reannounceCursor++;
      await this.announceDocument(doc.docKey);
    }
  }

  /* ---------------- reporting ---------------- */

  /** Per-document replication view for the UI. */
  async documentReport(): Promise<DocReplicaInfo[]> {
    const catalog = this.deps.catalog;
    const [docs, holders, pop] = await Promise.all([
      catalog.documents(),
      this.holderMap(),
      this.popularityMap(),
    ]);

    const live = this.deps.livePeers();
    const usage = await catalog.usage();
    const candidates: NodeInfo[] = [
      { nodeId: this.deps.selfId, reliability: 1, freeBytes: usage.freeBytes },
      ...live.map((p) => ({
        nodeId: p.nodeId,
        reliability: this.reliabilityCache.get(p.nodeId) ?? 0.5,
        freeBytes: p.freeBytes,
      })),
    ];
    const liveIds = new Set(candidates.map((c) => c.nodeId));

    const byKey = new Map<number, MetaRow[]>();
    for (const m of catalog.metas()) {
      const list = byKey.get(m.docKey);
      if (list) list.push(m);
      else byKey.set(m.docKey, [m]);
    }

    return docs.map((doc) => {
      const metas = byKey.get(doc.docKey) ?? [];
      let replicaTotal = 0;
      let storedHere = 0;
      let hits = 0;
      let desired = 0;

      for (const m of metas) {
        const claimed = holders.get(m.docId) ?? new Set<number>();
        const liveHolders = [...claimed].filter((id) => liveIds.has(id));
        if (catalog.holdsBody(m.docId)) {
          storedHere++;
          if (!liveHolders.includes(this.deps.selfId)) liveHolders.push(this.deps.selfId);
        }
        replicaTotal += liveHolders.length;
        const h = pop.get(m.docId) ?? 0;
        hits += h;
        desired = Math.max(desired, targetReplicas({ hits: h, candidates }));
      }

      return {
        docKey: doc.docKey,
        title: doc.title,
        source: doc.source,
        chunkCount: doc.chunkCount,
        bytes: doc.bytes,
        originId: doc.originId,
        meanReplicas: metas.length ? replicaTotal / metas.length : 0,
        storedHere,
        desired,
        hits,
      };
    });
  }

  /** Target metadata replica count, for display alongside the body target. */
  metaTarget(peerCount: number): number {
    return Math.min(META_REPLICAS, peerCount + 1);
  }
}

function blankStat(nodeId: number, now: number): PeerStatRow {
  return {
    nodeId,
    firstSeen: now,
    lastSeen: now,
    helloSeen: 0,
    helloExpected: 0,
    requests: 0,
    responses: 0,
    freeBytes: 0,
  };
}

/**
 * Halves the counters once they get large.
 *
 * Keeps the ratio intact while letting a peer live down an old bad patch —
 * without this, reliability is an average over all time and a node that was
 * offline early can never fully recover.
 */
function decay(row: PeerStatRow): PeerStatRow {
  if (row.helloExpected < STAT_WINDOW && row.requests < STAT_WINDOW) return row;
  return {
    ...row,
    helloSeen: Math.floor(row.helloSeen / 2),
    helloExpected: Math.floor(row.helloExpected / 2),
    requests: Math.floor(row.requests / 2),
    responses: Math.floor(row.responses / 2),
  };
}
