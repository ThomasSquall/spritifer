import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  // In npm run dev the server keeps serving these files while they are rebuilt.
  build: { outDir: '../../dist/web', emptyOutDir: !process.env.SPRITIFER_DEV },
  server: {
    port: 5173,
    // During `npm run dev:web` the API and live-sync socket come from `spritifer serve`.
    proxy: {
      '/api': 'http://localhost:7420',
      '/ws': { target: 'ws://localhost:7420', ws: true },
    },
  },
});
