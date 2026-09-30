// Smoke test: boots the built Electron smoke bundle and asserts the runtime security invariants.
// The main entry's smoke branch (gated on `SIDEKICKS_SMOKE_PROBE=1`) runs `executeJavaScript` from
// the trusted main process, prints one tagged JSON line and exits, and this test parses that
// line, so no probe lives in the untrusted renderer.
//
// It runs against the smoke bundle (`electron-vite build --mode=smoke`, a dependency of
// `test:smoke`), never the release bundle, which tree-shakes the probe branch out. Every spawn
// gets a private profile via `--user-data-dir`: a concurrent default-profile Electron would hold
// the `SingletonLock`, and this spawn would quit before a window and exit 0 without a probe line
// (see `spawnElectron()`). `vitest.config.ts` runs the two Electron-spawning files serially.
// CI exports `$DISPLAY` once one job-level Xvfb signals ready on `-displayfd` (see
// `.github/workflows/ci.yml`); a Linux contributor without one falls back to `xvfb-run -a`.
//
// `out/main/index.js` is ESM (Electron supports an ESM main since v28) and
// `out/preload/index.cjs` is CommonJS because a sandboxed preload cannot be ESM; the decision log
// is the header of `electron.vite.config.ts`.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SMOKE_PROBE_TAG } from "@shared/probe-tags.js";

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
} from "./helpers/smoke-probe-diagnosis.js";
import {
  FORCED_DISPLAY_ENV,
  FORCED_DISPLAY_READY_TIMEOUT_MS,
  reserveDeadDisplay,
} from "./helpers/display-readiness.js";
// The reserve that keeps a spawner's own deadline ahead of vitest's per-test budget,
// shared with every other Electron harness.
import { TEST_TIMEOUT_SLACK_MS } from "./helpers/electron-child.js";

