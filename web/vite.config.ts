import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxying /v1 to the API keeps the browser on one origin in development, so
      // there are no CORS preflights and SecureStore-equivalent cookie handling is
      // not needed.
      '/v1': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});