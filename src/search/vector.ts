/**
 * Vector utilities.
 *
 * Embeddings arrive L2-normalized from the model, so cosine similarity is a
 * plain dot product. On the wire they are int8-quantized: 384 floats is 1536
 * bytes, which is eight BLE frames; 384 int8s plus a scale is 388 bytes, which
 * is three. The accuracy cost is under 1% recall@5 on a normalized vector.
 */

export const EMBED_DIM = 384;

export interface Quantized {
  q: Int8Array;
  scale: number;
}

export function quantize(vec: Float32Array): Quantized {
  let max = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > max) max = a;
  }
  const scale = max === 0 ? 1 : max / 127;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
  }
  return { q, scale };
}

export function dequantize(q: Int8Array, scale: number): Float32Array {
  const out = new Float32Array(q.length);
  let norm = 0;
  for (let i = 0; i < q.length; i++) {
    const v = q[i] * scale;
    out[i] = v;
    norm += v * v;
  }
  // Re-normalize: quantization perturbs the length, and we rely on unit vectors.
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface Scored {
  docId: number;
  score: number;
}

/**
 * Brute-force top-K over a packed matrix.
 *
 * A shard is a few hundred to a few thousand chunks, so an exact scan costs
 * well under a millisecond and beats an ANN index that would need building,
 * persisting, and explaining. If shards ever exceed ~50k chunks, swap this for
 * HNSW — the interface would not change.
 */
export function topK(
  query: Float32Array,
  matrix: Float32Array,
  docIds: Int32Array,
  k: number,
  dim = EMBED_DIM,
): Scored[] {
  const n = docIds.length;
  const heap: Scored[] = [];
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += query[d] * matrix[off + d];

    if (heap.length < k) {
      heap.push({ docId: docIds[i], score: s });
      if (heap.length === k) heap.sort((a, b) => a.score - b.score);
    } else if (s > heap[0].score) {
      heap[0] = { docId: docIds[i], score: s };
      // k is small (<= 8); a resort is cheaper than maintaining a real heap.
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

/** Maps cosine similarity in [-1, 1] to [0, 1] for the u16 wire encoding. */
export function toWireScore(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine + 1) / 2));
}

export function fromWireScore(wire: number): number {
  return wire * 2 - 1;
}
