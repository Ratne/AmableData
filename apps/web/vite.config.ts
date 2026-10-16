import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // apps/core wrangler dev serves the API on 8787.
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
    },
  },
  // `dist/` is consumed by apps/core wrangler assets config.
  build: {
    outDir: 'dist',
  },
});
