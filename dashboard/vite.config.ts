import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type UserConfig } from 'vite';

// VITE_TEST_KEYS (pre-record.sh writes them to .env.local) are for a local dev server only. Every VITE_ variable is
// inlined into a build, so a build with them set would publish the keys: refuse it.
function noTestKeysInBuild(command: string, mode: string) {
  return {
    name: 'no-test-keys-in-build',
    buildStart() {
      if (command === 'build' && (process.env.VITE_TEST_KEYS || loadEnv(mode, process.cwd(), 'VITE_').VITE_TEST_KEYS)) {
        throw new Error('VITE_TEST_KEYS is set. Remove it from dashboard/.env.local before building: a build would ship the keys.');
      }
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), noTestKeysInBuild(command, mode)],
  // The BLS code is shared with the node, so that the page checks exactly what the node signs.
  // Resolved from here, so the page builds without node/node_modules. viem keeps its own older @noble/curves.
  resolve: {
    dedupe: ['viem'],
    alias: { '@noble/curves/bn254.js': fileURLToPath(new URL('node_modules/@noble/curves/bn254.js', import.meta.url)) },
  },
  server: { host: '127.0.0.1', fs: { allow: ['..'] } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
}) as UserConfig);
