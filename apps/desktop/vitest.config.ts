// Vitest 4.x config for @ai-sidekicks/desktop.
//
// Plan-001 Phase 5 T5.2 substrate completion (T-amend-002): introduces a
// renderer-unit-test surface alongside the existing main-process smoke test.
// The two surfaces have fundamentally different runtime environments and
// MUST NOT share a single `environment` setting:
//
//   • main suite: existing `test/launch.smoke.test.ts` spawns a real Electron
//     binary from a Node context — DOM/window globals would be wrong shape.
//   • renderer suite: new `src/renderer/**/__tests__/**` exercises React
//     components against `window.sidekicks` — needs a DOM environment.
//
// Vitest's `projects` API (stable in Vitest 3+, present in 4.1.5) lets us
// declare both inside a single config so `pnpm test` runs them in one
// invocation. Per-project `include` globs are disjoint, so there is no
// double-discovery risk.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) note: happy-dom is a
// pure-JS DOM shim with no Node-IPC capabilities; it does NOT punch a hole
// in the renderer's process isolation at test time. The bridge surface
// (`window.sidekicks`) is mocked per test (see SessionBootstrap.test.tsx)
// rather than dispatched to the real preload — there is no `electron`
// runtime in this test surface.
//
// Plan-023 Phase 1C (T-023p-1C-1) registers the console's test tiers
// (`Spec-023 §Console Test Tiers`). Seven of the nine tiers are Vitest projects
// declared below; `end-to-end` and `endurance` need a real Electron window and
// live in `playwright.config.ts` beside this file. Every glob is disjoint —
// including the two NARROWINGS this phase makes to pre-existing projects, which
// are load-bearing rather than tidying:
//
//   • `main`'s `test/**/*.test.ts` would otherwise swallow every console tier
//     under `test/console/**` and run it in the smoke project's node
//     environment. It becomes `test/*.test.ts`, which is exactly the three
//     files directly under `test/` it has always meant.
//   • `renderer`'s `src/renderer/**/__tests__/**` is unchanged, but its
//     `exclude` now names the console and shell subtrees so a test co-located
//     under `src/renderer/src/console/**` or `src/renderer/src/shell/**`
//     belongs to `console-unit` alone.
import { playwright, type PlaywrightProviderOptions } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { sharedCoverageOptions } from "../../vitest.shared";
import { BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE } from "./test/console/browser-mode-deps";
import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "./test/console/launch-budgets";
import { tierTimeoutFor } from "./test/console/launch-deadline";

/**
 * Conditions that resolve workspace *value* imports to TS source rather than a
 * stale `dist/`. Shared by every DOM-environment project, because each of them
 * imports `@ai-sidekicks/contracts` for value as well as type.
 */
const WORKSPACE_SOURCE_CONDITIONS = ["@ai-sidekicks/source", "import", "default"];

/**
 * Everything a browser-mode tier renders through, pre-bundled in ONE optimizer
 * pass and deduplicated. The list lives in `test/console/browser-mode-deps.ts`
 * so the architecture tier can hold it against the Base UI entries the source
 * tree imports: the optimizer keys on the exact specifier, so a subpath the list
 * does not name is discovered lazily on a cold cache, starts a second pass, and
 * leaves the tier with two React copies — the first Base UI `useContext` then
 * reads `null` and the whole tree fails to render.
 */
const BROWSER_MODE_OPTIMIZE_DEPS = { include: [...BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE] };

/** The one React copy every browser-mode tier resolves. */
const BROWSER_MODE_DEDUPE = ["react", "react-dom"];

/**
 * The window the console is measured in.
 *
 * Vitest browser mode defaults to a 414×896 phone viewport. The console is a
 * desktop application whose frame is a 52 px rail beside a surface, so at 414 px
 * the surface is 362 px wide — every geometry assertion measures a layout no
 * person will ever see, "does not scroll horizontally" passes because nothing has
 * room to overflow, and a screenshot baseline is a phone-shaped thumbnail. 1440×900
 * is the smallest common laptop, which is the honest floor to hold the budgets at:
 * a baseline captured at the widest window would hide exactly the crowding that
 * shows up first at the narrowest one.
 */
const BROWSER_MODE_VIEWPORT = { width: 1440, height: 900 };