describe("desktop main process boot", () => {
  it("verifies built bundle exists before spawning Electron", () => {
    // Fail fast with a clear message: without the smoke bundle the spawn would fail with a cryptic
    // "cannot find module". A release bundle will not do, since its probe branch is tree-shaken.
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
    // The launcher shim exists after any install; the binary may not. Refuse here to name the
    // remedy, instead of downloading 120-160 MB inside the spawn deadline and reporting a timeout.
    expect(
      materializedElectronExecutable(),
      `Electron binary not materialized; run \`pnpm install\` (its ` +
        `\`postinstall\` runs apps/desktop/scripts/materialize-electron.ts). ` +
        `Electron 44 publishes no install script, so an install that skipped ` +
        `that step leaves ${ELECTRON_PACKAGE_ROOT}/dist absent and the first ` +
        `spawn would download the binary inside this test's timeout.`,
    ).not.toBeNull();
  });

  // Asserts the preload bridge registered and no Node global reached the renderer.
  it(
    "renderer exposes the preload bridge and leaks no Node globals",
    async () => {
      const result = await spawnElectron();

      // Surface the full dump when no probe line arrived, so a failure is attributable from one
      // read of the CI log: the readiness events that fired, the environment readings, and both
      // raw streams.
      if (!result.probe) {
        throw new Error(renderReadinessFailure(result));
      }

      const probe = result.probe;

      // Invariant 1: `windowMs` runs from `app.whenReady()` to `did-finish-load` on the real
      // bundle served over `sidekicks-renderer://`, so the budget covers the handler and the
      // bundle.
      expect(probe.ok).toBe(true);
      expect(probe.windowMs).toBeLessThanOrEqual(WINDOW_BUDGET_MS);

      // Invariant 2: the preload exposed `desktopBridge` in the main world. A misconfigured
      // `contextIsolation`, `sandbox` or preload path would read `"undefined"`.
      expect(probe.probe.desktopBridge).toBe("object");

      // Invariant 3: no Node API leak. `"function"` here means `nodeIntegration: true` slipped
      // past `assert-webprefs.ts`.
      expect(probe.probe.require).toBe("undefined");

      // Invariant 4: `window.process` is `undefined`.
      expect(probe.probe.process).toBe("undefined");

      // Invariant 5: `window.global` is `undefined`, the third Node-API-leak global.
      expect(probe.probe.global).toBe("undefined");

      // Invariant 6: the document came from the privileged scheme at the `app` host, which
      // separates "a window exists" from "the bundle is served".
      expect(probe.probe.protocol).toBe("sidekicks-renderer:");
      expect(probe.probe.host).toBe("app");

      // Invariant 7: the origin carries storage. A scheme registered without `standard: true`
      // still loads documents but has an opaque origin: `indexedDB` is absent and `localStorage`
      // throws. The persisted UI state (layout, scroll, selection, pins) lives there, so a
      // regression would show as data that never survives a restart.
      expect(probe.probe.indexedDB).toBe("object");
      expect(probe.probe.localStorageRoundTrip).toBe(true);

      // Invariant 8: the React tree mounted. `did-finish-load` fires on the document, so a bundle
      // whose entry chunk 404'd would pass every assertion above.
      expect(probe.probe.rootChildren).toBeGreaterThan(0);

      // Invariant 9: the CSP header rides the response. It is the policy's only carrier
      // (`index.html` ships no meta tag), so nothing else would notice it disappearing. It is read
      // from the main process via `net.fetch`, since a renderer cannot read its own response
      // headers.
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
      // Nothing may admit remote script or a wildcard origin; the presence checks above would not
      // catch a widened directive appended beside them.
      expect(contentSecurityPolicy).not.toContain("unsafe-eval");
      expect(contentSecurityPolicy).not.toContain("*");
      expect(contentSecurityPolicy).not.toContain("http://");

      // The probe branch exits via `app.exit(0)`; a signal or non-zero exit means the boot failed.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    // Derived from the phases it contains; see BOOT_TEST_TIMEOUT_MS.
    BOOT_TEST_TIMEOUT_MS,
  );

  // Negative control for the readiness path. On a healthy boot the diagnostics never run, so this
  // breaks the precondition deterministically (a display number nothing serves) and asserts a
  // named refusal carrying the dump. It drives the real `spawnElectron()` and
  // `renderReadinessFailure()`. The test above is the positive control: without that pairing this
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

      // The child is pinned to the reserved display, not the ambient one; without the pin a
      // regressed gate would let the spawn open on the real display and pass.
      expect(result.childDisplay).toBe(deadDisplay);

      // Classified, not the catch-all arm.
      expect(failureMessage).toContain("was not serving");
      expect(failureMessage).not.toContain("without a recognized failure marker");

      // The dump, with the offending display named in it.
      expect(failureMessage).toContain("--- readiness events observed ---");
      expect(failureMessage).toContain("--- environment ---");
      expect(failureMessage).toContain(deadDisplay);
      expect(failureMessage).toContain(`DISPLAY=${deadDisplay}`);

      // The spawn was refused before Electron existed, so the dump says no readiness event fired
      // rather than leaving the section blank.
      expect(failureMessage).toContain("<none — the renderer never reached");
    },
    // Derived: forced readiness budget, diagnostic budget and slack. No termination grace, since
    // no process exists to signal; the refusal capture takes a `null` probe deadline, so it spends
    // no subprocess.
    FORCED_DISPLAY_READY_TIMEOUT_MS + DIAGNOSTIC_BUDGET_MS + TEST_TIMEOUT_SLACK_MS,
  );

  // Negative control for the deadline path's budget. The control above never spawns Electron, so
  // it skips the spawn deadline, the at-deadline collection with its two subprocess readings and
  // the process-group SIGTERM then SIGKILL. This test forces a real stall (the app boots with the
  // probe opt-in withheld and never emits a probe line) and asserts that the failure is the
  // harness's readiness failure with its dump, not vitest's generic timeout, and that the whole
  // path fits a budget derived from the production constants. Restoring two independent 5 s probe
  // timeouts would exceed that budget and vitest would kill the test.
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

      // The spawn reached this harness's deadline, asserted on the recorded flag since the shim
      // exits with a code, not a signal (see `timedOut`).
      expect(result.timedOut).toBe(true);

      // The collection honored its own bound, asserted against its own recorded measurement.
      // Total elapsed time is not used: SIGTERM-to-`close` teardown (about 2 s on CI) dominates
      // it and nothing here bounds it. The bound is the budget plus the reserve for the
      // `spawnSync` kill-and-reap tail; see DIAGNOSTIC_COLLECTION_CEILING_MS.
      expect(result.diagnosticCollectionMs).not.toBeNull();
      expect(result.diagnosticCollectionMs).toBeLessThanOrEqual(DIAGNOSTIC_COLLECTION_CEILING_MS);

      // Loose backstop: the whole path fits the enclosing budget, which catches a termination
      // path that stopped terminating.
      expect(elapsedMs).toBeLessThan(FORCED_STALL_TEST_TIMEOUT_MS);

      // The readiness failure, not a bare timeout, with the at-deadline readings in the dump.
      expect(failureMessage).toContain("Desktop main process never became ready");
      expect(failureMessage).toContain(
        `still running at the ${String(FORCED_STALL_SPAWN_TIMEOUT_MS)}ms deadline`,
      );
      expect(failureMessage).not.toContain("without a recognized failure marker");
      expect(failureMessage).toContain("--- environment ---");

      // The at-deadline capture ran and its readings are present.
      expect(failureMessage).toContain("[at-deadline]");
      if (process.platform !== "win32") {
        expect(failureMessage).toContain("[at-deadline] process tree");
      }

      // A skipped reading is a designed outcome of the shared budget: a slow first reading costs
      // the second reading, not the enclosing test. A skip must be earned and recorded: it happens
      // only once the budget reaches zero, so a dump with the skip marker must also record a cost
      // of at least the full budget. A bound tightened until a healthy runner drops readings would
      // skip at near-zero cost and fail here.
      if (failureMessage.includes("diagnostic budget exhausted")) {
        expect(result.diagnosticCollectionMs).toBeGreaterThanOrEqual(DIAGNOSTIC_BUDGET_MS);
      }

      // The recorded cost is in the dump too, so a slow collection is legible in CI output.
      expect(failureMessage).toContain("[at-deadline] collection took");
    },
    FORCED_STALL_TEST_TIMEOUT_MS,
  );

  // No blank-document load ships. The smoke bundle is the one build where the probe body
  // survives (a release bundle tree-shakes the branch), so checking it is the only form of this
  // assertion with force. A re-introduced blank-document load would fail other assertions for a
  // reason nobody would read as a revert; this says it directly.
  it("ships no blank-document load in the built smoke bundle", () => {
    expect(
      existsSync(MAIN_ENTRY),
      `Main entry missing at ${MAIN_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);

    const builtMainBundle = readFileSync(MAIN_ENTRY, "utf8");

    expect(builtMainBundle).not.toContain("about:blank");
    // Positive control: the probe body is present, so the absence above is real and not a wrong
    // path or a tree-shaken release bundle.
    expect(builtMainBundle).toContain(SMOKE_PROBE_TAG);
    expect(builtMainBundle).toContain("sidekicks-renderer://app/index.html");
  });
});
