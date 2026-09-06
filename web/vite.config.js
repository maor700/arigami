import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/__host/',
  plugins: [react(), tailwindcss()],
  // es2022: noVNC's decoder module uses top-level await (probing WebCodecs
  // support) — the default esbuild target predates that. noVNC itself already
  // requires a secure context + modern browser APIs, so this isn't a real
  // compatibility regression.
  build: { outDir: 'dist', target: 'es2022' },
  // Dev server pre-bundles deps with esbuild at its own (older) default target;
  // lift it to es2022 too or noVNC's top-level await breaks `vite dev`.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    proxy: {
      '/__api': 'http://localhost:3099',
      '/__ws': { target: 'http://localhost:3099', ws: true },
      '/__vnc': { target: 'http://localhost:3099', ws: true },
      '/__ticket': 'http://localhost:3099',
      '/__compare': 'http://localhost:3099',
    },
  },
});
