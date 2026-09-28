// Vitest 4.x config for @ai-sidekicks/client-sdk.
//
// Discovers the unit tests under `src/**/__tests__/` and the integration tests
// under `test/`, which drive a client end to end over a scripted daemon
// transport. Each package keeps its own config: Vitest 4 resolves `coverage`
// only at the root once `projects` exist — see the header of `vitest.shared.ts`.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions, sharedTestTimeouts } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // Stage 1 measurement substrate. Options live in the repo-root
    // factory so all seven test surfaces share one definition; see
    // `vitest.shared.ts` for why coverage cannot be hoisted into a single
    // root config.
    coverage: sharedCoverageOptions(),
    ...sharedTestTimeouts(),
  },
  // Resolve workspace deps to TS source (not stale dist/) under test via the
  // providers' `@ai-sidekicks/source` export condition. Node env = Vite SSR
  // pipeline → `ssr.resolve.conditions`; conditions replace vitest's defaults,
  // so `import`/`default` are re-listed.
  ssr: {
    resolve: {
      conditions: ["@ai-sidekicks/source", "import", "default"],
    },
  },
});
