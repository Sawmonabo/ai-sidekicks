// The renderer's test tiers as Vitest projects: renderer (unit), browser, accessibility, bundle,
// e2e and endurance. The array also holds two projects that gate nothing and say so in their own
// blocks: `screenshot`, a local capture aid that compares nothing, and `bench`, the
// micro-benchmark ledger.
//
// No tier is configured by a Playwright runner config, and none exists. `e2e` and `endurance` are
// Vitest projects in a Node environment, because the test file drives the app, which runs in
// another process launched through `tests/helpers/electron-harness.ts`, the package's single
// `_electron` launch. Browser mode drives Playwright for the page tiers.
//
// They live beside `vitest.config.ts` because the tiers share the fixture define, the
// source-condition resolution and the browser-mode options.

import { configDefaults } from "vitest/config";
import type { TestProjectConfiguration, TestProjectInlineConfiguration } from "vitest/config";

import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "../tests/helpers/launch-budgets.js";
import { tierTimeoutFor } from "../tests/helpers/launch-deadline.js";
import {
  browserModeOptions,
  BROWSER_MODE_DEDUPE,
  BROWSER_MODE_OPTIMIZE_DEPS,
  BROWSER_MODE_SETUP_FILES,
  WORKSPACE_SOURCE_CONDITIONS,
} from "./browser-mode.js";
import {
  pinScreenshotTierUpdateMode,
  SCREENSHOT_TIER_MATCH_OPTIONS,
  SCREENSHOT_TIER_PROVIDER_OPTIONS,
  SCREENSHOT_TIER_TIMEOUT_MS,
} from "./screenshot-pins.js";
import { iconCompilationPlugin } from "./icon-compilation.js";
import { PATH_ALIASES } from "./path-aliases.js";

// Always write, never compare. Called while this module is evaluated, before any project's
// snapshot mode is decided, so a bare `vitest run --project=screenshot` behaves as the package
// script does. `screenshot-pins.ts` says why it is an environment variable.
pinScreenshotTierUpdateMode();

/**
 * The renderer unit tests that sit outside `src/renderer/src/`: the fixtures' own
 * tests, the scenario tests, the tests of the renderer helpers in `tests/helpers/`,
 * and the tests of the two endurance support modules. They run under the renderer
 * project's DOM, so the Node projects whose globs reach the same folders exclude them.
 */
export const RENDERER_TESTS_OUTSIDE_SOURCE: readonly string[] = [
  "fixtures/**/*.test.ts",
  "tests/scenarios/**/*.test.ts",
  "tests/helpers/scenario-contract-check/**/*.test.ts",
  "tests/helpers/fixture-bridge.test.ts",
  "tests/helpers/CommittedFrameRecorder.test.tsx",
  "tests/helpers/settle.test.tsx",
  "tests/helpers/mount-app.test.ts",
  "tests/helpers/live-region.test.ts",
  "tests/endurance/streaming-lanes.test.ts",
  "tests/endurance/transcript-endurance.test-support.test.ts",
];

