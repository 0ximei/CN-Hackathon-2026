/**
 * On-device generation via WebLLM.
 *
 * Qwen2.5-0.5B-Instruct at q4f16_1 is ~945MB of VRAM and 4096 tokens of
 * context. It is chosen for load time and tokens/sec rather than quality: with
 * six retrieved passages in front of it, the model's job is summarisation and
 * citation, not recall.
 *
 * The model is downloaded once and cached, so subsequent launches are offline.
 */

import type { MLCEngine } from '@mlc-ai/web-llm';
import type { MeshHit } from '../protocol/MeshNode';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  extractiveAnswer,
  selectPassages,
} from './prompt';

export const MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

export type LlmPhase = 'unavailable' | 'idle' | 'loading' | 'ready' | 'generating' | 'error';

export interface LlmStatus {
  phase: LlmPhase;
  progress: number;
  detail: string;
}

export interface Answer {
  text: string;
  /** Passages the answer was grounded in, in citation order. */
  passages: { hit: MeshHit; text: string }[];
  mode: 'generated' | 'extractive';
}

export async function webGpuAvailable(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

export class LlmEngine {
  status: LlmStatus = { phase: 'idle', progress: 0, detail: '' };
  onStatus?: (s: LlmStatus) => void;

  private engine: MLCEngine | null = null;
  private loading: Promise<void> | null = null;

  private set(patch: Partial<LlmStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  get ready() {
    return this.engine !== null;
  }

  /** Downloads and initialises the model. Call only on explicit user action. */
  async load(): Promise<void> {
    if (this.engine) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      if (!(await webGpuAvailable())) {
        this.set({
          phase: 'unavailable',
          detail: 'WebGPU not available — using extractive answers',
        });
        throw new Error('WebGPU unavailable');
      }

      this.set({ phase: 'loading', progress: 0, detail: 'downloading model' });
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');

      this.engine = await CreateMLCEngine(MODEL_ID, {
        initProgressCallback: (p) => {
          this.set({ progress: p.progress, detail: p.text });
        },
      });
      this.set({ phase: 'ready', progress: 1, detail: 'model ready' });
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Produces a grounded answer, streaming tokens through `onToken`.
   * Falls back to extraction whenever the model is not usable.
   */
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

    if (!this.engine) return this.extractive(question, passages);

    try {
      this.set({ phase: 'generating', detail: 'generating answer' });
      const stream = await this.engine.chat.completions.create({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ question, passages }) },
        ],
        temperature: 0.2,
        max_tokens: 220,
        stream: true,
      });

      let text = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          text += delta;
          onToken?.(text);
        }
      }
      this.set({ phase: 'ready', detail: 'model ready' });
      return { text: text.trim(), passages, mode: 'generated' };
    } catch (err) {
      this.set({
        phase: 'error',
        detail: err instanceof Error ? err.message : 'generation failed',
      });
      return this.extractive(question, passages);
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

  async unload() {
    await this.engine?.unload();
    this.engine = null;
    this.set({ phase: 'idle', progress: 0, detail: '' });
  }
}

export const llm = new LlmEngine();
