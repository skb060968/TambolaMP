import { defineConfig } from 'vite';

/**
 * Tambola MP — Vite single-entry build.
 *
 * Same SPA serves both TV and phone roles, dispatched at runtime.
 * Firebase is split into its own chunk for independent caching.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: ['firebase/app', 'firebase/database', 'firebase/auth'],
        },
      },
    },
  },
  server: {
    open: true,
  },
});
