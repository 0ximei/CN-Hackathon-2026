/**
 * Local node storage, split into two tiers.
 *
 * The split is the point of the whole design. A passage is stored as:
 *
 *   metadata  — title, section, snippet, and the int8 embedding.  ~0.6 KB
 *   body      — the full passage text.                            varies
 *
 * Metadata is what you need to *find* something; the body is what you need to
 * *read* it. Finding is worth making highly available, reading is not worth
 * paying for everywhere. So metadata replicates widely and cheaply while
 * bodies replicate to a handful of nodes chosen by the replication policy.
 * A node that holds metadata but not the body can still answer "I know
 * something relevant, and here is who has it".
 *
 * Be honest about the size win: metadata is a *fixed* ~620 bytes, 384 of which
 * is the embedding, so the saving scales with how long the passages are. On
 * the short first-aid samples (~740-byte passages) metadata is nearly half the
 * body and wide replication is barely cheaper. On real documents — a manual, a
 * chapter, anything chunked at 1.5-4 KB — it is a third to a sixth. The
 * structural win holds either way and does not depend on the ratio: discovery
 * stays available when the nodes holding the content do not.
 *
 * No node ever holds the whole corpus, and now no node is *assigned* anything
 * either: documents arrive by upload and spread by policy.
 */

import Dexie, { type Table } from 'dexie';

/** A document as a user uploaded it. Chunks below point back at this. */
export interface DocRow {
  /** Content hash of the whole document — identity, stable across nodes. */
  docKey: number;
  title: string;
  /** Filename, or 'pasted'. */
  source: string;
  /** Total body bytes across every chunk. */
  bytes: number;
  chunkCount: number;
  /** Node that first uploaded it. */
  originId: number;
  createdAt: number;
}

/**
 * Per-chunk metadata: the cheap, widely-replicated tier.
 *
 * Carries the embedding, so a node holding only metadata can still score this
 * chunk against a query and report a hit.
 */
export interface MetaRow {
  /** u32, unique per chunk. Unsigned — see makeDocIds in vector.ts. */
  docId: number;
  docKey: number;
  /** Chunk index within its document. */
  seq: number;
  title: string;
  section: string;
  /** First ~200 chars of the body, enough to rank and preview. */
  snippet: string;
  /** int8-quantized embedding: real = q * scale. */
  q: ArrayBuffer;
  scale: number;
  /** Size of the body this metadata describes, for replication accounting. */
  bytes: number;
  originId: number;
  /** Lamport-ish version so gossip converges on the newest copy. */
  version: number;
  updatedAt: number;
}

/** The expensive tier. Present only on nodes chosen to hold this chunk. */
export interface BodyRow {
  docId: number;
  text: string;
  storedAt: number;
  /** Last time a query or fetch touched it; drives eviction order. */
  touchedAt: number;
}

/**
 * Observed body holders, one row per (chunk, node).
 *
 * Grow-and-expire rather than grow-only: a holder that stops being announced
 * ages out, which is what makes "how many live replicas exist" answerable.
 */
export interface HolderRow {
  docId: number;
  nodeId: number;
  seenAt: number;
}

/**
 * Popularity, as a grow-only counter partitioned by node.
 *
 * Each node counts only its own accesses and gossips that number; a reader
 * sums across nodes. That makes it a G-counter — order-insensitive, duplicate-
 * insensitive, and convergent — which a single shared integer would not be.
 */
export interface PopRow {
  docId: number;
  nodeId: number;
  hits: number;
  updatedAt: number;
}

/**
 * What we have observed about a peer, used to weight it for replica placement.
 *
 * Reliability is *observed locally*, never self-reported: a node claiming to be
 * reliable is not evidence of anything.
 */
export interface PeerStatRow {
  nodeId: number;
  firstSeen: number;
  lastSeen: number;
  /** HELLOs actually received. */
  helloSeen: number;
  /** HELLOs that should have arrived over the time we have known this peer. */
  helloExpected: number;
  /** Body fetches we asked this peer for. */
  requests: number;
  /** ...and how many came back. */
  responses: number;
  /** Free storage the peer advertises, in bytes. */
  freeBytes: number;
}

export interface OutboxRow {
  id?: number;
  dstId: number;
  /** Fully-encoded packet, replayed verbatim once a route reappears. */
  bytes: ArrayBuffer;
  queuedAt: number;
  expiresAt: number;
}

export interface KVRow {
  key: string;
  value: unknown;
}

export class MeshNetDB extends Dexie {
  docs!: Table<DocRow, number>;
  /**
   * Chunk metadata. Named `catalog` rather than `meta` on purpose: v1 had a
   * key/value table called `meta` keyed on `key`, and IndexedDB cannot change
   * a store's primary key in place. Reusing the name would make every upgrade
   * from v1 fail with "not yet support for changing primary key".
   */
  catalog!: Table<MetaRow, number>;
  bodies!: Table<BodyRow, number>;
  holders!: Table<HolderRow, [number, number]>;
  pop!: Table<PopRow, [number, number]>;
  peerStats!: Table<PeerStatRow, number>;
  outbox!: Table<OutboxRow, number>;
  kv!: Table<KVRow, string>;

