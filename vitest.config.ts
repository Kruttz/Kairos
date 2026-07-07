import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // onnxruntime-node (fastembed's native backend, used by the optional memory embedding
    // path) crashes with "HandleScope::HandleScope Entering the V8 API without proper
    // locking in place" under vitest's default worker_threads-based pool -- its async napi
    // callback doesn't correctly re-acquire the V8 isolate lock inside a worker thread.
    // Confirmed directly: reproducible even with a single embeddings test file. Separate
    // child processes (forks) don't share this issue, since each has its own isolated V8
    // instance. This only affects test execution, not production use of Kairos itself.
    pool: 'forks',
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/mcp-server.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 65,
      },
    },
  },
})
