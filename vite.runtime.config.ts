import { defineConfig } from 'vite';

/** Builds the game runtime embedded in exported games (dist/runtime/player.js, a single IIFE). */
export default defineConfig({
  build: {
    outDir: 'dist/runtime',
    emptyOutDir: true,
    target: 'es2019',
    lib: {
      entry: 'src/runtime/standalone.ts',
      formats: ['iife'],
      name: 'SpritiferRuntime',
      fileName: () => 'player.js',
    },
  },
});
