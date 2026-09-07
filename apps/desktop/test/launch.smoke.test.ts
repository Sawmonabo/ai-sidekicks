// Plan-023 Phase 1 T-023p-1-7 — Vitest substrate-boots smoke test.
//
// Tier 1 unblock proof: programmatically spawns the built Electron bundle
// against `apps/desktop/src/main/index.ts`'s `SIDEKICKS_SMOKE_PROBE=1`
// branch and asserts the Spec-023 §Security Hardening Baseline runtime
// invariants:
//
//   1. The main window's renderer document loads within 5 seconds.
//   2. `window.sidekicks` is defined (the preload bridge from T-023p-1-4
//      actually registered on the renderer surface — i.e., the
//      `contextBridge.exposeInMainWorld` call ran).
//   3. `window.require` is `undefined` (the Spec-023 §Security Hardening
//      Baseline `nodeIntegration: false` + `sandbox: true` combination
//      successfully prevented any Node API leak into the renderer).
//   4. `window.process` is `undefined` — the second of the three Node-
//      API-leak globals named by `Spec-023 §Acceptance Criteria`.
//   5. `window.global` is `undefined` — the third Node-API-leak global
//      named by `Spec-023 §Acceptance Criteria`. With this third
//      assertion the Tier 1 smoke covers the full `Spec-023 §Acceptance Criteria` set
//      (`require` / `process` / `global`); the Tier 8 Playwright E2E
//      suite repeats the assertion across packaged-binary surfaces, but
//      the Tier 1 substrate is the load-bearing single-source-of-truth.
//
// Why Vitest, not Playwright:
//   Plan-023 §Implementation Steps step 18 + §Test And Verification Plan
//   defer the Playwright `_electron` E2E suite to Tier 8 remainder. Tier 1
//   ships only this single Vitest-driven smoke test as the substrate-boots
//   proof; the heavier `@playwright/test` dep is a Tier 8 lift.
//
// Mechanism — Option (ii) in the T-023p-1-7 dispatch contract:
//   The renderer is renderer-untrusted (Spec-023 §Trust Stance), so we do
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
//     (a) `apps/desktop/test/` holds two files that each spawn a full
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
// Module-system shape (verified empirically at T-023p-1-7):
//   • `out/main/index.js`     — ESM (matches package `"type": "module"`).
//                              Electron supports ESM main since v28, so
//                              the 44.x pin carries it.
//                              In SMOKE mode this bundle additionally
//                              includes the probe body (the
//                              `[SIDEKICKS_SMOKE_PROBE]` tag and the
//                              `webContents.executeJavaScript(...)` call;
//                              the `about:blank` load was RETIRED at
//                              Plan-023 T-023p-1B-2, the probe now running
//                              against the real bundle). In RELEASE
//                              mode both are physically absent —
//                              Vite's `define` substitutes the outer
//                              `__SIDEKICKS_SMOKE_BUILD__` flag with
//                              `false` and Rollup eliminates the branch
//                              as dead code. The Spec-023 §Security
//                              Hardening Baseline runtime invariants
//                              (sidekicks defined; require / process /
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
  DIAGNOSTIC_BUDGET_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  DIAGNOSTIC_PROBE_TIMEOUT_MS,
  diagnoseMissingProbe,
  DISPLAY_READY_TIMEOUT_MS,
  ELECTRON_BIN,
  ELECTRON_PACKAGE_ROOT,
  FORCED_DISPLAY_ENV,
  FORCED_DISPLAY_READY_TIMEOUT_MS,
  FORCED_STALL_ENV,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  MAIN_ENTRY,
  materializedElectronExecutable,
  PRELOAD_ENTRY,
  READINESS_BREADCRUMB_TAG,
  ReadinessLineScanner,
  renderReadinessFailure,
  reserveDeadDisplay,
  SMOKE_PROBE_TAG,
  SPAWN_TIMEOUT_MS,
  spawnElectron,
  WINDOW_BUDGET_MS,
  type SpawnResult,
} from "./helpers/electron-probe.js";
// The two bounds the spawner shares with every other Electron harness: the
// SIGTERM-to-SIGKILL grace, and the reserve that keeps a spawner's own deadline
// ahead of vitest's per-test budget.
import { TEST_TIMEOUT_SLACK_MS } from "./helpers/electron-child.js";
import { TERMINATION_GRACE_MS } from "./helpers/managed-electron-child.js";

