import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The Firebase + LiveKit keys are shared by every game in this Firebase project,
// so the .env lives one level up (the project folder) instead of being duplicated
// into each repo. Resolved from this file's own URL so it is independent of cwd.
const sharedEnvDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * Tambola MP — Vite single-entry build.
 *
 * Same SPA serves both TV and phone roles, dispatched at runtime.
 * Firebase is split into its own chunk for independent caching.
 */
export default defineConfig({
  envDir: sharedEnvDir,
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
