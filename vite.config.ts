import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    // During `npm run dev:web` the API and live-sync socket come from `spritifer serve`.
    proxy: {
      '/api': 'http://localhost:7420',
      '/ws': { target: 'ws://localhost:7420', ws: true },
    },
  },
});
