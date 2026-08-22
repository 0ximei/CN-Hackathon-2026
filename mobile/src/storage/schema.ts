import * as SQLite from 'expo-sqlite';

import { docKeyOf, parseDocument } from '@core/lib/chunk';
import { quantize } from '@core/search/vector';

import { embedder } from '../search/embedder';
import { toBase64 } from '../lib/base64';
import { SEED_DOCS } from '../corpus/seed';

export const DATABASE = 'meshnet.db';

/**
 * Storage layout, in two tiers.
 *
 * This mirrors the browser build's Dexie schema rather than inventing a second
 * one, because the two are describing the same design: a passage is metadata
 * (title, heading, snippet, embedding — a fixed ~620 bytes) plus a body (the
 * passage itself). Metadata is what makes a passage *findable*; the body is
 * what makes it *readable*. Making discovery highly available is cheap, making
 * content highly available is not, so the two replicate on completely
 * different budgets and a node can know about far more than it stores.
 *
 * The previous mobile schema had one `chunks` table holding both at once,
 * which is why the phone build could not demonstrate any of it: with no way to
 * hold a description without the thing described, "knows 40, stores 12" was
 * not expressible and the replication policy had nothing to decide.
 *
 * Embeddings are stored base64 rather than as BLOBs. A 384-byte vector costs
 * 512 characters that way, which is real but bounded, and it removes every
 * question about how a given expo-sqlite build round-trips binding a typed
 * array — a vector that comes back subtly wrong does not raise an error, it
 * just ranks badly and silently, which is the failure mode this project has
 * already been bitten by once (see the WebGPU note in the root README).
 */
const DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS docs (
  docKey     INTEGER PRIMARY KEY NOT NULL,
  title      TEXT NOT NULL,
  source     TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  chunkCount INTEGER NOT NULL,
  originId   INTEGER NOT NULL,
  createdAt  INTEGER NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'mesh'
);

