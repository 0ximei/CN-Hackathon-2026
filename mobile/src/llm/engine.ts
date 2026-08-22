import * as FileSystem from 'expo-file-system/legacy';

import { SYSTEM_PROMPT, buildUserPrompt, extractiveAnswer, selectPassages } from '@core/llm/prompt';
import type { MeshHit } from '../mesh/MeshNode';
import { fitPassages, type ContextBudget } from './context';
import { DEFAULT_MODEL, type ModelSpec } from './models';

export type LlmPhase =
    | 'unavailable'
    | 'idle'
    | 'downloading'
    | 'loading'
    | 'ready'
    | 'generating'
    | 'error';

export interface LlmStatus {
    phase: LlmPhase;
    progress: number;
    detail: string;
    /** File name of the model in use or on disk, for the UI to name it. */
    model?: string;
}

export interface Answer {
    text: string;
    passages: { hit: MeshHit; text: string }[];
    mode: 'generated' | 'extractive';
}

/** Where models live. One directory, so "what do I have" is one listing. */
const MODEL_DIR = `${FileSystem.documentDirectory ?? ''}models/`;

/** See `context.ts` for why the prompt is cut down before it reaches the model. */
const CONTEXT_TOKENS = 4096;
const BUDGET: ContextBudget = {
    contextTokens: CONTEXT_TOKENS,
    reservedForAnswer: 320,
    overheadChars: SYSTEM_PROMPT.length + 256,
};

/**
 * Low, not zero.
 *
 * The job is to restate retrieved first-aid instructions accurately, not to
 * write. Sampling temperature is the dial that trades faithfulness for variety
 * and there is no variety worth having here — but a touch above zero avoids the
 * degenerate repetition loops greedy decoding falls into on small models.
 */
const TEMPERATURE = 0.2;
const MAX_TOKENS = 300;

type LlamaModule = typeof import('llama.rn');
type LlamaContext = Awaited<ReturnType<LlamaModule['initLlama']>>;

/**
 * On-device answer generation, over passages the mesh returned.
 *
 * Two things make this different from wiring up a chat API. The first is that
 * the model is never the source: it is handed numbered passages and told to
 * restate them with citations, because a 0.5B model asked a first-aid question
 * from its own weights will produce fluent, confident, wrong dosages. The
 * second is that it is optional at every level — no model present, a model that
 * will not load, a generation that fails or returns nothing usable — and every
 * one of those paths falls through to the extractive answer rather than to an
 * error. A user asking how to treat a burn gets sentences from the corpus.
 */
export class LlmEngine {
    status: LlmStatus = { phase: 'idle', progress: 0, detail: '' };
    onStatus?: (s: LlmStatus) => void;

    private ctx: LlamaContext | null = null;
    private llama: LlamaModule | null = null;
    private busy = false;
    private download: FileSystem.DownloadResumable | null = null;

    get ready(): boolean {
        return this.ctx !== null;
    }

    private set(patch: Partial<LlmStatus>) {
        this.status = { ...this.status, ...patch };
        this.onStatus?.(this.status);
    }

    /**
     * The native binding, or null on a binary built before it was added.
     *
     * Required lazily and never at module scope, the same way `expo-crypto` is
     * in `identity/keys.ts`: a missing native module has to degrade to
     * extractive mode, not take the app down on startup.
     */
    private module(): LlamaModule | null {
        if (this.llama) return this.llama;
        try {
            this.llama = require('llama.rn') as LlamaModule;
            return this.llama;
        } catch {
            return null;
        }
    }

    /* ------------------------------- models ------------------------------ */

    /** GGUF files already on this device, newest first. */
    async installed(): Promise<{ name: string; uri: string; bytes: number }[]> {
        try {
            const dir = await FileSystem.getInfoAsync(MODEL_DIR);
            if (!dir.exists) return [];
            const names = await FileSystem.readDirectoryAsync(MODEL_DIR);
            const out = [];
            for (const name of names) {
                if (!name.endsWith('.gguf')) continue;
                const info = await FileSystem.getInfoAsync(`${MODEL_DIR}${name}`);
                if (info.exists && !info.isDirectory) {
                    out.push({ name, uri: info.uri, bytes: info.size ?? 0 });
                }
            }
            return out;
        } catch {
            return [];
        }
    }