// Doc references for this suite (Plan-023 Phase 1 T-023p-1-7,
// Spec-023 §Security Hardening Baseline / §Acceptance Criteria) are in the
// file header and the per-assertion comments below — never in the emitted
// test titles.
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

  // Asserts the Spec-023 §Security Hardening Baseline runtime invariants:
  // the preload bridge registered, and none of the three Node-API-leak
  // globals named by `Spec-023 §Acceptance Criteria` reached the renderer.
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
      // `sidekicks-renderer://` (Plan-023 Phase 1B) — i.e. the moment the
      // renderer is up, the preload has executed, and the served document has
      // finished loading. The retired `about:blank` arm measured only that a
      // window existed, so this budget now covers the handler and the bundle
      // as well.
      expect(probe.ok).toBe(true);
      expect(probe.windowMs).toBeLessThanOrEqual(WINDOW_BUDGET_MS);

      // Invariant 2: `window.sidekicks` is defined on the renderer.
      // Per the preload (`apps/desktop/src/preload/index.ts` line 32),
      // `contextBridge.exposeInMainWorld("sidekicks", createTier1Bridge())`
      // runs on every preload load. If `contextIsolation`, `sandbox`, or
      // the preload path is misconfigured, this would be `"undefined"`.
      expect(probe.probe.sidekicks).toBe("object");

      // Invariant 3: `window.require` is `undefined` — i.e., no Node API
      // leak into the renderer. `Spec-023 §Acceptance Criteria`:
      // "Renderer attempts to access `require`, `process`, or `global`
      // return `undefined` — verified by runtime assertion in a sandbox
      // test." If this drifts to `"function"`, `nodeIntegration: true`
      // has slipped past `assert-webprefs.ts`.
      expect(probe.probe.require).toBe("undefined");

      // Invariant 4: `window.process` is `undefined` — the second of the
      // three Node-API-leak globals named by `Spec-023 §Acceptance Criteria`
      // (require / process / global).
      expect(probe.probe.process).toBe("undefined");

      // Invariant 5: `window.global` is `undefined` — the third Node-API-
      // leak global named by `Spec-023 §Acceptance Criteria`. Tier 1
      // covers the full set of three at this single smoke layer; the Tier 8
      // Playwright `_electron` E2E suite repeats the assertion across the
      // packaged-binary surfaces (signed installer, asar bundle, autoupdate
      // applied snapshot) but the Tier 1 substrate is the load-bearing
      // single-source-of-truth that the runtime invariant holds.
      expect(probe.probe.global).toBe("undefined");

      // Invariant 6 (Plan-023 Phase 1B, I-023-11): the document came from the
      // privileged scheme at the `app` host. This is the assertion that
      // distinguishes "a window exists" from "the bundle is served" — the
      // whole reason the `about:blank` arm was retired.
      expect(probe.probe.protocol).toBe("sidekicks-renderer:");
      expect(probe.probe.host).toBe("app");

      // Invariant 7 (I-023-11): the origin carries storage. A scheme
      // registered WITHOUT `standard: true` still loads documents — it just
      // has an opaque origin, so `indexedDB` is absent and `localStorage`
      // throws. The console's persisted layout, scroll position, selection,
      // pins, and expansion sets live here — UI state ONLY, per
      // `Spec-023 §Console Design (Meridian)`; drafts are deliberately not in
      // that set and live in their window's memory for its lifetime — so a
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

  // The retirement, asserted rather than assumed (Plan-023 T-023p-1B-2).
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

