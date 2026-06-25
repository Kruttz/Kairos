import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/standalone.ts', 'src/cli.ts', 'src/mcp-server.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: ({ format }) => {
    if (format === 'cjs') {
      return { js: '' }
    }
    return { js: '' }
  },
})
