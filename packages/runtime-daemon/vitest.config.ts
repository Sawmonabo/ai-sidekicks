// Vitest 4.x config for @ai-sidekicks/runtime-daemon.
//
// Mirrors the contracts-package shape (per ADR-022 the longer-term form
// is a root-level vitest.config.ts with `projects: [...]`). Tests run
// under Node — `better-sqlite3` is a native binding and must not run in
// a browser-like environment.
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    // BL-123 Stage 1 measurement substrate. Options live in the repo-root
    // factory so all seven test surfaces share one definition; see
    // `vitest.shared.ts` for why coverage cannot be hoisted into a single
    // root config.
    coverage: sharedCoverageOptions(),
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
