import { EMBED_DIM } from '@core/search/vector';
import { tokenize } from '@core/search/bm25';

/**
 * On-device embeddings, with no model download.
 *
 * The web build runs `Xenova/all-MiniLM-L6-v2` through transformers.js in a Web
 * Worker. Neither half of that survives the port: React Native has no Web
 * Workers, and onnxruntime-web needs a WASM runtime with threads that Hermes
 * does not provide. Running a real transformer on Android means ExecuTorch or
 * a TFLite delegate plus a ~23 MB model fetched over a network — which is the
 * one thing a disaster-response tool cannot assume exists.
 *
 * So this is a hashing embedder: the classic hashing trick, over word unigrams,
 * adjacent bigrams, and character 4-grams inside each word. It is
 * deterministic, instant, needs no download, and never fails. What it is not is
 * semantic — it will match "arterial bleeding" to "bleeding artery" through the
 * shared tokens and the bigram, but it will not match "haemorrhage" to
 * "bleeding", because nothing here has ever read a sentence.
 *
 * That weakness is mostly covered at rank time: `BM25Index` runs alongside and
 * the two are blended, so exact clinical terms — the ones that actually matter
 * in this corpus — score well. Character 4-grams pick up the morphology BM25
 * misses, so "burns", "burned" and "burning" land near each other.
 *
 * To swap in a real model, implement `Embedder` over ExecuTorch or TFLite and
 * pass it to `MeshNode`. Nothing else changes — but note that embeddings ride
 * the wire in QUERY packets, so *every* node in a mesh must use the same one.
 * A mesh with two embedders will happily route packets and return nonsense.
 */
export interface Embedder {
  readonly id: string;
  embed(text: string): Float32Array;
}

/** Two independent 32-bit hashes: one picks the bucket, one picks the sign. */
function hash(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const UNIGRAM_WEIGHT = 1.0;
const BIGRAM_WEIGHT = 0.7;
const CHARGRAM_WEIGHT = 0.35;
const CHAR_N = 4;

export class HashingEmbedder implements Embedder {
  readonly id = 'hashing-v1';

  embed(text: string): Float32Array {
    const vec = new Float32Array(EMBED_DIM);
    const tokens = tokenize(text);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      this.add(vec, token, UNIGRAM_WEIGHT);

      if (i + 1 < tokens.length) {
        this.add(vec, `${token} ${tokens[i + 1]}`, BIGRAM_WEIGHT);
      }

      // Character n-grams are what give this any tolerance for inflection:
      // "burns", "burned" and "burning" share three of them.
      for (let c = 0; c + CHAR_N <= token.length; c++) {
        this.add(vec, token.slice(c, c + CHAR_N), CHARGRAM_WEIGHT);
      }
    }

    return normalize(vec);
  }

  /**
   * Signed hashing. Adding every feature with a positive sign would make each
   * bucket a sum of unrelated counts, and collisions could only ever inflate
   * similarity. A hash-derived sign makes collisions cancel on average instead.
   */
  private add(vec: Float32Array, feature: string, weight: number): void {
    const bucket = hash(feature, 0x811c9dc5) % EMBED_DIM;
    const sign = (hash(feature, 0x9e3779b1) & 1) === 0 ? 1 : -1;
    vec[bucket] += sign * weight;
  }
}

/**
 * Unit length, because everything downstream treats the dot product as cosine
 * similarity — `topK`, the wire score mapping, and the int8 quantiser all
 * assume it.
 */
function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const length = Math.sqrt(sum);
  if (length > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= length;
  }
  return vec;
}

export const embedder = new HashingEmbedder();
