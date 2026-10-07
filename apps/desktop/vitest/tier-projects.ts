// The renderer's test tiers as Vitest projects: renderer (unit), browser, accessibility, bundle,
// e2e and endurance.
//
// No tier is configured by a Playwright runner config, and none exists. `e2e` and `endurance` are
// Vitest projects in a Node environment, because the test file drives the app, which runs in
// another process launched through `tests/helpers/electron/harness.ts`, the package's single
// `_electron` launch. Browser mode drives Playwright for the page tiers.
//
// They live beside `vitest.config.ts` because the tiers share the fixture define, the
// source-condition resolution and the browser-mode options.

import type { TestProjectConfiguration, TestProjectInlineConfiguration } from "vitest/config";

import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "#test/helpers/launch/budgets.ts";
import { tierTimeoutFor } from "#test/helpers/launch/deadline.ts";

import { WORKSPACE_SOURCE_CONDITIONS } from "../../../vitest.shared.js";
import {
  browserModeOptions,
  BROWSER_MODE_DEDUPE,
  BROWSER_MODE_OPTIMIZE_DEPS,
  BROWSER_MODE_SETUP_FILES,
} from "./browser-mode.js";
import { iconCompilationPlugin } from "./icon-compilation.js";
import { overlayScrollbarBundlePlugin } from "./overlay-scrollbar-bundle.js";

/**
 * The renderer unit tests that sit outside `src/renderer/src/`: the scenario contract check in
 * `tests/helpers/`. They run under the renderer project's DOM, so the Node projects whose globs
 * reach the same folders exclude them.
 */
export const RENDERER_TESTS_OUTSIDE_SOURCE: readonly string[] = [
  "tests/helpers/scenario/contract-check/**/*.test.ts",
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
    // Tier: accessibility. `axe-core` runs inside the browser-mode page rather than through
    // `@axe-core/playwright`, which needs a Playwright `Page`; Vitest browser mode hands that only
    // to server-side custom commands, and it is the orchestrator page, not the tester iframe. Runs
    // only by name until the accessibility sweeps become a gate on every PR.
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
    // Tier: bundle. Claims about what a release bundle does not contain, and what the release main
    // refuses when launched, since both need the release build and no other tier has one. The
    // bundle's sizes are size-limit's, against `.size-limit.ts`; the test of which files that
    // config is handed sits here beside its reader, though it plants its own build.
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
    // `_electron`, the path a person installing the app runs, which no other tier renders. Node
    // environment because the test file is the driver and the code under test runs in another
    // process. Each file is named for the defect it reproduces, not the module it touches.
    //
    // Playwright's auto-retrying `expect` is not used: it ships only with Playwright's runner
    // (`playwright/test`), which this tier never loads. Waiting is explicit (`locator.waitFor`,
    // `expect.poll`), asserting is Vitest's, and every wait is handed
    // `bodyAllowance.boundedMs(<its own bound>)` so the first wait that cannot fit names its step.
    //
    // Requires `pnpm build:fixtures`; the tests skip when the bundle is absent
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
    // opted into by name, the only way it runs until the endurance reference run becomes a gate
    // on every PR.
    //
    // It imports renderer source, and the global it asserts on belongs to the renderer in another
    // process, so the fixture flag is `false` as in `e2e`, like `main-unit`'s
    // `__SMOKE_BUILD__` define.
    define: {
      __FIXTURE_BUILD__: "false",
    },
    test: {
      name: "endurance",
      environment: "node",
      include: ["tests/endurance/**/*.test.ts"],
      // Derived from this tier's own body allowance: hundreds of driven churn cycles with settling
      // heap samples either side are a different subject from an end-to-end body.
      testTimeout: tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
      hookTimeout: tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
      fileParallelism: false,
    },
  },
];

/**
 * The same tiers, each resolving `~icons/*` and the overlay scrollbar library's browser bundle.
 * Declared as a map so no tier can forget a plugin, which would fail at import with an unplaceable
 * specifier only for the tiers that reach it. Each tier gets fresh plugins, since a Vite plugin
 * instance belongs to the config that installs it.
 */
export const TIER_PROJECTS: readonly TestProjectConfiguration[] = TIERS.map((tier) => ({
  ...tier,
  plugins: [iconCompilationPlugin(), overlayScrollbarBundlePlugin()],
}));
