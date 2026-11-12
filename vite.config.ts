import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// 版本号以 package.json 为唯一来源，构建时注入到渲染进程，避免界面上的版本号与实际构建脱节
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome128',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
