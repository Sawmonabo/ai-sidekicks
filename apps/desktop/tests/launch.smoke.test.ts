// Vitest substrate-boots smoke test.
//
// Programmatically spawns the built Electron bundle against
// `apps/desktop/src/main/index.ts`'s `SIDEKICKS_SMOKE_PROBE=1` branch and
// asserts the security-hardening runtime invariants:
//
//   1. The main window's renderer document loads within 5 seconds.
//   2. `window.desktopBridge` is defined (the preload bridge actually registered
//      on the renderer surface — i.e., the `contextBridge.exposeInMainWorld`
//      call ran).
//   3. `window.require` is `undefined` (the `nodeIntegration: false` +
//      `sandbox: true` combination successfully prevented any Node API leak
//      into the renderer).
//   4. `window.process` is `undefined` — the second Node-API-leak global.
//   5. `window.global` is `undefined` — the third. With this third assertion
//      the smoke covers the full set (`require` / `process` / `global`); a
//      later Playwright E2E suite repeats the assertion across
//      packaged-binary surfaces, but this substrate is the load-bearing
//      single source of truth.
//
// Why Vitest, not Playwright:
//   The Playwright `_electron` E2E suite is deferred. This ships as the one
//   Vitest-driven smoke test that proves the substrate boots; the heavier
//   `@playwright/test` dependency is a later lift.
//
// Mechanism:
//   The renderer is untrusted, so we do
//   NOT add a probe to the renderer source. Instead, the main entrypoint
//   has a smoke-mode branch gated on `SIDEKICKS_SMOKE_PROBE=1` that calls
//   `webContents.executeJavaScript(...)` from the trusted main process,
//   prints a single-line tagged JSON payload to stdout, and exits. This
//   test parses that line.
//
// Linux display handling:
//   GitHub Actions `ubuntu-latest` has no display server. CI stands up ONE
//   Xvfb for the whole job and exports `$DISPLAY` only after `xdpyinfo`
//   confirms the server is answering (see `.github/workflows/ci.yml`), so this
//   harness spawns Electron directly there and verifies the same readiness
//   condition itself before spawning. A Linux contributor with no `$DISPLAY`
//   still gets the original `xvfb-run -a` fallback; macOS and Windows spawn
//   directly as before.
//
// Boot determinism (why the readiness gate and the diagnostic dump exist):
//   This suite intermittently failed with a bare "did-finish-load never fired"
//   at the spawn deadline and an EMPTY stderr — nothing to diagnose from. Two
//   defects produced that:
//
//     (a) `apps/desktop/tests/` holds two files that each spawn a full
//         Electron/Chromium tree, and vitest's default `fileParallelism` ran
//         them concurrently on a 4-vCPU runner while `lifecycle.gc.test.ts`
//         drove 80 forced full GCs. Fixed at the scheduler in
//         `apps/desktop/vitest.config.ts`, not by widening this budget.
//     (b) the harness captured nothing about the environment, and its
//         stderr-keyed diagnosis arms were unreachable under `xvfb-run`'s
//         stderr-into-stdout merge. Fixed by `SpawnResult.combinedOutput`,
//         the readiness breadcrumbs, and `renderDiagnosticDump`.
//
// Profile isolation:
//   Every spawn gets a private Chromium profile via `--user-data-dir`.
//   Electron's DEFAULT profile carries a machine-wide `SingletonLock`, so any
//   concurrent default-profile Electron — a second checkout running this same
//   suite, a developer's unrelated Electron app, an orphan from an earlier
//   terminated run — would make this spawn lose
//   `app.requestSingleInstanceLock()` and quit before booting a window,
//   emitting no probe line and exiting 0. That was this test's historical
//   flake; see `spawnElectron()` for the mechanism and its reproduction.
//
// Build precondition:
//   This test runs against the SMOKE bundle (`electron-vite build
//   --mode=smoke`), NOT the release bundle (`electron-vite build`). The
//   release bundle tree-shakes the smoke-probe branch out of
//   `out/main/index.js` entirely (the production-safety guarantee — see
//   `apps/desktop/src/main/index.ts` header and `electron.vite.config.ts`
//   `define` block); attempting to run this test against a release bundle
//   would hang waiting for a probe line that physically does not exist in
//   the binary.
//
//   `apps/desktop/package.json`'s `test` script self-orchestrates the
//   smoke build: it runs `pnpm run build:smoke` before invoking vitest,
//   so a developer running `pnpm --filter @ai-sidekicks/desktop test`
//   does not need a separate build step. The existsSync fail-fast
//   diagnostics below suggest `pnpm test` (which rebuilds the smoke
//   bundle) instead of `pnpm build` (which would produce a probe-less
//   release bundle that this test cannot use).
//
// Module-system shape (verified empirically):
//   • `out/main/index.js`     — ESM (matches package `"type": "module"`).
//                              Electron supports ESM main since v28, so
//                              the 44.x pin carries it.
//                              In SMOKE mode this bundle additionally
//                              includes the probe body (the
//                              `[SIDEKICKS_SMOKE_PROBE]` tag and the
//                              `webContents.executeJavaScript(...)` call;
//                              the `about:blank` load was RETIRED, the
//                              probe now running against the real
//                              bundle). In RELEASE
//                              mode both are physically absent —
//                              Vite's `define` substitutes the outer
//                              `__SIDEKICKS_SMOKE_BUILD__` flag with
//                              `false` and Rollup eliminates the branch
//                              as dead code. The security-hardening
//                              runtime invariants
//                              (desktopBridge defined; require / process /
//                              global all undefined) hold identically in
//                              both modes — the smoke probe just adds
//                              the readout machinery on top of the same
//                              trust-boundary surface, and the document it
//                              reads is the same one a release build loads.
//   • `out/preload/index.cjs` — CommonJS (sandboxed preload constraint).
//                              The explicit `.cjs` extension overrides the
//                              package `"type": "module"` so Node loads the
//                              file as CJS. Verified empirically: an ESM
//                              preload fails to register with `"SyntaxError:
//                              Cannot use import statement outside a module"`
//                              on Electron 41.6.1, unchanged on 44.x.
//   See `apps/desktop/electron.vite.config.ts` header for the decision log.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BOOT_TEST_TIMEOUT_MS,
  ELECTRON_BIN,
  ELECTRON_PACKAGE_ROOT,
  FORCED_STALL_ENV,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  MAIN_ENTRY,
  materializedElectronExecutable,
  PRELOAD_ENTRY,
  spawnElectron,
  WINDOW_BUDGET_MS,
  type SpawnResult,
} from "./helpers/smoke-probe-harness.js";
import {
  DIAGNOSTIC_BUDGET_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  renderReadinessFailure,
  SMOKE_PROBE_TAG,
} from "./helpers/smoke-probe-diagnosis.js";
import {
  FORCED_DISPLAY_ENV,
  FORCED_DISPLAY_READY_TIMEOUT_MS,
  reserveDeadDisplay,
} from "./helpers/display-readiness.js";
// The reserve that keeps a spawner's own deadline ahead of vitest's per-test budget,
// shared with every other Electron harness.
import { TEST_TIMEOUT_SLACK_MS } from "./helpers/electron-child.js";