/**
 * Browser-mode settings shared by every console tier that renders.
 *
 * A FACTORY, not a shared constant, and that is not a style choice. Vitest resolves
 * each browser project by writing a derived name back onto the instance descriptor
 * it was handed; three projects spread from one object literal share one `instances`
 * array, so the second project finds the first one's name already stamped on it and
 * the whole run aborts with "the project name `console-browser (chromium)` was
 * already defined". A fresh object per project is what keeps them independent.
 *
 * `screenshotFailures` is OFF deliberately. Vitest writes a failure capture into
 * `__screenshots__` beside the test file — the same directory `toMatchScreenshot`
 * keeps its committed baselines in — so leaving it on makes that directory mean two
 * different things and puts throwaway PNGs of red tests next to references a review
 * is supposed to read. The screenshot tier still writes its own actual/diff pair on
 * a mismatch, which is the capture that is worth having.
 */
function browserModeOptions(providerOptions?: PlaywrightProviderOptions): {
  enabled: true;
  provider: ReturnType<typeof playwright>;
  headless: true;
  screenshotFailures: false;
  viewport: { width: number; height: number };
  instances: [{ browser: "chromium" }];
} {
  return {
    enabled: true,
    provider: playwright(providerOptions),
    headless: true,
    screenshotFailures: false,
    viewport: { ...BROWSER_MODE_VIEWPORT },
    instances: [{ browser: "chromium" }],
  };
}

/**
 * The rendering conditions the screenshot tier's references are minted under.
 *
 * Everything here is a value the tier ALREADY depended on and did not state, which
 * is the whole reason it is stated: a reference image is only a gate if the next
 * run renders under the same conditions, and a condition inherited from a library
 * default is one an upgrade can move without anyone editing this repository.
 *
 * `viewport` is the load-bearing one, and it is not the same knob as
 * `BROWSER_MODE_VIEWPORT`. That one sizes the TESTER IFRAME; this one sizes the
 * Playwright page the iframe lives in, and the provider deliberately does not
 * derive the second from the first. Vitest then fits the iframe into the page with
 * `scale = min(1, pageWidth / iframeWidth, pageHeight / iframeHeight)` and applies
 * it as a CSS `transform: scale()`. Against Playwright's own 1280×720 default that
 * resolved to 0.8, so a console laid out at 1440×900 was captured through a
 * fractional downscale — every border and glyph resampled off the pixel grid, which
 * is exactly the operation two Skia/CoreText builds disagree about, and a 1152×720
 * reference for a tier whose comment says it measures 1440×900. Matching the page
 * to the iframe makes the scale exactly 1 and the capture 1:1.
 *
 * The other three are Playwright's current defaults, restated so they are pinned by
 * this file rather than by the version range: `deviceScaleFactor` because it
 * multiplies straight into the reference's dimensions (`screenshotOptions.scale` is
 * `"device"`), and the two media emulations because the console's generated base
 * stylesheet branches on `prefers-reduced-motion` and Chromium branches on forced
 * colors. `colorScheme` is deliberately ABSENT: the harness drives that per test
 * through `Emulation.setEmulatedMedia`, and a context-level value would be a second
 * writer of the same emulated media state.
 */
const SCREENSHOT_TIER_PROVIDER_OPTIONS: PlaywrightProviderOptions = {
  contextOptions: {
    viewport: { ...BROWSER_MODE_VIEWPORT },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
    forcedColors: "none",
  },
};

/**
 * How close a capture has to be to its reference to count as the same image.
 *
 * ZERO, which is Vitest's default — pinned here rather than inherited, and pinned
 * on measurement rather than on caution. The measurements are worth carrying,
 * because they are what refuses a tolerance rather than what sizes one.
 *
 * After the pins above, this tier's residue is exactly SIX pixels: one in
 * `frame-first-run-light`, six in `palette-open-light`, none in
 * `frame-first-run-dark`, comparing a macOS 26.6.1 host against references minted
 * on GitHub's `macos-15` image (2026-09-02). Every one of them sits on the corner
 * of a `⌘` keycap glyph — (645,552) in the frame, (992..993, 493..533) in the
 * palette — which is the one character on these surfaces no stack in
 * `tokens/palette.ts` supplies: nothing self-hosts IBM Plex yet, so `system-ui`
 * and `ui-monospace` resolve to the host's own face and its outline moves with the
 * operating system. So the residue is real and it is bounded and it is six.
 *
 * A budget above it would have to fit UNDER the smallest change worth catching,
 * and that ceiling was measured too, by planting regressions and reading the count
 * at zero: a one-pixel rail move (`52px` → `53px`) is 3 690 and 4 594 pixels; the
 * stale palette reference this lane found — a two-command Help group that had
 * appeared since the capture — is 26 016; but a SINGLE changed glyph in a palette
 * label is **20**. Six and twenty is a window 3.3× wide, and a punctuation glyph
 * is smaller than a letter, so any budget inside it is a coin-flip on both edges.
 * There is no number here that is both useful and safe, so the tier takes none.
 *
 * What that costs is named rather than hidden: a developer Mac running this tier
 * goes red on those six pixels. That is the advisory status
 * `test/console/screenshot/frame.test.tsx`'s header describes, and the fix for a
 * reference that genuinely needs to move is to regenerate it on the runner that
 * owns it — never to widen this.
 *
 * pixelmatch's own `threshold` and `includeAA` defaults (0.1, AA pixels excluded)
 * are left alone, and one consequence of `threshold` is worth stating because it is
 * NOT this budget's doing: a 3% lightness change to `surface-raised` — the token
 * that paints the whole palette dialog — registers zero mismatched pixels here,
 * while a 20% one registers 257 070. This tier sees geometry and text far more
 * sharply than it sees a small colour delta, and lowering `threshold` to change
 * that would have to be paid for in residue.
 */
