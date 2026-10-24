import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the Vite server (http://localhost:5173) proxies the API,
// the live stream and WebFMC to the backend on 127.0.0.1:8787.
const backend = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend },
      '/webfmc': { target: backend, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
