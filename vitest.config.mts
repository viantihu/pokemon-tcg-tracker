import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Hang protection, not a performance bound (UIL-021). PGlite-backed files each boot a fresh WASM
    // Postgres and apply every migration; under parallel workers on a loaded machine they crossed
    // vitest's 5 s default test timeout at random (5.0–5.4 s, passing alone) on two of three full
    // runs on 2026-09-19, and the setup hook in tests/repo/promote-collection.test.ts crossed the 10 s
    // default hook timeout the same way (10.6 s). Both budgets are raised to the same 20 s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