const SCREENSHOT_TIER_MATCH_OPTIONS = {
  comparatorName: "pixelmatch",
  comparatorOptions: { allowedMismatchedPixels: 0 },
} as const;

export default defineConfig({
  test: {
    // BL-123 Stage 1 measurement substrate. Vitest 4 resolves `coverage`
    // root-only when `projects` are declared, so this block sits beside
    // `projects`, not inside one.
    //
    // The denominator is deliberately the renderer sub-tree alone. The `main`
    // project's one test spawns a real Electron binary as a child process
    // (test/launch.smoke.test.ts); v8 coverage instruments this process, not
    // that one, so `src/main/**` and `src/preload/**` would report ~0% and drag
    // the package number toward a figure that measures the harness rather than
    // the code. Widening this include is the correct move only once the main
    // process is exercised in-process — see BL-131's renderer/E2E leg.
    coverage: sharedCoverageOptions({
      include: ["src/renderer/**/*.{ts,tsx}"],
    }),
    projects: [
      {
        test: {
          name: "main",
          environment: "node",
          // The three files directly under `test/`, and only those: the two
          // Electron-spawning probes and the sidecar unit that has always sat
          // beside them. Narrowed from `test/**/*.test.ts` by Plan-023 Phase 1C
          // so the console tiers under `test/console/**` are not
          // double-discovered here in a node environment that would fail them
          // for the wrong reason.
          //
          // The count is held by `vitest-project-globs.test.ts` rather than
          // stated here and read never. A pure unit that landed at this address
          // paid the whole tier for two `process.kill(pid, 0)` assertions — the
          // Electron download, the smoke bundle, and the serialized queue below
          // — so a fourth file here is now a red check rather than a slow one.
          include: ["test/*.test.ts"],
          // Two files under this glob each spawn a full Electron/Chromium
          // process tree — `launch.smoke.test.ts` and `lifecycle.gc.test.ts`.
          // Vitest's default `fileParallelism: true` runs them CONCURRENTLY,
          // and on a 4-vCPU hosted runner that is the documented cause of this
          // suite's intermittent boot timeout: `lifecycle.gc.test.ts` drives 80
          // forced stop-the-world full GCs over ~160 MB of allocation churn
          // while `launch.smoke.test.ts` is trying to complete a cold Chromium
          // boot against its spawn deadline, and both are also the runner's FIRST
          // Electron launches, so they contend for the same cold per-`$HOME`
          // Chromium initialisation (fontconfig cache build, NSS DB creation).
          //
          // Measured on the failing run (GitHub Actions run 33571210321):
          // vitest reported `tests 41.32s` against a wall `Duration 27.58s`,
          // so the two files provably overlapped by >=13.7 s of the smoke
          // test's 15.08 s window; `lifecycle.gc.test.ts` took 26.04 s against
          // its own header's ~5 s expectation, and the smoke boot — measured at
          // 462-510 ms unloaded — never reached `did-finish-load`.
          //
          // Serialising costs ~14 s of wall time in this project and removes
          // the contention outright. It is deliberately NOT a longer timeout —
          // this change alters no budget. (`SPAWN_TIMEOUT_MS` was separately
          // re-derived 15 s -> 30 s from the CI numbers this fix's own runs
          // produced; see that constant's comment for why the two are not the
          // same act.) The cross-PACKAGE half of the same contention — turbo
          // scheduling this project beside the daemon suite — is removed in
          // `.github/workflows/ci.yml`, not here.
          fileParallelism: false,
        },
      },
      {
        // Plan-023 Phase 1B (T-023p-1B-3). Named `main-unit` because `main` is
        // already taken by the smoke project above — these are the in-process
        // units for `src/main/**`, which neither existing project reaches.
        //
        // Deliberately NOT hung off `build:smoke` in `turbo.json`: these are
        // plain-TypeScript units that need no `electron-vite` bundle, and
        // hanging them off the smoke build would re-impose the ~25-30 s cost the
        // two-project posture exists to avoid.
        define: {
          // Mirrors the release substitution in `electron.vite.config.ts`, so
          // `main/index.ts`'s probe branch is statically dead here exactly as it
          // is in a release bundle. Without it the bare identifier is a
          // ReferenceError the moment the ready continuation runs.
          __SIDEKICKS_SMOKE_BUILD__: "false",
          // `src/main/window-reveal.ts` reads both flags; substituted for the same
          // reason as the one above.
          __SIDEKICKS_CONSOLE_FIXTURES__: "false",
        },
        // `src/main/window.ts` imports `SessionIdSchema` from the contracts
        // `./session` subpath as a VALUE, so this project must resolve the
        // provider to TS source rather than a possibly-stale `dist/`. Node
        // environment → the SSR resolver is the one that decides, but both are
        // set for the same Vite-6 reason the renderer block below records.
        // Conditions replace vitest's defaults, so `import` / `default` are
        // re-listed.
        resolve: {
          conditions: ["@ai-sidekicks/source", "import", "default"],
        },
        ssr: {
          resolve: {
            conditions: ["@ai-sidekicks/source", "import", "default"],
          },
        },
        test: {
          name: "main-unit",
          environment: "node",
          // Disjoint from `test/*.test.ts` (the smoke project) and from
          // `src/renderer/**/__tests__/**` (the renderer project), so the
          // posture's no-double-discovery property still holds. `src/shared/**`
          // joins the set because that subtree is imported by BOTH processes
          // (see `src/shared/auxiliary-routes.ts`), and a shared module no test
          // project reaches would be a subtree with no home for its own units.
          include: ["src/main/**/*.test.ts", "src/shared/**/*.test.ts", "build/**/*.test.ts"],
        },
      },
      {
        // Resolve workspace *value* imports (e.g. `NotImplementedAtTier1Error`
        // from @ai-sidekicks/contracts in SessionBootstrap.test.tsx) to TS source,
        // not stale dist/, via the provider's `@ai-sidekicks/source` export
        // condition. happy-dom is Vite's *client* environment → the knob is
        // `resolve.conditions`; per vitest-dev/vitest#8431 (Vite 6 can wrongly apply
        // node conditions in happy-dom resolution passes) we set `ssr.resolve.*` too.
        // Conditions replace vitest's defaults, so `import`/`default` are re-listed.
        // (The node `main` smoke project imports contracts type-only → erased →
        // needs none. The `main-unit` project above DOES need them — see its
        // own block.)
        resolve: {
          conditions: WORKSPACE_SOURCE_CONDITIONS,
        },
        ssr: {
          resolve: {
            conditions: WORKSPACE_SOURCE_CONDITIONS,
          },
        },
        test: {
          name: "renderer",
          environment: "happy-dom",
          // Co-locate renderer unit tests under `src/renderer/**/__tests__/**`
          // to mirror the per-package convention used by `packages/contracts`
          // and `packages/client-sdk` (renderer is its own composite TS
          // project; its tests live inside that project's source tree).
          include: ["src/renderer/**/__tests__/**/*.test.{ts,tsx}"],
          // The console owns its own tier; a console or shell test never runs here.
          exclude: ["src/renderer/src/console/**", "src/renderer/src/shell/**"],
          // `globals: true` populates `vi`, `expect`, `describe`, `it`,
          // `afterEach` etc. on the global scope so the test file can rely
          // on `vitest/globals` types (configured in
          // `src/renderer/tsconfig.test.json` — kept separate from the
          // production renderer `tsconfig.json` so vitest globals never leak
          // into renderer production code's typegraph).
          globals: true,
        },
      },

      // --- Console test tiers (`Spec-023 §Console Test Tiers`) --------------

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
        test: {
          name: "console-screenshot",
          include: ["test/console/screenshot/**/*.test.{ts,tsx}"],
          globals: true,
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
    ],
  },
});
