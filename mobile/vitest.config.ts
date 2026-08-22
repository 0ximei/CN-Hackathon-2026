import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The mobile suite, run in Node.
 *
 * Only modules that are free of React Native are covered — the protocol, the
 * replication policy, the mesh orchestration over a mock transport, identity,
 * and the storage helpers that were deliberately kept clear of `expo-sqlite`
 * for exactly this reason. Anything that reaches the native radio or SQLite is
 * verified on a device instead; there is no pretending otherwise.
 */
export default defineConfig({
    resolve: {
        alias: { '@core': path.resolve(__dirname, 'src/core') },
    },
    test: {
        include: ['src/**/*.test.ts'],
        // React Native's entry point is not parseable by Vite, and nothing in
        // the suite needs it. An accidental import should fail loudly here
        // rather than be quietly stubbed.
        environment: 'node',
    },
});
