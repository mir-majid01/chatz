import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose: the app build has Tailwind and
 * Rolldown plugins that a node-only rule test does not need and should not pay
 * for. Run the rule suite against the emulator with `npm run test:rules`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The emulator needs a few seconds to boot and load rules per context.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // Firestore rules are global state; parallel files would race on the emulator.
    fileParallelism: false,
  },
});
