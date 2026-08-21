import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'MeshNet — Offline Distributed Search',
        short_name: 'MeshNet',
        description:
          'Semantic search across an offline mesh of peer nodes, answered by an on-device LLM.',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell, fonts and corpus shards — everything needed
        // to boot and search offline. The ONNX runtime (21MB) and the model
        // weights are runtime-cached instead: the first run needs the network
        // for the weights anyway, so precaching the runtime at install would
        // cost 20MB up front and still not make run one offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}', 'corpus/*.json'],
        // The WebLLM chunk is 6MB and only loads if the user opts into local
        // generation; runtimeCaching below keeps it offline after first use.
        globIgnores: ['**/webllm-*.js', '**/node_modules/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /webllm-.*\.js$/,
            handler: 'CacheFirst',
            options: { cacheName: 'meshnet-webllm', expiration: { maxEntries: 4 } },
          },
          {
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'meshnet-wasm',
              expiration: { maxEntries: 12 },
            },
          },
          {
            // Model weights: immutable once fetched, so CacheFirst is correct
            // and is what makes every later launch fully offline.
            urlPattern: /^https:\/\/(huggingface\.co|cdn-lfs.*\.hf\.co|raw\.githubusercontent\.com)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'meshnet-models',
              expiration: { maxEntries: 64 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Named so the service worker can single it out; see globIgnores.
          if (id.includes('@mlc-ai/web-llm')) return 'webllm';
          return undefined;
        },
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  optimizeDeps: {
    // These ship their own workers/wasm; pre-bundling them breaks the worker URLs.
    exclude: ['@huggingface/transformers', '@mlc-ai/web-llm'],
  },
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
    headers: {
      // Required for WebGPU/wasm threads used by transformers.js.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
} as never);
