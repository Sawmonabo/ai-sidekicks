// The renderer's test tiers, as Vitest projects.
//
// The tiers — renderer (the unit tier), browser, end-to-end, accessibility,
// endurance, bundle — are each declared below.
// The array also holds two projects that are NOT tiers and gate nothing, each
// saying so in its own block: `screenshot`, the local capture aid that compares
// against nothing, and `bench`, this package's own micro-benchmark ledger. No count
// is stated here: a reader counts the array.
//
// AND NONE OF THEM RIDES A `playwright.config.ts`, which does not exist in this
// repository. The two tiers that need a real Electron window — `e2e` and
// `endurance` — are Vitest projects in a NODE environment, because the test file is
// the DRIVER and the code under test runs in another process; they reach that
// process through `tests/helpers/electron-harness.ts`, which holds the package's
// single `_electron` launch. Playwright is a LIBRARY on both halves: browser mode drives it
// for the three page tiers, the harness drives it for the two window ones, and no
// tier is configured by a Playwright runner config.
//
// They live beside `vitest.config.ts` rather than inside it because that file was past
// the package's ceiling with them, and because the tiers are one subject: they
// share the fixture define, the source-condition resolution, and the browser-mode
// options, and a reader comparing two of them reads them next to each other.

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

// ALWAYS WRITE, NEVER COMPARE. Called while this module is evaluated, which is while
// Vitest resolves its configuration and before any project's snapshot mode is decided,
// so a bare `vitest run --project=screenshot` behaves as the package script
// does. `screenshot-pins.ts` says why it is an environment variable and what pays for
// its reach.
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
    // Tier: unit. Store transitions, projection arms, exhaustiveness, the
    // refusal grammar. Co-located with the code it proves, because a renderer
    // module and its unit test are read together.
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
    // Tier: browser. Geometry and pixel invariants that a DOM shim cannot
    // answer — happy-dom returns zeroes for every rect, so a reading-anchor
    // or scroll-monotonicity assertion under it would pass vacuously.
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
    // Tier: screenshot (component half). A LOCAL CAPTURE AID:
    // it writes every surface's picture into the gitignored `__screenshots__/`
    // and compares against nothing, so it gates no branch and runs in no CI job.
    // The Electron-window half rides Playwright and is not wired yet.
    define: { __FIXTURE_BUILD__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    test: {
      name: "screenshot",
      include: ["tests/screenshot/**/*.test.{ts,tsx}"],
      globals: true,
      setupFiles: BROWSER_MODE_SETUP_FILES,
      // DERIVED from the wait a capture at the window ceiling is given, never
      // written down — `screenshot-pins.ts` owns the arithmetic and says why the
      // inherited browser-mode default stopped being large enough the moment
      // `settled-capture.ts` began sizing each capture's wait to the window it
      // opened. Both figures, because a suite here mounts its surface in a hook.
      testTimeout: SCREENSHOT_TIER_TIMEOUT_MS,
      hookTimeout: SCREENSHOT_TIER_TIMEOUT_MS,
      browser: {
        ...browserModeOptions(SCREENSHOT_TIER_PROVIDER_OPTIONS),
        expect: { toMatchScreenshot: SCREENSHOT_TIER_MATCH_OPTIONS },
      },
    },
  },
  {
    // Tier: accessibility. `axe-core` runs INSIDE the browser-mode page
    // rather than through `@axe-core/playwright`, which needs a
    // `@playwright/test` `Page` handle that Vitest browser mode hands only to
    // server-side custom commands, never to test code — and that handle is
    // the orchestrator page, not the tester iframe. Same engine, same rule
    // set, one less indirection.
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
    // Tier: bundle. Chunk sizes against `budgets.json`, plus the heap-at-rest
    // reading, which shares the harness because both are measurements against
    // the same budget file — the directory is named for the budget file both
    // read rather than for the one artifact class one of them measures. Also
    // where claims about what a RELEASE bundle does not contain live, since
    // those need the same built tree and no other tier has one.
    //
    // Same substitution the two Electron tiers carry, and for the same
    // reason: this tier names renderer constants so a rename breaks it at
    // compile time, and those modules read the renderer's build-time gate.
    // `false`, because the process doing the reading is not a build at all.
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
    // Tier: end-to-end. A real Electron process, a real window, driven
    // through Playwright's `_electron` on the runner this repository already
    // uses. Node environment because the test file is the DRIVER — the code
    // under test runs in another process entirely, which is exactly what
    // makes this tier different from the browser-mode ones.
    //
    // Requires `pnpm build:fixtures`. The tests skip with a message rather
    // than fail when the bundle is absent (see `electron-harness.ts`), so a
    // developer who runs the whole suite without building is told what to do
    // instead of shown a stack trace from inside Electron's startup.
    //
    // Mirrors the release substitution because this tier imports renderer
    // constants — a database name, a partition, a key — so that a rename
    // breaks it at compile time rather than leaving it reading a record
    // nothing writes, and those modules read the renderer's build-time gate.
    // `false`, because the DRIVER process is not a fixture build; the window
    // it launches is one, in another process entirely.
    define: {
      __FIXTURE_BUILD__: "false",
    },
    test: {
      name: "e2e",
      environment: "node",
      include: ["tests/e2e/**/*.test.ts"],
      // DERIVED from the registered bounds, never written down: the launch
      // budget, this tier's body allowance, and the settlement residual. It
      // was a 60 000 ms literal, and the arithmetic under it did not close —
      // a launch may spend 45 000 ms of it and cleanup reserves 10 000 ms
      // more, so a body with three 10 000 ms polls of its own was killed
      // mid-poll with the Electron left alive. A larger figure is safe now
      // for the reason it was not then: every phase inside it reports its own
      // overrun first, so vitest's generic kill is the backstop rather than
      // the thing a reader is left with.
      testTimeout: tierTimeoutFor(BODY_ALLOWANCE_MS),
      hookTimeout: tierTimeoutFor(BODY_ALLOWANCE_MS),
      // One Electron at a time. These launch real processes that each hold a
      // GPU context and a profile directory; running files in parallel turns
      // a four-core runner into the thing being measured.
      fileParallelism: false,
    },
  },
  {
    // Tier: endurance. The same real application, held open and driven, with
    // the heap read at both ends of the run.
    //
    // Its own project rather than a slow file inside `e2e` so that
    // `pnpm test:e2e` stays a fast gate a person will actually run
    // before pushing, and the slow tier is opted into by name.
    // Mirrors the release substitution so importing renderer source here —
    // the tripwire module owns the property name this tier reads, and
    // importing it through the harness is what keeps the two sides from
    // drifting into a vacuous assertion — does not hit a bare identifier.
    // `false`, because the DRIVER process is not a fixture build; the global
    // this tier asserts on belongs to the renderer, in another process
    // entirely. Same shape as `main-unit`'s `__SIDEKICKS_SMOKE_BUILD__`
    // define above.
    define: {
      __FIXTURE_BUILD__: "false",
    },
    test: {
      name: "endurance",
      environment: "node",
      include: ["tests/endurance/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...RENDERER_TESTS_OUTSIDE_SOURCE],
      // Derived from this tier's OWN body allowance, which its launches pass
      // to the harness: hundreds of driven churn cycles with settling heap
      // samples either side is a different subject from an end-to-end body,
      // not a slower version of one.
      testTimeout: tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
      hookTimeout: tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
      fileParallelism: false,
    },
  },
  {
    // Not one of the registered tiers: the
    // micro-benchmark ledger. Separated so a
    // benchmark's timing noise can never fail a gate — it records, and a
    // human reads the ledger.
    // The fixture flag is FALSE here, as it is for every non-fixture project: an arm
    // that imports a renderer module imports `lib/tripwires.ts` with it, and the flag
    // is what decides whether they publish themselves onto `globalThis`. A benchmark
    // measures the shipping path, so it measures the shipping value.
    define: { __FIXTURE_BUILD__: "false" },
    test: {
      name: "bench",
      environment: "node",
      include: ["tests/bench/**/*.bench.ts", "tests/bench/**/*.test.ts"],
    },
  },
];

/**
 * The same tiers, each resolving `~icons/*` and the path aliases.
 *
 * Declared as a map rather than as lines repeated per tier, because a tier that
 * forgot one would fail at import with a specifier no reader could place — and
 * only for the tiers that happen to reach it, which is a hole nothing reports. A
 * fresh plugin per tier: a Vite plugin instance belongs to the config that
 * installs it.
 */
export const TIER_PROJECTS: readonly TestProjectConfiguration[] = TIERS.map((tier) => ({
  ...tier,
  resolve: { ...tier.resolve, alias: PATH_ALIASES },
  plugins: [iconCompilationPlugin()],
}));