// Unit coverage for the breadcrumb scanner's line buffering.
//
// This is the failure the buffer exists to stop: a breadcrumb straddling a
// chunk boundary was previously split into two fragments, NEITHER of which
// matched the tag, so the breadcrumb vanished. That is the worst possible
// outcome for a diagnostic trail — it goes missing precisely when the process
// is under enough load to fragment its own writes, which is the load that
// produces the stalls it is there to explain.
describe("ReadinessLineScanner", () => {
  const emit = (event: string, offsetMs: number): string =>
    `${READINESS_BREADCRUMB_TAG} ${event} +${String(offsetMs)}ms\n`;

  it("recovers a breadcrumb split across two chunks", () => {
    const line = emit("dom-ready", 133);
    // Split inside the TAG itself, which is the case a naive per-chunk
    // `split("\n")` cannot recover from at all.
    const splitAt = READINESS_BREADCRUMB_TAG.length - 3;
    const scanner = new ReadinessLineScanner();
    expect(scanner.push(line.slice(0, splitAt))).toEqual([]);
    expect(scanner.push(line.slice(splitAt))).toEqual(["dom-ready +133ms"]);
  });

  it("recovers a breadcrumb split at every possible boundary", () => {
    const line = emit("ready-to-show", 148);
    for (let splitAt = 0; splitAt <= line.length; splitAt += 1) {
      const scanner = new ReadinessLineScanner();
      const seen = [...scanner.push(line.slice(0, splitAt)), ...scanner.push(line.slice(splitAt))];
      expect(seen).toEqual(["ready-to-show +148ms"]);
    }
  });

  it("holds an unterminated line until its newline arrives", () => {
    const scanner = new ReadinessLineScanner();
    // No trailing newline: the breadcrumb is not complete and must NOT be
    // reported yet, or a truncated offset would be recorded as fact.
    expect(scanner.push(`${READINESS_BREADCRUMB_TAG} did-finish-load +12`)).toEqual([]);
    expect(scanner.push("34ms\n")).toEqual(["did-finish-load +1234ms"]);
  });

  it("reports several breadcrumbs arriving in one chunk, in order", () => {
    const scanner = new ReadinessLineScanner();
    expect(scanner.push(emit("dom-ready", 1) + emit("ready-to-show", 2))).toEqual([
      "dom-ready +1ms",
      "ready-to-show +2ms",
    ]);
  });

  it("ignores untagged output and never emits for it", () => {
    const scanner = new ReadinessLineScanner();
    expect(scanner.push("some unrelated stderr\nmore of it\n")).toEqual([]);
  });

  it("keeps two streams' partial lines apart", () => {
    // The reason each stream gets its own instance: a shared one would splice
    // stdout's tail onto stderr's head and synthesise a line neither emitted.
    const stdoutScanner = new ReadinessLineScanner();
    const stderrScanner = new ReadinessLineScanner();
    expect(stdoutScanner.push(`${READINESS_BREADCRUMB_TAG} dom-`)).toEqual([]);
    expect(stderrScanner.push(`${READINESS_BREADCRUMB_TAG} ready-to-show +2ms\n`)).toEqual([
      "ready-to-show +2ms",
    ]);
    expect(stdoutScanner.push("ready +1ms\n")).toEqual(["dom-ready +1ms"]);
  });
});