    /**
     * Bring up whatever model is already on disk.
     *
     * Never downloads. Spending someone's mobile data because they opened a
     * screen is not a decision this function gets to make — `fetch` is, and it
     * is reached from a button that quotes the size first.
     */
    async load(): Promise<void> {
        if (this.ctx) return;
        if (!this.module()) {
            this.set({
                phase: 'unavailable',
                progress: 0,
                detail: 'this build has no on-device model support — extractive answers',
            });
            return;
        }
        const [first] = await this.installed();
        if (!first) {
            this.set({
                phase: 'idle',
                progress: 0,
                detail: 'no model on this device yet',
                model: undefined,
            });
            return;
        }
        await this.open(first.uri, first.name);
    }

    /** Downloads `spec`, then loads it. Resumable, and reports real progress. */
    async fetch(spec: ModelSpec = DEFAULT_MODEL): Promise<void> {
        if (!this.module()) {
            this.set({ phase: 'unavailable', progress: 0, detail: 'this build has no on-device model support' });
            return;
        }
        const name = `${spec.id}.gguf`;
        const target = `${MODEL_DIR}${name}`;
        try {
            await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
            const existing = await FileSystem.getInfoAsync(target);
            if (existing.exists && existing.size === spec.bytes) {
                await this.open(target, name);
                return;
            }
            // A partial file from an interrupted attempt is worse than none: it
            // loads as a corrupt model rather than failing honestly.
            if (existing.exists) await FileSystem.deleteAsync(target, { idempotent: true });

            this.set({ phase: 'downloading', progress: 0, detail: `fetching ${spec.name}`, model: name });
            this.download = FileSystem.createDownloadResumable(spec.url, target, {}, (p) => {
                const total = p.totalBytesExpectedToWrite || spec.bytes;
                this.set({
                    phase: 'downloading',
                    progress: total > 0 ? p.totalBytesWritten / total : 0,
                    detail: `fetching ${spec.name}`,
                });
            });
            const result = await this.download.downloadAsync();
            this.download = null;
            if (!result) {
                this.set({ phase: 'idle', progress: 0, detail: 'download cancelled' });
                return;
            }
            await this.open(result.uri, name);
        } catch (e) {
            this.download = null;
            await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
            this.set({ phase: 'error', progress: 0, detail: `download failed: ${message(e)}` });
        }
    }

    cancelFetch(): void {
        void this.download?.pauseAsync().catch(() => undefined);
        this.download = null;
        this.set({ phase: 'idle', progress: 0, detail: 'download cancelled' });
    }

    /**
     * Adopts a GGUF the user picked from device storage.
     *
     * The path that needs no network at all: a model can arrive over USB, from
     * an SD card, or from another phone's file manager. It is copied rather
     * than opened in place because a content:// URI from the picker is a
     * short-lived grant, not a file this app can reopen next launch.
     */
    async importFile(uri: string, filename: string): Promise<void> {
        if (!this.module()) {
            this.set({ phase: 'unavailable', progress: 0, detail: 'this build has no on-device model support' });
            return;
        }
        const name = filename.endsWith('.gguf') ? filename : `${filename}.gguf`;
        const target = `${MODEL_DIR}${name}`;
        try {
            this.set({ phase: 'loading', progress: 0, detail: `copying ${name}`, model: name });
            await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
            await FileSystem.deleteAsync(target, { idempotent: true });
            await FileSystem.copyAsync({ from: uri, to: target });
            await this.open(target, name);
        } catch (e) {
            this.set({ phase: 'error', progress: 0, detail: `could not import: ${message(e)}` });
        }
    }

