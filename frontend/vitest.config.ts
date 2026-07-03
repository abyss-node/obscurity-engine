import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // tsconfig sets "jsx": "preserve" (Next's own compiler handles the actual
  // transform in dev/build); esbuild needs an explicit mode for vitest's
  // standalone run, and "automatic" auto-imports the react/jsx-runtime
  // instead of requiring `React` in scope (P1-B component tests use RTL).
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // jsdom is the default so lib/cache.ts (localStorage) and future component
    // tests work out of the box. Node-only suites opt out per file with a
    // `// @vitest-environment node` header.
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