// The budget arithmetic, asserted rather than trusted to a comment.
//
// Every timing constant in this file is derived from another one so that
// raising a phase raises everything that must contain it. That property is
// only worth having if it is checked: the defect that produced this block was
// exactly a derivation that read plausibly and did not hold — the diagnostic
// collection was MEASURED from one instant and BOUNDED from a later one, so a
// collection whose probes each ran to their cap exceeded the budget it was
// asserted to honour, and the control meant to produce the dump failed instead.
// A comment cannot catch that returning; these can.
describe("derived timing budgets", () => {
  it("leaves the close-event reserve intact above the largest legal collection", () => {
    // The hole this closes, and the reason it is stated as "slack ON TOP of the
    // ceiling" rather than "contains the ceiling": the superseded derivation
    // (`spawn + DIAGNOSTIC_BUDGET_MS + grace + slack`) does contain the ceiling
    // — but only by spending the slack to do it, leaving nothing for the
    // unbounded terms that slack exists for (the spawn itself, the `close`
    // event after SIGTERM, temp-profile cleanup). A legal-but-slow collection
    // would then fail on the runner's generic test timeout, losing the dump in
    // precisely the case the dump exists for.
    //
    // Written in the weaker "contains the ceiling" form, this test would pass
    // against the very derivation it exists to reject — which is worth saying
    // out loud, because an arithmetic guard over constants in its own file is
    // worth its line count only if it fails on the state it replaced. This one
    // was run against that state and does.
    expect(BOOT_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      DISPLAY_READY_TIMEOUT_MS +
        SPAWN_TIMEOUT_MS +
        DIAGNOSTIC_COLLECTION_CEILING_MS +
        TERMINATION_GRACE_MS +
        TEST_TIMEOUT_SLACK_MS,
    );
    expect(FORCED_STALL_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      DISPLAY_READY_TIMEOUT_MS +
        FORCED_STALL_SPAWN_TIMEOUT_MS +
        DIAGNOSTIC_COLLECTION_CEILING_MS +
        TERMINATION_GRACE_MS +
        TEST_TIMEOUT_SLACK_MS,
    );
  });

  it("counts every bounded phase a spawn can spend, not only the ones after it starts", () => {
    // The display-readiness gate is the phase this guard was added for: it runs
    // inside `spawnElectron` BEFORE the spawn deadline timer is armed, so it is
    // invisible to the spawn budget and was for a while invisible to both
    // enclosures too. Every separately-bounded phase belongs in the enclosure
    // of any test that can reach it, and the negative control's own budget
    // already names its (overridden) display term, which is what made the
    // omission in the other two legible.
    for (const enclosure of [BOOT_TEST_TIMEOUT_MS, FORCED_STALL_TEST_TIMEOUT_MS]) {
      expect(enclosure).toBeGreaterThan(
        DISPLAY_READY_TIMEOUT_MS + DIAGNOSTIC_COLLECTION_CEILING_MS,
      );
    }
  });

  it("keeps the shared wall budget binding rather than decorative", () => {
    // The collection's worst case is `min(wall budget, sum of the per-probe
    // caps)`. If the wall exceeded that sum it could never bind, and the
    // collection's worst case would once again be a sum of independent
    // timeouts — the shape that started this. There are two probes.
    const boundedProbeCount = 2;
    expect(DIAGNOSTIC_BUDGET_MS).toBeLessThanOrEqual(
      DIAGNOSTIC_PROBE_TIMEOUT_MS * boundedProbeCount,
    );
  });

  it("keeps the collection ceiling tight enough to catch the shape it replaced", () => {
    // The superseded collection carried two independent 5 s `spawnSync`
    // timeouts. The ceiling must stay below that sum, or the assertion stops
    // being a regression guard and becomes a formality.
    const supersededIndependentProbeTimeoutMs = 5_000;
    expect(DIAGNOSTIC_COLLECTION_CEILING_MS).toBeLessThan(supersededIndependentProbeTimeoutMs * 2);
    // And loose enough to hold the budget plus a real reserve, so the control
    // is not itself a wall-clock flake.
    expect(DIAGNOSTIC_COLLECTION_CEILING_MS).toBeGreaterThan(DIAGNOSTIC_BUDGET_MS);
  });
});

