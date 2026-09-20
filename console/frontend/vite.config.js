import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * The dev proxy pointed at 127.0.0.1:8082 while the stack that `scripts/dev/stack.sh`
 * brings up publishes the control plane on 127.0.0.1:8081, so `npm run dev` against
 * the documented stack proxied to a closed port and every request failed. The target
 * now defaults to the port the stack publishes and is overridable, because a
 * developer running with NERONET_PORT_OFFSET has the API somewhere else. The dev
 * server itself moves off 8081 for the same reason: it cannot listen on the port it
 * proxies to.
 */
const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8081';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_DEV_PORT || 5173),
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false
      },
      // The live-update channel. Without ws:true the upgrade is answered with the
      // index document and the socket never opens in development.
      '/ws': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /*
         * three and recharts are reached only through the lazy route chunks that
         * import them, so naming them here keeps each one in a single file shared
         * by those routes rather than duplicated into every one. Neither is
         * reachable from the entry, so neither is preloaded by index.html.
         */
        manualChunks: {
          three_vendor: ['three', 'react-force-graph-3d', 'three-spritetext'],
          recharts_vendor: ['recharts']
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
