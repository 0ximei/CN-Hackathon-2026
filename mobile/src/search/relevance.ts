import { tokenize } from '@core/search/bm25';

/**
 * How relevant a passage is to a query, and whether it is relevant at all.
 *
 * These are two questions and the browser build only has to answer one of them
 * well. There, cosine similarity from MiniLM is meaningful on its own: 0.42 is
 * a real threshold, and BM25 is a rescue for exact clinical terms blended in at
 * rank time. Here the embedder is a hashing embedder that has never read a
 * sentence, and its cosine is a poor discriminator — unrelated passages reach
 * 0.24 without help — so the lexical half has to carry the decision.
 *
 * The obvious way to do that is what the web build does: blend in BM25.
 * It does not work as a *gate*, for two reasons, and both are worth stating
 * because both are easy to walk into:
 *
 *   1. `BM25Index.normalize` scales the best match to 1.0 whatever it is. The
 *      top result for a question about sourdough normalises to 1.0 exactly like
 *      the top result for a question about burns.
 *
 *   2. Raw BM25 is not comparable either, because its IDF term collapses on a
 *      small index. A node holding four passages scores every term at
 *      log(1 + 0.5/1.5) ≈ 0.29 no matter how rare the word is, so a threshold
 *      tuned on a full corpus silences a node that has just been handed its
 *      first document.
 *
 * So the gate uses *query-term coverage*: the fraction of the question's
 * content words that appear in the passage at all. It is absolute, it is
 * independent of how much the node happens to know, and it is comparable
 * between two nodes with completely different catalogs — which matters,
 * because these scores travel inside RESULT packets and are merged at the
 * asking node.
 *
 * BM25 keeps its job. It just does it below the gate, as a local tie-break
 * among passages that already cleared it.
 */

/** Weight on the lexical half of the score. */
export const LEXICAL_WEIGHT = 0.6;

/**
 * Minimum relevance for a passage to be worth returning.
 *
 * The browser build's reasoning carries over exactly: without a floor, a node
 * that knows nothing relevant still returns its four least-irrelevant passages,
 * and the answer layer cites them as though they were answers. On a first-aid
 * corpus that is the worst failure available — confident frostbite advice for a
 * burn question.
 *
 * Measured over the sample corpus: genuine top hits score 0.45 to 0.92, and the
 * best an out-of-corpus question manages is 0.36. A node holding a single
 * passage scores 0.63 for a question about it and 0.05 for one about sourdough,
 * so the same number works at both ends of the catalog-size range.
 */
export const MIN_RELEVANCE = 0.4;

/**
 * How much a local BM25 score may reorder passages that cleared the gate.
 *
 * Small on purpose. It must not be able to lift anything over the floor, and it
 * must not distort a score that is about to be sent to another node — the
 * ordering it buys is only meaningful against this node's own index.
 */
export const BM25_TIEBREAK = 0.1;

/**
 * Fraction of the query's content words that appear in the text.
 *
 * `tokenize` is the shared one, so stop words and the token shape match what
 * BM25 indexes — a coverage measure that counted "the" would be measuring
 * English, not relevance.
 */
export function termCoverage(query: string, text: string): number {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return 0;
    const present = new Set(tokenize(text));
    let matched = 0;
    for (const term of terms) if (present.has(term)) matched++;
    return matched / terms.length;
}

/**
 * The score a hit carries, on screen and on the wire.
 *
 * Clamped into [0, 1] because `toWireScore` encodes a similarity, and the blend
 * can in principle exceed 1 (nothing on this corpus comes close).
 */
export function relevanceOf(cosine: number, coverage: number): number {
    return Math.min(1, cosine + LEXICAL_WEIGHT * coverage);
}
