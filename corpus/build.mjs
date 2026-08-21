/**
 * Corpus build: markdown sources -> chunked, sharded JSON served to nodes.
 *
 * Chunks are distributed round-robin across shards rather than grouped by
 * topic. That is deliberate: it guarantees that answering almost any question
 * requires passages from several different nodes, which is the behaviour the
 * whole system exists to demonstrate. Topic-grouped shards would let a single
 * node answer alone and make the mesh look decorative.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(HERE, 'sources');
const OUT = join(HERE, '..', 'public', 'corpus');

const SHARD_COUNT = Number(process.argv[2] ?? 3);
/** Words, not tokens — close enough at this scale and dependency-free. */
const TARGET_WORDS = 190;
const OVERLAP_WORDS = 40;

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Splits a section body into overlapping chunks, respecting sentence bounds. */
function chunkText(text) {
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z(])/))
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = [];
  let words = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join(' '));
    // Carry the tail forward so a fact split across a boundary stays findable.
    const tail = [];
    let carried = 0;
    for (let i = current.length - 1; i >= 0 && carried < OVERLAP_WORDS; i--) {
      tail.unshift(current[i]);
      carried += current[i].split(/\s+/).length;
    }
    current = tail;
    words = carried;
  };

  for (const sentence of sentences) {
    const n = sentence.split(/\s+/).length;
    if (words + n > TARGET_WORDS && words > 0) flush();
    current.push(sentence);
    words += n;
  }
  if (current.length) chunks.push(current.join(' '));

  // The overlap carry can duplicate a final short chunk; drop it if contained.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (chunks[chunks.length - 2].includes(last)) chunks.pop();
  }
  return chunks;
}

function parseDocument(filename, raw) {
  const lines = raw.split('\n');
  let title = filename.replace(/\.md$/, '');
  let source = filename;
  const sections = [];
  let currentHeading = null;
  let buffer = [];

  const flushSection = () => {
    if (currentHeading && buffer.join('\n').trim()) {
      sections.push({ heading: currentHeading, body: buffer.join('\n').trim() });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
    } else if (line.startsWith('source:')) {
      source = line.slice(7).trim();
    } else if (line.startsWith('## ')) {
      flushSection();
      currentHeading = line.slice(3).trim();
    } else {
      buffer.push(line);
    }
  }
  flushSection();
  return { title, source, sections };
}

async function main() {
  const files = (await readdir(SOURCES)).filter((f) => f.endsWith('.md')).sort();
  if (!files.length) throw new Error(`No markdown sources found in ${SOURCES}`);

  const all = [];
  for (const file of files) {
    const { title, source, sections } = parseDocument(file, await readFile(join(SOURCES, file), 'utf8'));
    for (const [sIdx, section] of sections.entries()) {
      for (const [cIdx, text] of chunkText(section.body).entries()) {
        all.push({
          docId: hash32(`${file}#${sIdx}#${cIdx}`),
          title,
          section: section.heading,
          text,
          source,
        });
      }
    }
  }

  const seen = new Set();
  for (const c of all) {
    if (seen.has(c.docId)) throw new Error(`docId collision on "${c.title} / ${c.section}"`);
    seen.add(c.docId);
  }

  const shards = Array.from({ length: SHARD_COUNT }, () => []);
  all.forEach((chunk, i) => shards[i % SHARD_COUNT].push({ ...chunk, shardId: i % SHARD_COUNT }));

  await mkdir(OUT, { recursive: true });
  for (const [id, chunks] of shards.entries()) {
    await writeFile(join(OUT, `shard-${id}.json`), JSON.stringify({ shardId: id, chunks }));
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    shardCount: SHARD_COUNT,
    totalChunks: all.length,
    documents: files.length,
    shards: shards.map((chunks, id) => ({
      id,
      chunks: chunks.length,
      words: chunks.reduce((s, c) => s + c.text.split(/\s+/).length, 0),
      // Shown in the UI so an operator can see this node holds only a slice.
      topics: [...new Set(chunks.map((c) => c.section))].slice(0, 6),
    })),
  };
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`${all.length} chunks from ${files.length} documents -> ${SHARD_COUNT} shards`);
  for (const s of manifest.shards) console.log(`  shard ${s.id}: ${s.chunks} chunks, ${s.words} words`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