/** Every tier that runs under Vitest, in the order they run, before the shared plugins. */
const TIERS: readonly TestProjectInlineConfiguration[] = [
  {
    // Tier: unit. Store transitions, projection arms, exhaustiveness, the refusal grammar,
    // co-located with the code they prove.
    define: { __FIXTURE_BUILD__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS },
    ssr: { resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS } },
    test: {
      name: "renderer",
      environment: "happy-dom",
      include: ["src/renderer/src/**/*.test.{ts,tsx}", ...RENDERER_TESTS_OUTSIDE_SOURCE],
      globals: true,
    },
  },
  {
    // Tier: browser. Geometry and pixel invariants a DOM shim cannot answer: happy-dom returns
    // zeroes for every rect, so a reading-anchor or scroll assertion would pass vacuously.
    define: { __FIXTURE_BUILD__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    test: {
      name: "browser",
      include: ["tests/browser/**/*.test.{ts,tsx}"],
      globals: true,
      setupFiles: BROWSER_MODE_SETUP_FILES,
      browser: browserModeOptions(),
    },
  },
  {
    // Tier: screenshot (component half), a local capture aid. It writes every surface's picture
    // into the gitignored `__screenshots__/` and compares against nothing, so it gates no branch
    // and runs in no CI job.
    define: { __FIXTURE_BUILD__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    test: {
      name: "screenshot",
      include: ["tests/screenshot/**/*.test.{ts,tsx}"],
      globals: true,
      setupFiles: BROWSER_MODE_SETUP_FILES,
      // Derived from the wait a capture at the window ceiling is given, never written down;
      // `screenshot-pins.ts` owns the arithmetic. Both figures, because a suite here mounts its
      // surface in a hook.
      testTimeout: SCREENSHOT_TIER_TIMEOUT_MS,
      hookTimeout: SCREENSHOT_TIER_TIMEOUT_MS,
      browser: {
        ...browserModeOptions(SCREENSHOT_TIER_PROVIDER_OPTIONS),
        expect: { toMatchScreenshot: SCREENSHOT_TIER_MATCH_OPTIONS },
      },
    },
  },
  {
    // Tier: accessibility. `axe-core` runs inside the browser-mode page rather than through
    // `@axe-core/playwright`, which needs a `@playwright/test` `Page`; Vitest browser mode hands
    // that only to server-side custom commands, and it is the orchestrator page, not the tester
    // iframe.
    define: { __FIXTURE_BUILD__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    test: {
      name: "accessibility",
      include: ["tests/accessibility/**/*.test.{ts,tsx}"],
      globals: true,
      setupFiles: BROWSER_MODE_SETUP_FILES,
      browser: browserModeOptions(),
    },
  },
  {
    // Tier: bundle. Chunk sizes against `budgets.json`, and claims about what a release bundle
    // does not contain, since both need the built tree and no other tier has one.
    //
    // It names renderer constants so a rename breaks it at compile time, and those modules read
    // the renderer's build-time gate, which is `false` here because this process is not a build.
    define: {
      __FIXTURE_BUILD__: "false",
    },
    test: {
      name: "bundle",
      environment: "node",
      include: ["tests/budget/**/*.test.ts"],
    },
  },
  {
    // Tier: end-to-end. A real Electron process and window driven through Playwright's
    // `_electron`. Node environment because the test file is the driver and the code under test
    // runs in another process.
    //
    // Requires `pnpm build:fixtures`; the tests skip with a message when the bundle is absent
    // (`fixtureBundleExists`) instead of failing inside Electron's startup.
    //
    // It imports renderer constants so a rename breaks it at compile time. Their build-time gate
    // is `false` because the driver is not a fixture build; the window it launches is.
    define: {
      __FIXTURE_BUILD__: "false",
    },
    test: {
      name: "e2e",
      environment: "node",
      include: ["tests/e2e/**/*.test.ts"],
      // Derived from the registered bounds, never written down: the launch budget, this tier's
      // body allowance and the settlement residual. Every phase reports its own overrun first, so
      // vitest's generic kill is only the backstop.
      testTimeout: tierTimeoutFor(BODY_ALLOWANCE_MS),
      hookTimeout: tierTimeoutFor(BODY_ALLOWANCE_MS),
      // One Electron at a time: each holds a GPU context and a profile directory, and parallel
      // files would make a four-core runner the thing being measured.
      fileParallelism: false,
    },
  },
  {
    // Tier: endurance. The same application, held open and driven, with the heap read at both
    // ends of the run. Its own project so `pnpm test:e2e` stays a fast gate and the slow tier is
    // opted into by name.
    //
    // It imports renderer source, and the global it asserts on belongs to the renderer in another
    // process, so the fixture flag is `false` as in `e2e`, like `main-unit`'s
    // `__SIDEKICKS_SMOKE_BUILD__` define.
    define: {
      __FIXTURE_BUILD__: "false",
    },
    test: {
      name: "endurance",
      environment: "node",
      include: ["tests/endurance/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...RENDERER_TESTS_OUTSIDE_SOURCE],
      // Derived from this tier's own body allowance: hundreds of driven churn cycles with settling
      // heap samples either side are a different subject from an end-to-end body.
      testTimeout: tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
      hookTimeout: tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
      fileParallelism: false,
    },
  },
  {
    // Not one of the registered tiers: the micro-benchmark ledger, separate so a benchmark's timing
    // noise can never fail a gate. The fixture flag is `false`, as for every non-fixture project:
    // a benchmark measures the shipping path, and the flag decides whether imported renderer
    // modules publish tripwires onto `globalThis`.
    define: { __FIXTURE_BUILD__: "false" },
    test: {
      name: "bench",
      environment: "node",
      include: ["tests/bench/**/*.bench.ts", "tests/bench/**/*.test.ts"],
    },
  },
];

/**
 * The same tiers, each resolving `~icons/*` and the path aliases. Declared as a map so no tier can
 * forget one, which would fail at import with an unplaceable specifier only for the tiers that
 * reach it. Each tier gets a fresh plugin, since a Vite plugin instance belongs to the config that
 * installs it.
 */
export const TIER_PROJECTS: readonly TestProjectConfiguration[] = TIERS.map((tier) => ({
  ...tier,
  resolve: { ...tier.resolve, alias: PATH_ALIASES },
  plugins: [iconCompilationPlugin()],
}));
