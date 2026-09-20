import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 8081,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8082',
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three_vendor: ['three', 'react-force-graph-3d', 'three-spritetext'],
          recharts_vendor: ['recharts'],
          lucide_vendor: ['lucide-react']
        }
      }
    }
  },
  test: {
    // The service tests are written against node:test and keep running under
    // `node --test`; vitest owns the primitives and everything else in
    // TypeScript. Splitting on the extension keeps the two runners apart.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true
  }
});
