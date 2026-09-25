import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    threads: false,
    coverage: {
      // #570: Coverage enforcement — thresholds prevent silent regression.
      enabled: true,
      provider: "v8",
      // Measure coverage only over production source files.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/tests/**",
        "src/testing/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
      reporter: ["text", "lcov", "json-summary"],
    },
  },
});