describe("desktop shell substrate boot", () => {
  it("verifies built bundle exists before spawning Electron", () => {
    // Fail-fast diagnostic. If the test runs without the smoke bundle
    // present, the Electron spawn would fail with a cryptic "cannot
    // find module" — this assertion produces a clear message pointing
    // to the smoke-build step instead. Diagnostics suggest `pnpm test`
    // (which orchestrates `build:smoke` before vitest) rather than
    // `pnpm build` (which produces a release bundle whose probe branch
    // is tree-shaken — this test cannot run against it).
    expect(
      existsSync(MAIN_ENTRY),
      `Main entry missing at ${MAIN_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);
    expect(
      existsSync(PRELOAD_ENTRY),
      `Preload entry missing at ${PRELOAD_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);
    expect(
      existsSync(ELECTRON_BIN),
      `Electron launcher missing at ${ELECTRON_BIN}. Run \`pnpm install\` first.`,
    ).toBe(true);
    // The launcher shim exists after any install; the BINARY does not. Refusing
    // here names the remedy, where letting the spawn proceed would download
    // 120-160 MB inside the spawn deadline and report a timeout.
    expect(
      materializedElectronExecutable(),
      `Electron binary not materialized; run \`pnpm install\` (its ` +
        `\`postinstall\` runs apps/desktop/scripts/materialize-electron.ts). ` +
        `Electron 44 publishes no install script, so an install that skipped ` +
        `that step leaves ${ELECTRON_PACKAGE_ROOT}/dist absent and the first ` +
        `spawn would download the binary inside this test's timeout.`,
    ).not.toBeNull();
  });

  // Asserts the security-hardening runtime invariants: the preload bridge
  // registered, and none of the three Node-API-leak globals reached the
  // renderer.
  it(
    "renderer exposes the preload bridge and leaks no Node globals",
    async () => {
      const result = await spawnElectron();

      // Surface the full diagnostic dump if the probe line never arrived, so a
      // failure here is attributable from one read of the CI log without a
      // re-run. The dump carries the readiness events that DID fire with their
      // offsets, the environment readings taken at spawn and at the deadline
      // (display liveness, CPU count, load average, and the process tree of
      // this spawn's own group), and both raw streams.
      if (!result.probe) {
        throw new Error(renderReadinessFailure(result));
      }

      const probe = result.probe;

      // Invariant 1: main window appears within 5 seconds.
      // The `windowMs` measurement is from `app.whenReady()` to
      // `webContents.did-finish-load` on the REAL renderer bundle served over
      // `sidekicks-renderer://` — i.e. the moment the
      // renderer is up, the preload has executed, and the served document has
      // finished loading. The retired `about:blank` arm measured only that a
      // window existed, so this budget now covers the handler and the bundle
      // as well.
      expect(probe.ok).toBe(true);
      expect(probe.windowMs).toBeLessThanOrEqual(WINDOW_BUDGET_MS);

      // Invariant 2: `window.desktopBridge` is defined on the renderer.
      // The preload (`apps/desktop/src/preload/index.ts`) runs
      // `contextBridge.exposeInMainWorld("desktopBridge", preloadApi)`
      // on every preload load. If `contextIsolation`, `sandbox`, or
      // the preload path is misconfigured, this would be `"undefined"`.
      expect(probe.probe.desktopBridge).toBe("object");

      // Invariant 3: `window.require` is `undefined` — i.e., no Node API
      // leak into the renderer. A renderer attempt to reach `require`,
      // `process`, or `global` returns `undefined`. If this drifts to
      // `"function"`, `nodeIntegration: true` has slipped past
      // `assert-webprefs.ts`.
      expect(probe.probe.require).toBe("undefined");

      // Invariant 4: `window.process` is `undefined` — the second of the
      // three Node-API-leak globals (require / process / global).
      expect(probe.probe.process).toBe("undefined");

      // Invariant 5: `window.global` is `undefined` — the third Node-API-
      // leak global. This smoke layer covers the full set of three; a later
      // Playwright `_electron` E2E suite repeats the assertion across the
      // packaged-binary surfaces (signed installer, asar bundle, autoupdate
      // applied snapshot), but this substrate is the load-bearing single
      // source of truth that the runtime invariant holds.
      expect(probe.probe.global).toBe("undefined");

      // Invariant 6: the document came from the privileged scheme at the
      // `app` host. This is the assertion that
      // distinguishes "a window exists" from "the bundle is served" — the
      // whole reason the `about:blank` arm was retired.
      expect(probe.probe.protocol).toBe("sidekicks-renderer:");
      expect(probe.probe.host).toBe("app");

      // Invariant 7: the origin carries storage. A scheme
      // registered WITHOUT `standard: true` still loads documents — it just
      // has an opaque origin, so `indexedDB` is absent and `localStorage`
      // throws. The console's persisted layout, scroll position, selection,
      // pins, and expansion sets live here — UI state ONLY; drafts are
      // deliberately not in that set and live in their window's memory for its lifetime — so a
      // silent regression to a non-standard scheme would surface as data that
      // never survives a restart rather than as an error.
      expect(probe.probe.indexedDB).toBe("object");
      expect(probe.probe.localStorageRoundTrip).toBe(true);

      // Invariant 8: the React tree actually mounted inside the served
      // document. `did-finish-load` fires on the document, not on the app, so
      // without this a bundle whose entry chunk 404'd would still pass every
      // assertion above.
      expect(probe.probe.rootChildren).toBeGreaterThan(0);

      // Invariant 9: the CSP header rides the response. The header is the
      // policy's ONLY carrier — `index.html` deliberately ships no meta tag —
      // so nothing else in the suite would notice it silently disappearing.
      // Read from the main process through `net.fetch` against the handler's
      // own output, not from the renderer, because a renderer cannot read its
      // own response headers.
      expect(probe.contentSecurityPolicy).not.toBeNull();
      const contentSecurityPolicy = probe.contentSecurityPolicy ?? "";
      for (const directive of [
        "default-src 'self'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ]) {
        expect(contentSecurityPolicy).toContain(directive);
      }
      // Nothing in the policy may admit remote script or a wildcard origin;
      // asserting the presence of each directive above would not catch a
      // widened one appended beside it.
      expect(contentSecurityPolicy).not.toContain("unsafe-eval");
      expect(contentSecurityPolicy).not.toContain("*");
      expect(contentSecurityPolicy).not.toContain("http://");

      // Process should have exited cleanly via `app.exit(0)` from the
      // probe branch. Signal-killed (timeout) or non-zero exit means
      // the substrate did not boot as expected.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    // Derived, not hand-picked: spawn budget + bounded diagnostics + termination
    // grace + slack. See BOOT_TEST_TIMEOUT_MS.
    BOOT_TEST_TIMEOUT_MS,
  );

  // Negative control for the readiness path.
  //
  // The diagnostics added here are only worth having if they actually fire, and
  // "the dump would have printed" is not something the passing path can show —
  // on a healthy boot none of this code runs. So this test breaks the readiness
  // precondition deterministically (a display number nothing serves) and
  // asserts the harness produces a NAMED refusal carrying the dump, rather than
  // the bare spawn-budget timeout that run 33571210321 produced.
  //
  // It drives the real `spawnElectron()` and the real `renderReadinessFailure()`
  // — not a hand-built `SpawnResult` — so a regression that silently stopped
  // collecting diagnostics would fail here.
  //
  // The positive control is the test above: same harness, same renderer, live
  // display, and it reaches a probe line. Without that pairing this assertion
  // could pass against a harness that refused every spawn.
  it(
    "refuses a dead display with a diagnostic dump rather than a bare timeout",
    async () => {
      const deadDisplay = reserveDeadDisplay();
      process.env[FORCED_DISPLAY_ENV] = deadDisplay;
      let failureMessage: string;
      let result: SpawnResult;
      try {
        result = await spawnElectron();
        expect(result.probe).toBeNull();
        failureMessage = renderReadinessFailure(result);
      } finally {
        delete process.env[FORCED_DISPLAY_ENV];
      }

      // The child would have been pinned to the reserved display, not the
      // ambient one. Asserted because this is what makes the control sound if
      // the gate ever regresses: without the pin a spawn that should have been
      // refused would open on the developer's real display and pass.
      expect(result.childDisplay).toBe(deadDisplay);

      // Classified, not the catch-all arm — the reader is told which
      // precondition failed.
      expect(failureMessage).toContain("was not serving");
      expect(failureMessage).not.toContain("without a recognised failure marker");

      // The dump itself, with the offending display named in it.
      expect(failureMessage).toContain("--- readiness events observed ---");
      expect(failureMessage).toContain("--- environment ---");
      expect(failureMessage).toContain(deadDisplay);
      expect(failureMessage).toContain(`DISPLAY=${deadDisplay}`);

      // No readiness event can have fired, because the spawn was refused
      // before Electron existed — and the dump says exactly that instead of
      // leaving the section blank.
      expect(failureMessage).toContain("<none — the renderer never reached");
    },
    // Derived like the others: the forced readiness budget, the diagnostic
    // bound, and slack. No termination grace — this path refuses before a
    // process exists, so there is no tree to signal. The diagnostic term is the
    // BUDGET rather than the ceiling, and is conservative even so: the refusal
    // capture is handed a `null` probe deadline, so it takes the cheap readings
    // only and spends no subprocess at all.
    FORCED_DISPLAY_READY_TIMEOUT_MS + DIAGNOSTIC_BUDGET_MS + TEST_TIMEOUT_SLACK_MS,
  );

  // Negative control for the DEADLINE path's own budget.
  //
  // The control above breaks a precondition and never spawns Electron, so it
  // exercises none of the machinery that runs when a boot actually stalls: the
  // spawn deadline, the at-deadline diagnostic collection with its two real
  // subprocess readings, the process-group SIGTERM, and the grace period before
  // SIGKILL. That path has a budget of its own, and it used to be unpayable —
  // two 5 s probe timeouts plus a 2 s grace inside an enclosing budget that
  // allowed 5 s past the spawn deadline. The degraded runner these diagnostics
  // exist for was therefore the one case where they could not be printed:
  // vitest's generic timeout would fire first and the dump would be lost.
  //
  // So this test forces a REAL stall — the app boots with the probe opt-in
  // withheld, so it runs normally and simply never emits a probe line — and
  // asserts two things that together are the fix:
  //
  //   1. the failure that comes back is the harness's readiness failure with
  //      its dump, NOT vitest's generic timeout, and
  //   2. the whole path fits inside a budget DERIVED from the same named
  //      constants the production path uses.
  //
  // It is a live control, not a tautology: restore either probe's independent
  // 5 s timeout and the elapsed time exceeds this test's own derived budget, so
  // vitest kills it and the assertions below never run.
  it(
    "bounds the stalled-boot diagnostic path inside its derived budget",
    async () => {
      process.env[FORCED_STALL_ENV] = "1";
      const startedAt = Date.now();
      let failureMessage: string;
      let result: SpawnResult;
      try {
        result = await spawnElectron();
        expect(result.probe).toBeNull();
        failureMessage = renderReadinessFailure(result);
      } finally {
        delete process.env[FORCED_STALL_ENV];
      }
      const elapsedMs = Date.now() - startedAt;

      // The spawn really did reach THIS harness's deadline — otherwise the test
      // would be asserting about some other failure shape. Asserted on the
      // recorded flag rather than on `signal`, for the reason `timedOut`
      // documents: the shim exits with a code here, not a signal.
      expect(result.timedOut).toBe(true);

      // THE structural claim, asserted against a measurement of itself: the
      // collection honoured its own bound.
      //
      // Deliberately not asserted as "total elapsed < deadline + budget +
      // grace". That form is arithmetically equivalent only if teardown is
      // free, and it is not — on CI the SIGTERM-to-`close` leg is the dominant
      // term (~2 s) and is bounded by nothing this file owns. Asserting on it
      // would make a de-flaking change carry a fresh wall-clock flake, which
      // would be a poor joke. The recorded figure has no such term in it.
      //
      // Asserted against the budget PLUS the explicit overhead reserve, because
      // the budget is what the probes are handed and the measurement also
      // contains the `spawnSync` kill-and-reap tail that expiring that budget
      // costs. See DIAGNOSTIC_COLLECTION_CEILING_MS for why the reserve is the
      // same one the close-event bound uses, and why 6 s still catches the
      // superseded two-independent-5 s-probes shape it exists to catch.
      expect(result.diagnosticCollectionMs).not.toBeNull();
      expect(result.diagnosticCollectionMs).toBeLessThanOrEqual(DIAGNOSTIC_COLLECTION_CEILING_MS);

      // Backstop only, deliberately loose: the whole path still finished inside
      // the derived enclosing budget. This one is not the control — it is the
      // assertion that would catch a regression the recorded figure cannot see,
      // e.g. a termination path that stopped terminating.
      expect(elapsedMs).toBeLessThan(FORCED_STALL_TEST_TIMEOUT_MS);

      // The readiness failure, not a bare timeout: classified, and carrying the
      // dump with the at-deadline readings in it.
      expect(failureMessage).toContain("Desktop shell never became ready");
      expect(failureMessage).toContain(
        `still running at the ${String(FORCED_STALL_SPAWN_TIMEOUT_MS)}ms deadline`,
      );
      expect(failureMessage).not.toContain("without a recognised failure marker");
      expect(failureMessage).toContain("--- environment ---");

      // The at-deadline capture ran and its readings are present — the point of
      // bounding it was to keep these, not merely to finish sooner.
      expect(failureMessage).toContain("[at-deadline]");
      if (process.platform !== "win32") {
        expect(failureMessage).toContain("[at-deadline] process tree");
      }

      // A skipped reading is a DESIGNED outcome of the shared budget, not a
      // failure: the whole reason the two probes share one wall bound is that a
      // slow first reading should cost the second reading rather than the
      // enclosing test. Forbidding the skip outright — which this assertion
      // used to do — turns the degraded runner these readings exist for into a
      // red test, which is the opposite of the intent.
      //
      // So the skip is not prohibited; it is required to be EARNED and
      // RECORDED. A reading is only skipped once `remainingProbeBudgetMs()`
      // reaches zero, which happens only at or after `collectionStartedAt +
      // DIAGNOSTIC_BUDGET_MS` — so a dump carrying the skip marker must also
      // carry a collection cost of at least the full budget. That implication
      // is exact, and it still catches the regression the old form was reaching
      // for: a bound tightened until readings are dropped on a healthy runner
      // would skip with a near-zero recorded cost and fail here.
      if (failureMessage.includes("diagnostic budget exhausted")) {
        expect(result.diagnosticCollectionMs).toBeGreaterThanOrEqual(DIAGNOSTIC_BUDGET_MS);
      }

      // The recorded cost is in the dump too, so a slow collection is legible
      // to a human reading CI output rather than only to this assertion.
      expect(failureMessage).toContain("[at-deadline] collection took");
    },
    FORCED_STALL_TEST_TIMEOUT_MS,
  );

  // The retirement, asserted rather than assumed.
  //
  // The smoke bundle is the one build where the probe body SURVIVES — a
  // release bundle tree-shakes the whole branch, so grepping it for
  // `about:blank` would pass no matter what the source said. Checking the
  // smoke bundle is therefore the only form of this assertion with any force:
  // if anyone re-introduces a blank-document load behind the probe gate, the
  // suite's other assertions would go on passing (a blank document has a
  // `#root`-less DOM, so they would actually FAIL — but for a reason nobody
  // would read as "the retirement was reverted"). This says it directly.
  it("ships no blank-document load in the built smoke bundle", () => {
    expect(
      existsSync(MAIN_ENTRY),
      `Main entry missing at ${MAIN_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);

    const builtMainBundle = readFileSync(MAIN_ENTRY, "utf8");

    expect(builtMainBundle).not.toContain("about:blank");
    // Positive control: the probe body IS present in this bundle, so the
    // absence above is a real absence and not a mis-pointed path or a release
    // bundle that tree-shook everything.
    expect(builtMainBundle).toContain(SMOKE_PROBE_TAG);
    expect(builtMainBundle).toContain("sidekicks-renderer://app/index.html");
  });
});
