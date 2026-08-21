/**
 * Local node storage. Every node holds only its own shard — that is the whole
 * point of the system, so nothing here ever sees the full corpus.
 */

import Dexie, { type Table } from 'dexie';

export interface ChunkRow {
  /** Globally unique across the corpus; stable across nodes. */
  docId: number;
  shardId: number;
  title: string;
  section: string;
  text: string;
  source: string;
}

export interface VectorRow {
  docId: number;
  /** int8-quantized embedding: real = q * scale. */
  q: ArrayBuffer;
  scale: number;
}

export interface OutboxRow {
  id?: number;
  dstId: number;
  /** Fully-encoded packet, replayed verbatim once a route reappears. */
  bytes: ArrayBuffer;
  queuedAt: number;
  expiresAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export class MeshNetDB extends Dexie {
  chunks!: Table<ChunkRow, number>;
  vectors!: Table<VectorRow, number>;
  outbox!: Table<OutboxRow, number>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      chunks: 'docId, shardId, title',
      vectors: 'docId',
      outbox: '++id, dstId, expiresAt',
      meta: 'key',
    });
  }
}

let instance: MeshNetDB | null = null;

/**
 * Opens this node's database.
 *
 * The name is scoped to the node id because IndexedDB is shared across every
 * tab of an origin. Without the suffix, two tabs would be two nodes sharing
 * one shard — which is exactly the thing this system is supposed to disprove.
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

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db().meta.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db().meta.put({ key, value });
}

/** Wipes the shard index so a node can be reassigned to a different shard. */
export async function clearIndex(): Promise<void> {
  const d = db();
  await d.transaction('rw', d.chunks, d.vectors, async () => {
    await d.chunks.clear();
    await d.vectors.clear();
  });
}