// `diagnoseMissingProbe` turns "no probe line arrived" into a named cause, and
// it is the one part of the harness a real spawn cannot exercise: reaching an
// arm needs a boot that failed in that specific way, and a green run reaches
// none of them. These cases drive it directly over synthetic output.
//
// The ORDER of the arms is the substance, not decoration. Several failure
// shapes leave overlapping evidence — a timed-out process with a
// `did-finish-load` breadcrumb matches both the round-trip arm and the generic
// deadline arm — so each ordering-sensitive pair below is asserted with the
// evidence of BOTH arms present, which is the only arrangement that can catch a
// reordering.
describe("diagnoseMissingProbe", () => {
  /** A spawn that produced no probe line, with only the evidence a case names. */
  function failedSpawn(overrides: Partial<SpawnResult> = {}): SpawnResult {
    return {
      probe: null,
      stdout: "",
      stderr: "",
      combinedOutput: "",
      exitCode: 0,
      signal: null,
      elapsedMs: 1_234,
      readinessBreadcrumbs: [],
      diagnostics: [],
      spawnBudgetMs: SPAWN_TIMEOUT_MS,
      timedOut: false,
      diagnosticCollectionMs: null,
      childDisplay: undefined,
      ...overrides,
    };
  }

  it.each([
    [
      "a display that never answered",
      { combinedOutput: "…did not answer within 10000ms" },
      "X display",
    ],
    [
      "a lost single-instance lock",
      { combinedOutput: "SingletonLock: File exists" },
      "single-instance lock",
    ],
    [
      "a bundle that never loaded over the renderer scheme",
      { combinedOutput: "failed to load sidekicks-renderer://app/index.html: ERR_FAILED" },
      "never loaded over the renderer",
    ],
    [
      "a probe expression that never evaluated",
      { combinedOutput: `${SMOKE_PROBE_TAG} executeJavaScript failed: boom` },
      "never evaluated in it",
    ],
    [
      "a main-process index fetch that failed",
      { combinedOutput: `${SMOKE_PROBE_TAG} index fetch failed: 404` },
      "fetch `sidekicks-renderer://app/index.html` back",
    ],
    [
      "a startup that rejected",
      { exitCode: 1, combinedOutput: "Error: boom" },
      "`app.whenReady()` rejected",
    ],
    ["a silent exit 0", { exitCode: 0, combinedOutput: "   \n" }, "printed nothing at all"],
    [
      "output that matches no marker",
      { exitCode: 3, combinedOutput: "some unrelated chatter" },
      "without a recognised failure marker",
    ],
  ] as const)("names %s", (_label, overrides, expectedFragment) => {
    expect(diagnoseMissingProbe(failedSpawn(overrides))).toContain(expectedFragment);
  });

  it("reports a hung round trip when did-finish-load fired and the deadline passed", () => {
    const diagnosis = diagnoseMissingProbe(
      failedSpawn({
        timedOut: true,
        signal: "SIGTERM",
        readinessBreadcrumbs: ["dom-ready +120ms", "did-finish-load +300ms"],
      }),
    );

    expect(diagnosis).toContain("hung probe");
    // The negative control for the ordering: the generic deadline arm would
    // report the opposite of what happened.
    expect(diagnosis).not.toContain("`did-finish-load` never fired");
  });

  // Both arms' evidence is present at once — a completed load AND a failed
  // main-process readback — which is exactly the shape that made the ordering
  // load-bearing. The specific arm must win.
  it("prefers the index-fetch arm over the hung-round-trip arm", () => {
    const diagnosis = diagnoseMissingProbe(
      failedSpawn({
        combinedOutput: `${SMOKE_PROBE_TAG} index fetch failed: 404`,
        timedOut: true,
        readinessBreadcrumbs: ["dom-ready +120ms", "did-finish-load +300ms"],
      }),
    );

    expect(diagnosis).toContain("could not fetch");
    expect(diagnosis).not.toContain("hung probe");
  });

  // The other direction of the same overlap: a bundle that never loaded also
  // times out, and the marker is the more specific reading.
  it("prefers the renderer-scheme arm over the deadline arm", () => {
    const diagnosis = diagnoseMissingProbe(
      failedSpawn({
        combinedOutput: "failed to load sidekicks-renderer://app/index.html: ERR_FAILED",
        timedOut: true,
        signal: "SIGTERM",
      }),
    );

    expect(diagnosis).toContain("never loaded over the renderer");
    expect(diagnosis).not.toContain("deadline");
  });

  describe("the generic deadline arm", () => {
    it("says no readiness event fired when there are no breadcrumbs", () => {
      const diagnosis = diagnoseMissingProbe(failedSpawn({ timedOut: true, signal: "SIGTERM" }));

      expect(diagnosis).toContain("`did-finish-load` never fired");
      expect(diagnosis).toContain("No readiness event fired at all");
      expect(diagnosis).toContain("terminated (SIGTERM)");
    });

    it("lists the breadcrumbs that did fire", () => {
      const diagnosis = diagnoseMissingProbe(
        failedSpawn({
          timedOut: true,
          signal: "SIGTERM",
          readinessBreadcrumbs: ["dom-ready +120ms"],
        }),
      );

      expect(diagnosis).toContain("Readiness reached: dom-ready +120ms.");
    });

    // The shim disposition. A `signal !== null` test would have handed this to
    // the `exitCode === 1` arm and reported a startup failure that never
    // happened — see `SpawnResult.timedOut`.
    it("reads a shim-forwarded SIGTERM as a deadline kill, not a startup failure", () => {
      const diagnosis = diagnoseMissingProbe(
        failedSpawn({ timedOut: true, signal: null, exitCode: 1 }),
      );

      expect(diagnosis).toContain("the electron shim forwarded it and exited 1");
      expect(diagnosis).not.toContain("`app.whenReady()` rejected");
    });
  });
});
