/**
 * Lexical scoring, blended with the vector score at rank time.
 *
 * Semantic search alone reliably misses exact tokens that matter in this corpus
 * — drug names, dosages, "38.5C". BM25 catches those; the embedding catches
 * paraphrase. The union is noticeably better than either on first-aid queries.
 */

const K1 = 1.5;
const B = 0.75;
const STOP = new Set(
  'a an and are as at be by for from has have how i if in is it its of on or that the this to was what when where which who why with you your'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class BM25Index {
  private df = new Map<string, number>();
  private docs: { docId: number; tf: Map<string, number>; len: number }[] = [];
  private avgLen = 0;

  constructor(docs: { docId: number; text: string }[]) {
    let total = 0;
    for (const d of docs) {
      const tokens = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ docId: d.docId, tf, len: tokens.length });
      total += tokens.length;
    }
    this.avgLen = docs.length ? total / docs.length : 0;
  }

  /** Raw BM25 scores keyed by docId. Only documents with a match appear. */
  score(query: string): Map<number, number> {
    const terms = tokenize(query);
    const N = this.docs.length;
    const out = new Map<number, number>();
    if (!N || !terms.length) return out;

    for (const doc of this.docs) {
      let s = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const n = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / this.avgLen)));
      }
      if (s > 0) out.set(doc.docId, s);
    }
    return out;
  }

  /** Scales scores into [0, 1] so they can be blended with cosine similarity. */
  static normalize(scores: Map<number, number>): Map<number, number> {
    let max = 0;
    for (const v of scores.values()) if (v > max) max = v;
    if (max === 0) return scores;
    const out = new Map<number, number>();
    for (const [k, v] of scores) out.set(k, v / max);
    return out;
  }
}
