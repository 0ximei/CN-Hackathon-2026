import type { MeshHit } from '@core/llm/prompt';

/**
 * Fitting retrieved passages into a small model's context window.
 *
 * Its own module, free of `llama.rn` and `expo-file-system`, so the property it
 * exists to guarantee can be tested from Node — importing the engine pulls in
 * two native modules and neither exists outside the app.
 *
 * The property is a safety one rather than a performance one. llama.cpp does
 * not politely shorten an over-long prompt: depending on the build it errors,
 * or drops tokens from the front. The front is where the system prompt lives,
 * and the system prompt is the only thing standing between a 0.5B model and
 * confidently invented first-aid advice. So the passages are cut to fit before
 * they ever reach it, and they are cut from the back, where the least relevant
 * hit is.
 */
export interface Passage {
    hit: Pick<MeshHit, 'title' | 'section'>;
    text: string;
}

/** Four characters per token, which is the usual English rule and pessimistic. */
export const CHARS_PER_TOKEN = 4;

export interface ContextBudget {
    /** The model's full context window, in tokens. */
    contextTokens: number;
    /** Held back for the answer, which shares the same window. */
    reservedForAnswer: number;
    /** Everything that is not a passage: system prompt, question, scaffolding. */
    overheadChars: number;
}

export function budgetChars({ contextTokens, reservedForAnswer, overheadChars }: ContextBudget): number {
    return Math.max(0, (contextTokens - reservedForAnswer) * CHARS_PER_TOKEN - overheadChars);
}

/**
 * Drops passages from the back until the rest fit.
 *
 * A passage is never cut in half. Half a first-aid instruction is worse than
 * none — "apply a tourniquet above the wound and" is an invitation to guess the
 * rest — and the citation numbers have to keep pointing at whole passages for
 * the answer to be checkable against them.
 *
 * The first passage is kept whatever it costs. A prompt with one over-long
 * passage is still a grounded prompt; a prompt with none is the model answering
 * a medical question from its weights, which is the failure this whole file is
 * arranged to prevent.
 */
export function fitPassages<T extends Passage>(passages: T[], budget: ContextBudget): T[] {
    const limit = budgetChars(budget);
    const out: T[] = [];
    let used = 0;
    for (const p of passages) {
        if (!p.text) continue;
        const cost = costOf(p);
        if (out.length && used + cost > limit) break;
        out.push(p);
        used += cost;
    }
    return out;
}

/** Text plus the heading scaffolding `buildUserPrompt` wraps around it. */
function costOf(p: Passage): number {
    return p.text.length + p.hit.title.length + p.hit.section.length + 16;
}