CREATE TABLE IF NOT EXISTS meta (
  docId     INTEGER PRIMARY KEY NOT NULL,
  docKey    INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  title     TEXT NOT NULL,
  section   TEXT NOT NULL,
  snippet   TEXT NOT NULL,
  q         TEXT NOT NULL,
  scale     REAL NOT NULL,
  bytes     INTEGER NOT NULL,
  originId  INTEGER NOT NULL,
  version   INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meta_docKey ON meta (docKey);

CREATE TABLE IF NOT EXISTS bodies (
  docId     INTEGER PRIMARY KEY NOT NULL,
  text      TEXT NOT NULL,
  storedAt  INTEGER NOT NULL,
  touchedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS holders (
  docId  INTEGER NOT NULL,
  nodeId INTEGER NOT NULL,
  seenAt INTEGER NOT NULL,
  PRIMARY KEY (docId, nodeId)
);
CREATE INDEX IF NOT EXISTS holders_node ON holders (nodeId);

CREATE TABLE IF NOT EXISTS pop (
  docId     INTEGER NOT NULL,
  nodeId    INTEGER NOT NULL,
  hits      INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (docId, nodeId)
);

CREATE TABLE IF NOT EXISTS peerStats (
  nodeId        INTEGER PRIMARY KEY NOT NULL,
  firstSeen     INTEGER NOT NULL,
  lastSeen      INTEGER NOT NULL,
  helloSeen     INTEGER NOT NULL,
  helloExpected INTEGER NOT NULL,
  requests      INTEGER NOT NULL,
  responses     INTEGER NOT NULL,
  freeBytes     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS peerIdentities (
  nodeId       INTEGER PRIMARY KEY NOT NULL,
  publicKeyHex TEXT NOT NULL,
  name         TEXT NOT NULL,
  firstSeen    INTEGER NOT NULL,
  verifiedAt   INTEGER NOT NULL,
  trustedAt    INTEGER NOT NULL,
  state        TEXT NOT NULL,
  detail       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  dstId     INTEGER NOT NULL,
  payload   TEXT NOT NULL,
  queuedAt  INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_dst ON outbox (dstId);
`;

const MIGRATED_KEY = 'schema.twoTier.v1';

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DATABASE);
  await db.execAsync(DDL);
  await migrateFlatChunks(db);
  return db;
}

/**
 * Lifts a pre-two-tier install into the new layout.
 *
 * The old `chunks` table stored metadata and body inseparably, so every row
 * becomes one `meta` plus one `bodies` row and the node starts out holding
 * everything it held before — which is correct, and the replicator will shed
 * whatever it turns out not to rank for on its first pass.
 *
 * The embedding is recomputed rather than migrated because there was never one
 * on disk: the old build re-embedded the whole catalog on every launch, which
 * only worked because the hashing embedder is instant. Recomputing here is the
 * same work, done once.
 *
 * Guarded by a kv flag rather than by "does the old table exist", so a crash
 * midway through does not leave a half-converted catalog that the next launch
 * declines to finish.
 */
async function migrateFlatChunks(db: SQLite.SQLiteDatabase): Promise<void> {
  const done = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', [
    MIGRATED_KEY,
  ]);
  if (done) return;

  const legacy = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'`,
  );

  if (legacy) {
    interface OldChunk {
      docId: number;
      docKey: number;
      seq: number;
      title: string;
      section: string;
      source: string;
      text: string;
      addedAt: number;
      provenance: string;
    }
    const rows = await db.getAllAsync<OldChunk>(
      `SELECT docId, docKey, seq, title, section, source, text, addedAt, provenance FROM chunks`,
    );

    // Seed docKeys are content-addressed, so which of the old rows came from
    // the built-in corpus can be recomputed instead of trusted — the old
    // provenance column went through a buggy migration of its own.
    const seedKeys = new Set(
      SEED_DOCS.map((doc) => {
        const parsed = parseDocument(doc.file, doc.markdown);
        return docKeyOf(parsed.title, parsed.chunks.map((c) => c.text).join('\n'));
      }),
    );

    const byDoc = new Map<number, OldChunk[]>();
    for (const row of rows) {
      const list = byDoc.get(row.docKey);
      if (list) list.push(row);
      else byDoc.set(row.docKey, [row]);
    }

    await db.withTransactionAsync(async () => {
      for (const [docKey, chunks] of byDoc) {
        chunks.sort((a, b) => a.seq - b.seq);
        const bytes = chunks.reduce((n, c) => n + c.text.length, 0);
        const createdAt = Math.min(...chunks.map((c) => c.addedAt || Date.now()));
        const provenance = seedKeys.has(docKey)
          ? 'seed'
          : chunks[0].provenance === 'mesh'
            ? 'mesh'
            : 'local';

        await db.runAsync(
          `INSERT OR IGNORE INTO docs (docKey, title, source, bytes, chunkCount, originId, createdAt, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [docKey, chunks[0].title, chunks[0].source, bytes, chunks.length, 0, createdAt, provenance],
        );

        for (const c of chunks) {
          const { q, scale } = quantize(embedder.embed(`${c.title} - ${c.section}. ${c.text}`));
          await db.runAsync(
            `INSERT OR IGNORE INTO meta
               (docId, docKey, seq, title, section, snippet, q, scale, bytes, originId, version, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              c.docId,
              docKey,
              c.seq,
              c.title,
              c.section,
              c.text.slice(0, 200),
              toBase64(new Uint8Array(q.buffer, q.byteOffset, q.byteLength)),
              scale,
              c.text.length,
              0,
              1,
              createdAt,
            ],
          );
          await db.runAsync(
            `INSERT OR IGNORE INTO bodies (docId, text, storedAt, touchedAt) VALUES (?, ?, ?, ?)`,
            [c.docId, c.text, createdAt, createdAt],
          );
        }
      }
      await db.execAsync('DROP TABLE IF EXISTS chunks');
    });
  }

  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [
    MIGRATED_KEY,
    String(Date.now()),
  ]);
}
