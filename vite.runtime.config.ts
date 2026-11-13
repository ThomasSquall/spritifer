import { defineConfig } from 'vite';

/**
 * Builds the game runtime embedded in games (a single IIFE):
 * - dist/runtime/player.js: exported games (web, Android). Tools of the editor's server (F8 "mark here") are compiled out.
 * - dist/runtime/player-dev.js (RUNTIME_KIND=dev): the game page served by the editor (Play, play.html).
 */
const dev = process.env.RUNTIME_KIND === 'dev';
export default defineConfig({
  define: { __SPRITIFER_DEV__: JSON.stringify(dev) },
  build: {
    outDir: 'dist/runtime',
    // In npm run dev the server keeps reading these files while they are rebuilt; the second build keeps the first.
    emptyOutDir: !process.env.SPRITIFER_DEV && !dev,
    target: 'es2019',
    lib: {
      entry: 'src/runtime/standalone.ts',
      formats: ['iife'],
      name: 'SpritiferRuntime',
      fileName: () => (dev ? 'player-dev.js' : 'player.js'),
    },
  },
});
