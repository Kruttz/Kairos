import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
