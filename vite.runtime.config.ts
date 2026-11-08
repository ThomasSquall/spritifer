import { defineConfig } from 'vite';

/** Builds the game runtime embedded in exported games (dist/runtime/player.js, a single IIFE). */
export default defineConfig({
  build: {
    outDir: 'dist/runtime',
    // In npm run dev the server keeps reading this file while it is rebuilt.
    emptyOutDir: !process.env.SPRITIFER_DEV,
    target: 'es2019',
    lib: {
      entry: 'src/runtime/standalone.ts',
      formats: ['iife'],
      name: 'SpritiferRuntime',
      fileName: () => 'player.js',
    },
  },
});