    private async open(uri: string, name: string): Promise<void> {
        const llama = this.module();
        if (!llama) return;
        await this.unload();
        this.set({ phase: 'loading', progress: 0, detail: `loading ${name}`, model: name });
        try {
            this.ctx = await llama.initLlama(
                {
                    model: uri.replace('file://', ''),
                    n_ctx: CONTEXT_TOKENS,
                    // CPU only. Android GPU backends vary by vendor and fail in
                    // ways that look like bad answers rather than errors, which
                    // is the worst trade available on this corpus.
                    n_gpu_layers: 0,
                    n_threads: 4,
                    use_mlock: false,
                },
                (progress) => this.set({ phase: 'loading', progress: progress / 100, detail: `loading ${name}` }),
            );
            this.set({ phase: 'ready', progress: 1, detail: `${name} ready`, model: name });
        } catch (e) {
            this.ctx = null;
            this.set({ phase: 'error', progress: 0, detail: `could not load ${name}: ${message(e)}` });
        }
    }

    /** Frees the model's memory. Answers fall back to extractive immediately. */
    async unload(): Promise<void> {
        const ctx = this.ctx;
        this.ctx = null;
        if (!ctx) return;
        try {
            await ctx.release();
        } catch {
            /* releasing a context that already died is not worth reporting */
        }
        this.set({ phase: 'idle', progress: 0, detail: 'model unloaded' });
    }

    /** Removes a model file from the device. */
    async remove(name: string): Promise<void> {
        if (this.status.model === name) await this.unload();
        await FileSystem.deleteAsync(`${MODEL_DIR}${name}`, { idempotent: true }).catch(() => undefined);
        this.set({ phase: 'idle', progress: 0, detail: `${name} deleted`, model: undefined });
    }

    /* ------------------------------ answering ---------------------------- */

    async answer(
        question: string,
        hits: MeshHit[],
        resolveText: (hit: MeshHit) => Promise<string>,
        onToken?: (partial: string) => void,
    ): Promise<Answer> {
        const selected = selectPassages(hits);
        const resolved = await Promise.all(
            selected.map(async (hit) => ({ hit, text: await resolveText(hit) })),
        );
        const passages = fitPassages(resolved, BUDGET);

        if (!passages.length) {
            return {
                text: 'Not in the mesh — no node holds an answer to that.',
                passages: [],
                mode: 'extractive',
            };
        }

        const fallback = this.extractive(question, passages);
        if (!this.ctx || this.busy) {
            onToken?.(fallback.text);
            return fallback;
        }

        this.busy = true;
        try {
            this.set({ phase: 'generating', progress: 0, detail: 'generating' });
            let streamed = '';
            const result = await this.ctx.completion(
                {
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: buildUserPrompt({ question, passages }) },
                    ],
                    n_predict: MAX_TOKENS,
                    temperature: TEMPERATURE,
                    // Small models loop. A modest repeat penalty is the cheapest
                    // guard, and it cannot change which passage is cited.
                    penalty_repeat: 1.1,
                    stop: ['<|im_end|>', '<|eot_id|>', '</s>', '\nQuestion:'],
                },
                (data) => {
                    streamed += data.token;
                    onToken?.(streamed);
                },
            );

            const text = (result.text ?? streamed).trim();
            this.set({ phase: 'ready', progress: 1, detail: this.status.model ?? 'ready' });

            // A model that returned nothing, or a bare refusal shorter than a
            // sentence, has not answered — the corpus sentences are better than
            // an empty bubble, and the caller is told which one it got.
            if (text.length < 20) {
                onToken?.(fallback.text);
                return fallback;
            }
            return { text, passages, mode: 'generated' };
        } catch (e) {
            this.set({ phase: 'error', progress: 0, detail: `generation failed: ${message(e)}` });
            onToken?.(fallback.text);
            return fallback;
        } finally {
            this.busy = false;
        }
    }

    /** Stops a generation in flight, leaving the model loaded. */
    async stop(): Promise<void> {
        try {
            await this.ctx?.stopCompletion();
        } catch {
            /* nothing in flight */
        }
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
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export const llm = new LlmEngine();
