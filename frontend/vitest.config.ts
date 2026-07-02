import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
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
