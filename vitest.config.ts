import { defineConfig } from "vitest/config";
import * as path from "node:path";

// pi-test-harness imports `getModel` from pi-ai, removed in 1.5.2 — redirect
// the module to a test shim that re-exports the real one and adds it back.
// See __tests__/pi-ai-shim.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-ai": path.resolve(import.meta.dirname, "__tests__/pi-ai-shim.ts"),
    },
  },
  test: {
    environment: "node",
    // Resolve the harness's imports through Vite so the pi-ai alias applies to it
    server: { deps: { inline: ["@marcfargas/pi-test-harness"] } },
    globals: false,
    testTimeout: 15000,
  },
});
