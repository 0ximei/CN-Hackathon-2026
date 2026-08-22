import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Mirrors mobile/metro.config.js so the React Native app's tests can run
      // under this project's Vitest instead of needing a second runner.
      '@core': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  build: {
    // The WebLLM engine is dynamically imported and lands in its own ~6MB
    // chunk, which is expected — it only downloads if the user opts into
    // local generation.
    chunkSizeWarningLimit: 1500,
  },
  optimizeDeps: {
    // These ship their own workers/wasm; pre-bundling them breaks the worker URLs.
    exclude: ['@huggingface/transformers', '@mlc-ai/web-llm'],
  },
  server: {
    host: true,
    allowedHosts: true,
    port: Number(process.env.PORT) || 5173,
    // Fail loudly if the port is taken rather than silently drifting to 5174
    // and leaving you staring at whatever else is squatting on 5173.
    strictPort: true,
    headers: {
      // Required for WebGPU/wasm threads used by transformers.js.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  test: {
    environment: 'node',
    // The mobile app shares this project's protocol layer, so its portable
    // tests run here too. Anything of its own that needs a device is not
    // tested here and says so.
    include: ['src/**/*.test.ts', 'mobile/src/**/*.test.ts'],
  },
} as never);
