import { describe, expect, it } from 'vitest';

import { SYSTEM_PROMPT, buildUserPrompt } from '@core/llm/prompt';
import { budgetChars, fitPassages, CHARS_PER_TOKEN, type ContextBudget } from './context';

const BUDGET: ContextBudget = {
    contextTokens: 4096,
    reservedForAnswer: 320,
    overheadChars: SYSTEM_PROMPT.length + 256,
};

function passage(section: string, chars: number) {
    return { hit: { title: 'Severe Bleeding', section }, text: 'x'.repeat(chars) };
}

describe('fitting passages into the context window', () => {
    it('keeps every passage when they fit', () => {
        const all = [passage('a', 400), passage('b', 400), passage('c', 400)];
        expect(fitPassages(all, BUDGET)).toHaveLength(3);
    });

    it('drops from the back, where the weakest hit is', () => {
        // Ranked order in, so anything dropped must come off the end.
        const all = [passage('best', 6000), passage('middle', 6000), passage('worst', 6000)];
        const kept = fitPassages(all, BUDGET);
        expect(kept.length).toBeLessThan(3);
        expect(kept.map((p) => p.hit.section)).toEqual(
            ['best', 'middle', 'worst'].slice(0, kept.length),
        );
    });

    it('never cuts a passage in half', () => {
        const all = [passage('a', 500), passage('b', 99_000)];
        for (const p of fitPassages(all, BUDGET)) {
            expect(p.text).toBe(all.find((a) => a.hit.section === p.hit.section)!.text);
        }
    });

    it('keeps one over-long passage rather than sending none', () => {
        // A grounded prompt that is too long degrades. An empty one asks a
        // 0.5B model to answer a medical question from its weights.
        const kept = fitPassages([passage('only', 500_000)], BUDGET);
        expect(kept).toHaveLength(1);
    });

    it('skips passages whose body never arrived', () => {
        const kept = fitPassages([passage('a', 0), passage('b', 200)], BUDGET);
        expect(kept.map((p) => p.hit.section)).toEqual(['b']);
    });

    it('leaves the real prompt inside the window it claims to respect', () => {
        const many = Array.from({ length: 40 }, (_, i) => passage(`s${i}`, 2_000));
        const kept = fitPassages(many, BUDGET);
        const prompt = buildUserPrompt({ question: 'how do I stop severe bleeding?', passages: kept as never });
        const tokens = (SYSTEM_PROMPT.length + prompt.length) / CHARS_PER_TOKEN;
        expect(tokens + BUDGET.reservedForAnswer).toBeLessThanOrEqual(BUDGET.contextTokens);
    });
});
