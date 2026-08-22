import type { MeshHit } from '../mesh/MeshNode';
import { extractiveAnswer, selectPassages } from '@core/llm/prompt';

export const MODEL_ID = 'mobile-extractive';

export type LlmPhase = 'unavailable' | 'idle' | 'loading' | 'ready' | 'generating' | 'error';

export interface LlmStatus {
    phase: LlmPhase;
    progress: number;
    detail: string;
}

export interface Answer {
    text: string;
    passages: { hit: MeshHit; text: string }[];
    mode: 'generated' | 'extractive';
}

export class LlmEngine {
    status: LlmStatus = { phase: 'idle', progress: 0, detail: '' };
    onStatus?: (s: LlmStatus) => void;

    private set(patch: Partial<LlmStatus>) {
        this.status = { ...this.status, ...patch };
        this.onStatus?.(this.status);
    }

    get ready() {
        return false;
    }

    async load(): Promise<void> {
        this.set({ phase: 'unavailable', progress: 0, detail: 'mobile LLM unavailable — using extractive answers' });
    }

    async answer(
        question: string,
        hits: MeshHit[],
        resolveText: (hit: MeshHit) => Promise<string>,
        onToken?: (partial: string) => void,
    ): Promise<Answer> {
        const selected = selectPassages(hits);
        const passages = await Promise.all(
            selected.map(async (hit) => ({ hit, text: await resolveText(hit) })),
        );

        if (!passages.length) {
            return {
                text: 'Not in the mesh — no node holds an answer to that.',
                passages: [],
                mode: 'extractive',
            };
        }

        this.set({ phase: 'generating', progress: 0.5, detail: 'preparing extractive answer' });
        const fallback = this.extractive(question, passages);
        onToken?.(fallback.text);
        this.set({ phase: 'unavailable', progress: 1, detail: 'mobile LLM unavailable — using extractive mode' });
        return fallback;
    }

    private extractive(question: string, passages: { hit: MeshHit; text: string }[]): Answer {
        const { sentences } = extractiveAnswer(question, passages);
        if (!sentences.length) {
            return {
                text: 'Not in the mesh — no node holds an answer to that.',
                passages,
                mode: 'extractive',
            };
        }
        return {
            text: sentences.map((s) => `${s.text} [${s.citation}]`).join(' '),
            passages,
            mode: 'extractive',
        };
    }

    async unload(): Promise<void> {
        this.set({ phase: 'idle', progress: 0, detail: '' });
    }
}

export const llm = new LlmEngine();
