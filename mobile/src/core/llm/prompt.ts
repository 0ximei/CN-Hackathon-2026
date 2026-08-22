/**
 * Grounded prompt construction and the extractive fallback.
 *
 * A 0.5B model will happily invent plausible medical advice, which in this
 * corpus is the worst possible failure. The prompt is therefore narrow and
 * repetitive about its one rule, passages are numbered so citations are cheap
 * to produce, and the context is capped — a small model's instruction-following
 * degrades sharply as the context fills.
 */

/**
 * What a passage-selecting prompt needs to know about a hit.
 *
 * Declared structurally rather than imported from either build's `MeshNode`.
 * Both define a `MeshHit` with these fields among others, and this module only
 * reads these — so stating the requirement here is what keeps a prompt helper
 * from dragging in a whole node implementation, and its storage layer with it.
 */
export interface MeshHit {
    docId: number;
    score: number;
    title: string;
    section: string;
    snippet: string;
    text?: string;
    fromNodeId: number;
    fromNodeName: string;
    hops: number;
    local: boolean;
}

export const MAX_PASSAGES = 6;

export const SYSTEM_PROMPT = `You are MeshNet, an offline first-aid assistant running on a phone with no internet connection.

Rules:
- Answer ONLY using the numbered passages provided. Never add outside knowledge.
- Cite the passage number in square brackets after each claim, like [2].
- If the passages do not answer the question, reply exactly: "Not in the mesh — no node holds an answer to that."
- Be direct and practical. Lead with the action to take.
- Keep the answer under 120 words.`;

export interface PromptContext {
  question: string;
  passages: { hit: MeshHit; text: string }[];
}

export function buildUserPrompt({ question, passages }: PromptContext): string {
  const numbered = passages
    .map((p, i) => `[${i + 1}] (${p.hit.title} — ${p.hit.section}) ${p.text}`)
    .join('\n\n');

  return `Passages retrieved from the mesh:\n\n${numbered}\n\nQuestion: ${question}\n\nAnswer using only the passages above, citing them by number:`;
}

/**
 * Relative cut-off below the best hit.
 *
 * The per-node floor in `shard.ts` is absolute and has to be conservative,
 * because a node judging in isolation cannot know whether a better answer
 * exists elsewhere in the mesh. The origin node *can* — it has seen every
 * shard's best offer — so it applies a second, relative filter here: once a
 * strong match exists, mediocre ones stop being worth citing.
 */
const RELATIVE_CUTOFF = 0.14;

/** Trims passages to the strongest few and drops near-duplicates. */
export function selectPassages<T extends MeshHit>(hits: T[], limit = MAX_PASSAGES): T[] {
  if (!hits.length) return [];
  const best = Math.max(...hits.map((h) => h.score));
  const chosen: T[] = [];
  for (const hit of hits) {
    if (hit.score < best - RELATIVE_CUTOFF) break;
    if (chosen.length >= limit) break;
    // Two nodes can hold different chunks of the same section; keep at most two
    // so one verbose section cannot crowd out the rest of the mesh's answer.
    const sameSection = chosen.filter((c) => c.section === hit.section).length;
    if (sameSection >= 2) continue;
    chosen.push(hit);
  }
  return chosen;
}

/* ------------------------------------------------------------------ *
 * Extractive fallback — used when WebGPU or the model is unavailable.
 * ------------------------------------------------------------------ */

const STOP = new Set('a an and are as at be by for from how in is it of on or the to was what when where which who why with'.split(' '));

function keywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export interface ExtractiveAnswer {
  sentences: { text: string; citation: number }[];
}

/**
 * Picks the sentences that most directly address the question.
 *
 * This is not a downgrade the user should be apologised to for: for procedural
 * first-aid content the source sentences are often better than a paraphrase,
 * and they cannot hallucinate a dosage.
 */
export function extractiveAnswer(
  question: string,
  passages: { hit: MeshHit; text: string }[],
  maxSentences = 4,
): ExtractiveAnswer {
  const terms = keywords(question);
  const scored: { text: string; citation: number; score: number }[] = [];

  passages.forEach((p, idx) => {
    const sentences = p.text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 25);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      let score = 0;
      for (const term of terms) if (lower.includes(term)) score += 1;
      // Imperative sentences are the actionable ones in this corpus.
      if (/^(do not|never|apply|keep|give|move|cool|call|check|stop|place|remove)/i.test(sentence.trim())) {
        score += 0.75;
      }
      if (score > 0) scored.push({ text: sentence.trim(), citation: idx + 1, score });
    }
  });

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const sentences: ExtractiveAnswer['sentences'] = [];
  for (const s of scored) {
    if (sentences.length >= maxSentences) break;
    const key = s.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    sentences.push({ text: s.text, citation: s.citation });
  }
  return { sentences };
}
