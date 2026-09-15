import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the web app run in plain node (no DOM): what is tested here is
// server-side session and route-handler logic, which never touches a document.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` is a build-time guard with no runtime module — it does not
      // resolve outside a Next build, so importing `auth-session.ts` from a spec
      // fails before any test runs. Stub it.
      'server-only': fileURLToPath(new URL('./lib/test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['app/**/*.spec.{ts,tsx}', 'components/**/*.spec.{ts,tsx}', 'lib/**/*.spec.{ts,tsx}'],
  },
});
