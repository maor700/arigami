import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/__host/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/__api': 'http://localhost:3099',
      '/__ws': { target: 'http://localhost:3099', ws: true },
      '/__ticket': 'http://localhost:3099',
      '/__compare': 'http://localhost:3099',
    },
  },
});
