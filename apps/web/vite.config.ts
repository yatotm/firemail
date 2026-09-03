/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env['FIREMAIL_API_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // SSE 也在 /api 下（/api/events?ticket=…），代理不做缓冲，事件才不会被攒住一起吐出来
      '/api': { target: API_TARGET, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/lib/test/setup.ts'],
    // eslint 规则住在 tools/ 下（配置文件要能 import 它），它的单测也跟着放那儿
    include: ['src/**/*.test.{ts,tsx}', 'tools/**/*.test.js'],
    restoreMocks: true,
  },
});
