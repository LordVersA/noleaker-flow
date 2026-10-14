import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { alias, define, esTarget, outDir } from './vite.target.ts';

// The Flow page script is a classic MAIN-world script, so it is built on its own as a
// self-contained IIFE: dist/<target>/content/flow.js.
export default defineConfig({
  publicDir: false,
  resolve: { alias },
  define,
  build: {
    outDir,
    emptyOutDir: false,
    target: esTarget,
    minify: process.env.NOLEAKER_DEV === '1' ? false : 'oxc',
    sourcemap: process.env.NOLEAKER_DEV === '1',
    lib: {
      entry: resolve(import.meta.dirname, 'src/flow/page.ts'),
      formats: ['iife'],
      name: 'noleaker_flow',
      fileName: () => 'content/flow.js',
    },
  },
});
