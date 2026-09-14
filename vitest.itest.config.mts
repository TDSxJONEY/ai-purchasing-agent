import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.itest.ts"],
    // Integration tests share one database. Running them in parallel would let
    // them clobber each other's budget counters, so force a single worker.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
});