  constructor(name: string) {
    super(name);

    // v1 was the fixed-shard layout: chunks + vectors keyed by a corpus-wide
    // docId, with no notion of replication. Nothing in it survives the move to
    // uploaded documents, so v2 declares the old stores deleted rather than
    // pretending a migration exists.
    this.version(1).stores({
      chunks: 'docId, shardId, title',
      vectors: 'docId',
      outbox: '++id, dstId, expiresAt',
      meta: 'key',
    });

    this.version(2)
      .stores({
        chunks: null,
        vectors: null,
        meta: null,
        docs: 'docKey, originId, createdAt',
        catalog: 'docId, docKey, originId, updatedAt',
        bodies: 'docId, touchedAt',
        holders: '[docId+nodeId], docId, nodeId, seenAt',
        pop: '[docId+nodeId], docId, nodeId',
        peerStats: 'nodeId, lastSeen',
        outbox: '++id, dstId, expiresAt',
        kv: 'key',
      });
  }
}

let instance: MeshNetDB | null = null;

/**
 * Opens this node's database.
 *
 * The name is scoped to the node id because IndexedDB is shared across every
 * tab of an origin. Without the suffix, two tabs would be one node with one
 * store — which is exactly the thing this system is supposed to disprove.
 */
export function openDb(nodeId: number): MeshNetDB {
  if (instance) return instance;
  instance = new MeshNetDB(`meshnet-${nodeId >>> 0}`);
  return instance;
}

export function db(): MeshNetDB {
  if (!instance) throw new Error('openDb(nodeId) must be called before any storage access');
  return instance;
}

export async function getKV<T>(key: string, fallback: T): Promise<T> {
  const row = await db().kv.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setKV(key: string, value: unknown): Promise<void> {
  await db().kv.put({ key, value });
}

/** Drops everything this node knows. Used when re-indexing or resetting. */
export async function clearAll(): Promise<void> {
  const d = db();
  await d.transaction('rw', d.docs, d.catalog, d.bodies, d.holders, d.pop, async () => {
    await Promise.all([
      d.docs.clear(),
      d.catalog.clear(),
      d.bodies.clear(),
      d.holders.clear(),
      d.pop.clear(),
    ]);
  });
}

/* ------------------------------------------------------------------ *
 * Storage accounting
 * ------------------------------------------------------------------ */

export interface StorageUse {
  /** Bytes of body text held locally. */
  bodyBytes: number;
  /** Bytes of metadata held locally, embeddings included. */
  metaBytes: number;
  bodyCount: number;
  metaCount: number;
  /** Budget this node is willing to spend, in bytes. */
  budgetBytes: number;
  /** Browser-reported quota, when available. */
  quotaBytes: number;
}

/** Fixed overhead per metadata row: 384-byte vector plus scale and ids. */
export const META_FIXED_BYTES = 384 + 4 + 4 + 4 + 4 + 4;

export function metaBytesOf(m: Pick<MetaRow, 'title' | 'section' | 'snippet'>): number {
  return META_FIXED_BYTES + m.title.length + m.section.length + m.snippet.length;
}

/**
 * How much room this node will give the mesh.
 *
 * Deliberately a small slice of the browser quota. A node that fills its origin
 * quota gets its writes rejected mid-flight, and IndexedDB gives no warning
 * before that happens, so the budget stays well under it.
 */
const DEFAULT_BUDGET_BYTES = 8 * 1024 * 1024;
const QUOTA_FRACTION = 0.25;

export async function storageBudget(): Promise<{ budgetBytes: number; quotaBytes: number }> {
  const override = await getKV<number | null>('storageBudget', null);
  let quotaBytes = 0;
  try {
    const est = await navigator.storage?.estimate?.();
    quotaBytes = est?.quota ?? 0;
  } catch {
    /* Firefox in private mode and older Safari throw here; budget falls back. */
  }
  if (override && override > 0) return { budgetBytes: override, quotaBytes };
  const fromQuota = quotaBytes ? Math.floor(quotaBytes * QUOTA_FRACTION) : 0;
  return {
    budgetBytes: Math.max(DEFAULT_BUDGET_BYTES, fromQuota) || DEFAULT_BUDGET_BYTES,
    quotaBytes,
  };
}

export async function storageUse(): Promise<StorageUse> {
  const d = db();
  const [bodies, metas, budget] = await Promise.all([
    d.bodies.toArray(),
    d.catalog.toArray(),
    storageBudget(),
  ]);
  return {
    bodyBytes: bodies.reduce((s, b) => s + b.text.length, 0),
    metaBytes: metas.reduce((s, m) => s + metaBytesOf(m), 0),
    bodyCount: bodies.length,
    metaCount: metas.length,
    budgetBytes: budget.budgetBytes,
    quotaBytes: budget.quotaBytes,
  };
}
