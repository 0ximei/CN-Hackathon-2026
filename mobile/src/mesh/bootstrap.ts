import { parseDocument } from '@core/lib/chunk';
import { hash32 } from '@core/lib/ids';

import { SEED_DOCS } from '../corpus/seed';
import type { LocalCatalog } from '../storage/store';

const SEEDED_KEY = 'seeded.v2';
const COVERAGE_KEY = 'coverage.v1';

/**
 * What fraction of the corpus one node keeps the *body* of.
 *
 * Not 1. If every phone held every passage, every query would be answered from
 * local storage and the mesh would be decoration — the demo would prove nothing
 * and neither would the code. At 0.6 a node is missing roughly two passages in
 * five, so a search visibly gains results as peers answer, while three nodes
 * together still cover about 94% of the corpus.
 *
 * Which passages a node keeps is decided by hashing the chunk id with the node
 * id: deterministic, so a reinstall reproduces the same slice, and uncorrelated
 * between nodes, so two phones do not accidentally hold the same two thirds and
 * leave the same third missing.
 */
export const DEFAULT_COVERAGE = 0.6;

export interface SeedReport {
  documents: number;
  /** Chunks this node holds the body of. */
  bodiesKept: number;
  /** Chunks it has metadata for — always the whole corpus. */
  chunksTotal: number;
}

function keeps(docId: number, nodeId: number, coverage: number): boolean {
  if (coverage >= 1) return true;
  return (hash32(`${docId}:${nodeId}`) % 1000) / 1000 < coverage;
}

/**
 * Loads the built-in first-aid corpus on first launch.
 *
 * Metadata for *every* passage, bodies for a slice. That is the two-tier split
 * present from the first launch rather than only after replication has had time
 * to run, and it is what makes a single phone say "knows 43, stores 26" before
 * it has ever met another node. A metadata-only passage is still searchable
 * here — it just cannot be read without asking whoever holds it.
 *
 * Chunking runs on the device rather than at bundle time so a phone splits a
 * document exactly the way the browser build does — same `chunkText`, same
 * content-addressed ids — and a passage that replicates from a laptop to a
 * phone keeps its identity instead of arriving as a near-duplicate.
 */
export async function seedCorpus(
  catalog: LocalCatalog,
  nodeId: number,
  coverage = DEFAULT_COVERAGE,
): Promise<SeedReport> {
  let bodiesKept = 0;
  let chunksTotal = 0;

  for (const doc of SEED_DOCS) {
    const parsed = parseDocument(doc.file, doc.markdown);
    // The origin id is this node: it is the first to publish these passages as
    // far as the mesh is concerned, and it genuinely holds the ones it keeps.
    const { metas } = await catalog.ingestParsed(parsed, nodeId, 'seed', (docId) =>
      keeps(docId, nodeId, coverage),
    );
    chunksTotal += metas.length;
    bodiesKept += metas.filter((m) => catalog.holdsBody(m.docId)).length;
  }

  await catalog.kvSet(SEEDED_KEY, String(Date.now()));
  await catalog.kvSet(COVERAGE_KEY, String(coverage));

  return { documents: SEED_DOCS.length, bodiesKept, chunksTotal };
}

export async function hasSeeded(catalog: LocalCatalog): Promise<boolean> {
  return (await catalog.kvGet(SEEDED_KEY)) !== null;
}

export async function coverageOf(catalog: LocalCatalog): Promise<number> {
  const raw = await catalog.kvGet(COVERAGE_KEY);
  const value = raw === null ? DEFAULT_COVERAGE : Number(raw);
  return Number.isFinite(value) ? value : DEFAULT_COVERAGE;
}

/** Re-slices this node's share of the corpus, for tuning a demo on the spot. */
export async function reseed(
  catalog: LocalCatalog,
  nodeId: number,
  coverage: number,
): Promise<SeedReport> {
  await catalog.clearSeed();
  return seedCorpus(catalog, nodeId, coverage);
}
