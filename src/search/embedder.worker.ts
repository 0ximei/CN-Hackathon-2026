/// <reference lib="webworker" />
/**
 * Embedding worker. Kept off the main thread because indexing a shard runs a
 * few dozen forward passes back to back and would otherwise freeze the UI.
 *
 * all-MiniLM-L6-v2: 384 dimensions, ~23MB quantized. After the first load the
 * weights live in the browser's Cache Storage, so every later start is offline.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.allowRemoteModels = true;

const MODEL = 'Xenova/all-MiniLM-L6-v2';

type In =
  | { type: 'init' }
  | { type: 'embed'; id: number; texts: string[] };

type Out =
  | { type: 'ready'; backend: string }
  | { type: 'error'; id?: number; message: string }
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'embedded'; id: number; vectors: Float32Array[] };

let extractor: FeatureExtractionPipeline | null = null;
let backend = 'wasm';

function post(msg: Out, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

async function init() {
  if (extractor) return extractor;

  const progress_callback = (p: {
    status?: string;
    loaded?: number;
    total?: number;
    file?: string;
  }) => {
    if (p.status === 'progress' && p.total) {
      post({ type: 'progress', loaded: p.loaded ?? 0, total: p.total, file: p.file ?? '' });
    }
  };

  // pipeline()'s overload set resolves to a union across every task type,
  // which TypeScript cannot represent. Narrowing it to the one task we use
  // keeps the call site typed without disabling checking elsewhere.
  const load = pipeline as unknown as (
    task: 'feature-extraction',
    model: string,
    opts: Record<string, unknown>,
  ) => Promise<FeatureExtractionPipeline>;

  // WASM + q8, deliberately, and NOT WebGPU.
  //
  // q8 weights are silently wrong on the WebGPU execution provider: measured
  // on this corpus, "how long do I cool a burn" scored 0.39 against the
  // passage that answers it and 0.49 against an unrelated rescue-signalling
  // passage — i.e. worse than random ranking, with no error raised anywhere.
  // The same weights on WASM score 0.70 / 0.11. WebGPU is only correct here
  // with fp32, which is a ~90MB download instead of ~23MB.
  //
  // For shard-sized corpora (tens to low thousands of passages) WASM q8
  // indexes in well under a second, so the WebGPU speedup buys nothing that
  // matters while costing 4x the download and a correctness cliff. One code
  // path on every device is also one less thing to debug at a venue.
  extractor = await load('feature-extraction', MODEL, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback,
  });
  backend = 'wasm-q8';
  return extractor;
}

self.onmessage = async (ev: MessageEvent<In>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      await init();
      post({ type: 'ready', backend });
      return;
    }

    if (msg.type === 'embed') {
      const model = await init();
      // Mean pooling + L2 normalization, so cosine similarity is a plain dot.
      const output = await model(msg.texts, { pooling: 'mean', normalize: true });
      const data = output.data as Float32Array;
      const dim = data.length / msg.texts.length;

      const vectors: Float32Array[] = [];
      for (let i = 0; i < msg.texts.length; i++) {
        vectors.push(new Float32Array(data.subarray(i * dim, (i + 1) * dim)));
      }
      post(
        { type: 'embedded', id: msg.id, vectors },
        vectors.map((v) => v.buffer),
      );
    }
  } catch (err) {
    post({
      type: 'error',
      id: 'id' in msg ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
