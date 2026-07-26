import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [vue()],
  root: __dirname,
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 3211,
    proxy: {
      '/api': {
        target: 'http://localhost:3210',
        changeOrigin: true,
      },
      '/api/v1/ws': {
        target: 'ws://localhost:3210',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
