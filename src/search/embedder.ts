/** Main-thread client for the embedding worker. */

export interface EmbedProgress {
  loaded: number;
  total: number;
  file: string;
}

export class Embedder {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  private readyPromise: Promise<string> | null = null;
  backend = 'unknown';

  onProgress?: (p: EmbedProgress) => void;

  async init(): Promise<string> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<string>((resolve, reject) => {
      this.worker = new Worker(new URL('./embedder.worker.ts', import.meta.url), { type: 'module' });

      this.worker.onmessage = (ev) => {
        const msg = ev.data;
        switch (msg.type) {
          case 'ready':
            this.backend = msg.backend;
            resolve(msg.backend);
            break;
          case 'progress':
            this.onProgress?.(msg);
            break;
          case 'embedded': {
            this.pending.get(msg.id)?.resolve(msg.vectors);
            this.pending.delete(msg.id);
            break;
          }
          case 'error': {
            const err = new Error(msg.message);
            if (msg.id !== undefined) {
              this.pending.get(msg.id)?.reject(err);
              this.pending.delete(msg.id);
            } else {
              reject(err);
            }
            break;
          }
        }
      };

      this.worker.onerror = (e) => reject(new Error(e.message || 'embedder worker failed'));
      this.worker.postMessage({ type: 'init' });
    });

    return this.readyPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    await this.init();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'embed', id, texts });
    });
  }

  async embedOne(text: string): Promise<Float32Array> {
    return (await this.embed([text]))[0];
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
  }
}

export const embedder = new Embedder();
