/**
 * Models this build knows how to fetch.
 *
 * Deliberately a short list of small ones. The constraint is not disk but RAM
 * and patience: the whole file is resident while it runs, and generation is on
 * the CPU because a phone's GPU backend is not dependable across vendors. A
 * 0.5B model at Q4 answers a grounded first-aid question in a few seconds on a
 * mid-range phone; a 7B model does not run at all.
 *
 * Sizes are the real `content-length` of each file, not estimates, because the
 * download UI quotes them to someone deciding whether to spend the bandwidth.
 *
 * Nothing here is required. The engine loads any GGUF the user points it at,
 * which is the path that actually works in the field: a phone with no
 * connectivity can still be handed a model file over USB or from another
 * device's storage.
 */
export interface ModelSpec {
    id: string;
    name: string;
    /** Parameter count, as advertised — the number that predicts answer quality. */
    params: string;
    url: string;
    bytes: number;
    license: string;
    note: string;
}

export const MODELS: ModelSpec[] = [
    {
        id: 'qwen2.5-0.5b-instruct-q4',
        name: 'Qwen2.5 0.5B Instruct',
        params: '0.5B',
        url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
        bytes: 491_400_032,
        license: 'Apache-2.0',
        note: 'The default. Follows the "cite the passage" instruction reliably at this size.',
    },
    {
        id: 'smollm2-360m-instruct-q4',
        name: 'SmolLM2 360M Instruct',
        params: '360M',
        url: 'https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf',
        bytes: 270_590_880,
        license: 'Apache-2.0',
        note: 'Smallest and quickest. Drifts off the passages more often.',
    },
    {
        id: 'llama-3.2-1b-instruct-q4',
        name: 'Llama 3.2 1B Instruct',
        params: '1B',
        url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        bytes: 807_694_464,
        license: 'Llama 3.2 Community License',
        note: 'Noticeably better answers, and slow enough on a mid-range phone to feel it.',
    },
];

export const DEFAULT_MODEL = MODELS[0];

export function formatBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
    return `${Math.round(n / 1024)} KB`;
}
