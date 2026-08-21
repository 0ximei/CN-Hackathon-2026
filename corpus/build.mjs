/**
 * Sample corpus build.
 *
 * There are no shards any more. Nothing here is assigned to a node, chunked, or
 * embedded — documents enter the mesh by being uploaded, and these are just
 * files a visitor can upload if they do not have their own to hand.
 *
 * Copying the markdown through untouched is deliberate: the sample documents go
 * through exactly the same parse, chunk, embed and announce path as a file
 * dragged in from the desktop. A build step that pre-chunked them would be
 * quietly testing a code path that real uploads never take.
 */

import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(HERE, 'sources');
const OUT = join(HERE, '..', 'public', 'corpus');

/** Rough word count of the prose, ignoring headings and front matter. */
function countWords(raw) {
  return raw
    .split('\n')
    .filter((l) => !l.startsWith('#') && !/^source:/i.test(l))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function titleOf(raw, filename) {
  const heading = raw.split('\n').find((l) => l.startsWith('# '));
  return heading ? heading.slice(2).trim() : filename.replace(/\.md$/, '');
}

async function main() {
  const files = (await readdir(SOURCES)).filter((f) => f.endsWith('.md')).sort();
  if (!files.length) throw new Error(`No markdown sources found in ${SOURCES}`);

  await mkdir(OUT, { recursive: true });

  // Clear shard files left by the previous sharded build so a stale shard-0
  // cannot be fetched by an old cached bundle.
  for (const stale of await readdir(OUT).catch(() => [])) {
    if (/^shard-\d+\.json$/.test(stale)) await rm(join(OUT, stale));
  }

  const samples = [];
  for (const file of files) {
    const raw = await readFile(join(SOURCES, file), 'utf8');
    await writeFile(join(OUT, file), raw);
    samples.push({
      file,
      title: titleOf(raw, file),
      bytes: Buffer.byteLength(raw, 'utf8'),
      words: countWords(raw),
    });
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    documents: samples.length,
    totalWords: samples.reduce((s, d) => s + d.words, 0),
    samples,
  };
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`${samples.length} sample documents (${manifest.totalWords} words) -> ${OUT}`);
  for (const s of samples) console.log(`  ${s.file}: ${s.words} words`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
