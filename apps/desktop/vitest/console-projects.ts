// The console's own test tiers, as Vitest projects.
//
// `Spec-023 §Console Test Tiers` names nine; seven are declared here and the two that
// need a real Electron window ride `playwright.config.ts`. They live beside
// `vitest.config.ts` rather than inside it because that file was past the package's
// ceiling with them, and because the console tiers are one subject: they share the
// fixture define, the source-condition resolution, and the browser-mode options, and a
// reader comparing two of them reads them next to each other.

import type { TestProjectConfiguration } from "vitest/config";

import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "../test/console/launch-budgets.js";
import { tierTimeoutFor } from "../test/console/launch-deadline.js";
import {
  browserModeOptions,
  BROWSER_MODE_DEDUPE,
  BROWSER_MODE_OPTIMIZE_DEPS,
  WORKSPACE_SOURCE_CONDITIONS,
} from "./browser-mode.js";
import { BROWSER_VISIBLE_ENV_PREFIX } from "../test/console/screenshot/baseline-platform.js";
import {
  SCREENSHOT_TIER_MATCH_OPTIONS,
  SCREENSHOT_TIER_PROVIDER_OPTIONS,
} from "./screenshot-pins.js";

/** Every console tier that runs under Vitest, in tier order. */
export const CONSOLE_TIER_PROJECTS: readonly TestProjectConfiguration[] = [
  {
    // Tier: unit. Store transitions, projection arms, exhaustiveness, the
    // refusal grammar. Co-located with the code it proves, because a console
    // module and its unit test are read together.
    define: { __SIDEKICKS_CONSOLE_FIXTURES__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS },
    ssr: { resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS } },
    test: {
      name: "console-unit",
      environment: "happy-dom",
      include: [
        "src/renderer/src/console/**/*.test.{ts,tsx}",
        "src/renderer/src/console/**/__tests__/**/*.test.{ts,tsx}",
        // The shell subtree (Plan-023's own; it hosts the composer seat) composes
        // console seats and so needs the fixture define — it is a console tier.
        "src/renderer/src/shell/**/*.test.{ts,tsx}",
        "src/renderer/src/shell/**/__tests__/**/*.test.{ts,tsx}",
      ],
      globals: true,
    },
  },
  {
    // Tier: browser. Geometry and pixel invariants that a DOM shim cannot
    // answer — happy-dom returns zeroes for every rect, so a reading-anchor
    // or scroll-monotonicity assertion under it would pass vacuously.
    define: { __SIDEKICKS_CONSOLE_FIXTURES__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    test: {
      name: "console-browser",
      include: ["test/console/browser/**/*.test.{ts,tsx}"],
      globals: true,
      browser: browserModeOptions(),
    },
  },
  {
    // Tier: screenshot (component half). The Electron-window half rides
    // Playwright and lands with T-023p-1C-8; this project pins the frame and
    // the primitive gallery per component and per scheme.
    define: { __SIDEKICKS_CONSOLE_FIXTURES__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    // Browser mode runs the tests inside a page, and a page sees only what Vite
    // hands it: an unprefixed environment variable reaches `process.env` on the
    // server and NOTHING on the client, so the tier's baseline guard
    // (`test/console/screenshot/baseline-platform.ts`) could not read a variable
    // named the way a developer types it. This second prefix is exactly as wide as
    // the two variables that guard reads and no wider — Vite's own warning about
    // `envPrefix` is that a loose one publishes the machine's environment into the
    // bundle, and `SIDEKICKS_` alone would carry every daemon setting with it.
    envPrefix: ["VITE_", BROWSER_VISIBLE_ENV_PREFIX],
    test: {
      name: "console-screenshot",
      include: ["test/console/screenshot/**/*.test.{ts,tsx}"],
      globals: true,
      // The capture conditions that live in the PAGE rather than in the context.
      // `SCREENSHOT_TIER_PROVIDER_OPTIONS` below pins everything Playwright can be
      // told; the monospace face is a property of the document, so it is pinned
      // per test here instead. A setup file rather than a per-suite hook because
      // the tier grows a file per family, and a condition each new file has to
      // remember is a condition the next family renders without.
      setupFiles: ["./test/console/screenshot/capture-faces.setup.ts"],
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
    define: { __SIDEKICKS_CONSOLE_FIXTURES__: "true" },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS, dedupe: BROWSER_MODE_DEDUPE },
    optimizeDeps: BROWSER_MODE_OPTIMIZE_DEPS,
    test: {
      name: "console-accessibility",
      include: ["test/console/accessibility/**/*.test.{ts,tsx}"],
      globals: true,
      browser: browserModeOptions(),
    },
  },
  {
    // Tier: architecture. Structural claims about the console — most of them
    // read source as text; `scenario-wire-truth.test.ts` IMPORTS it, because
    // the rule it asserts is a shipped predicate and a test carrying its own
    // copy of a rule proves nothing about the copy that ships. Node
    // environment either way: nothing here renders.
    //
    // The define was carried before any test imported a console module, and
    // that anticipation is now load-bearing: `core/tripwires.ts` guards its
    // fixture-only assignment at MODULE scope, so an importing test would
    // otherwise abort at import with a bare `ReferenceError` naming an
    // identifier that is not a variable in any process. `false`, on the bundle
    // tier's reasoning — the process doing the reading is not a build — so such
    // a test reports its own assertion instead of the tier's configuration.
    //
    // The source conditions arrive with that first importing test, for the
    // reason the `main-unit` block above states: without them a workspace
    // VALUE import resolves against `dist/`, which is stale or absent, and the
    // tier fails to resolve `@ai-sidekicks/contracts` at all. Its files are
    // typechecked by `tsconfig.console-architecture-test.json`, which exists
    // for the other half of the same change.
    define: {
      __SIDEKICKS_CONSOLE_FIXTURES__: "false",
    },
    resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS },
    ssr: { resolve: { conditions: WORKSPACE_SOURCE_CONDITIONS } },
    test: {
      name: "console-architecture",
      environment: "node",
      include: ["test/console/architecture/**/*.test.ts"],
    },
  },
  {
    // Tier: assets. Generated artifacts byte-identical to their sources.
    //
    // The define is here for the architecture tier's reason, reached the same way:
    // this tier imports the generator, and a token module that reaches its own
    // family door for a value — the enumeration row ceiling, whose home is
    // `core/constants.ts` — pulls `core/index.ts` in with it, and that door
    // re-exports `core/tripwires.ts`, which reads this identifier at MODULE scope.
    // Without it the whole file aborts at import with a bare `ReferenceError`
    // naming something that is not a variable in any process. `false`, because the
    // process generating a stylesheet to compare is not a fixture build.
    define: {
      __SIDEKICKS_CONSOLE_FIXTURES__: "false",
    },
    test: {
      name: "console-assets",
      environment: "node",
      include: ["test/console/assets/**/*.test.ts"],
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
    // compile time, and those modules read the console's build-time gate.
    // `false`, because the process doing the reading is not a build at all.
    define: {
      __SIDEKICKS_CONSOLE_FIXTURES__: "false",
    },
    test: {
      name: "console-bundle",
      environment: "node",
      include: ["test/console/budget/**/*.test.ts"],
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
    // nothing writes, and those modules read the console's build-time gate.
    // `false`, because the DRIVER process is not a fixture build; the window
    // it launches is one, in another process entirely.
    define: {
      __SIDEKICKS_CONSOLE_FIXTURES__: "false",
    },
    test: {
      name: "console-e2e",
      environment: "node",
      include: ["test/console/e2e/**/*.test.ts"],
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
    // Its own project rather than a slow file inside `console-e2e` so that
    // `pnpm test:console-e2e` stays a fast gate a person will actually run
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
      __SIDEKICKS_CONSOLE_FIXTURES__: "false",
    },
    test: {
      name: "console-endurance",
      environment: "node",
      include: ["test/console/endurance/**/*.test.ts"],
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
    // Not one of the nine tiers: the micro-benchmark ledger. Separated so a
    // benchmark's timing noise can never fail a gate — it records, and a
    // human reads the ledger.
    test: {
      name: "console-bench",
      environment: "node",
      include: ["test/console/bench/**/*.bench.ts", "test/console/bench/**/*.test.ts"],
    },
  },
];
