import { describe, expect, it } from 'vitest';

import { dequantize, quantize } from '@core/search/vector';

import { embedder } from './embedder';

function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

describe('hashing embedder', () => {
  it('produces unit vectors, which everything downstream assumes', () => {
    for (const text of ['severe arterial bleeding', 'burn', 'how do I treat a burn']) {
      const vec = embedder.embed(text);
      expect(cosine(vec, vec)).toBeCloseTo(1, 5);
    }
  });

  /**
   * A query of nothing but stopwords or single characters has no features, and
   * the honest answer is the zero vector rather than an arbitrary direction
   * that would match something. `quantize` and `dequantize` both special-case a
   * zero-length vector, so this travels the wire and scores nothing — which is
   * the correct outcome for "what is it".
   */
  it('yields a zero vector when a query has no usable tokens', () => {
    for (const text of ['x', 'the a of', '', '!!!']) {
      const vec = embedder.embed(text);
      expect(cosine(vec, vec), `"${text}"`).toBe(0);
    }
  });

  /**
   * Determinism is not a nicety here. Chunk ids are content-addressed and
   * vectors are recomputed at every launch instead of being stored, so an
   * embedder that drifted would silently stop matching its own corpus.
   */
  it('is deterministic across calls', () => {
    const a = embedder.embed('apply firm direct pressure to the wound');
    const b = embedder.embed('apply firm direct pressure to the wound');
    expect([...a]).toEqual([...b]);
  });

  it('ignores word order only as far as the bigrams allow', () => {
    const forward = embedder.embed('arterial bleeding');
    const reversed = embedder.embed('bleeding arterial');
    // Same unigrams, different bigram: similar but not identical.
    expect(cosine(forward, reversed)).toBeGreaterThan(0.7);
    expect(cosine(forward, reversed)).toBeLessThan(0.999);
  });

  it('scores a related passage above an unrelated one', () => {
    const query = embedder.embed('how do I stop heavy bleeding');
    const related = embedder.embed(
      'To stop heavy bleeding, apply firm pressure directly over the wound with a clean cloth.',
    );
    const unrelated = embedder.embed(
      'Purify water by bringing it to a rolling boil for at least one minute.',
    );
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  /**
   * Character n-grams are the only thing giving this any tolerance for
   * inflection — without them "burned" and "burn" share no feature at all.
   */
  it('relates inflected forms of the same word', () => {
    const burn = embedder.embed('burn');
    const burned = embedder.embed('burned');
    const unrelated = embedder.embed('splint');
    expect(cosine(burn, burned)).toBeGreaterThan(cosine(burn, unrelated));
  });

  it('survives the int8 quantisation it is sent over the wire in', () => {
    const original = embedder.embed('treating a second degree burn');
    const { q, scale } = quantize(original);
    const restored = dequantize(q, scale);
    // The wire format is lossy by design; it must not be lossy enough to
    // change which passage wins.
    expect(cosine(original, restored)).toBeGreaterThan(0.99);
  });
});
