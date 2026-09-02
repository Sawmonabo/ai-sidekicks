// Plan-023 BrowserWindow lifecycle-reachability regression test.
//
// Closes the gap left by the smoke test: `launch.smoke.test.ts` proves the
// renderer's Spec-023 §Security Hardening Baseline invariants, but it cannot
// observe whether the main-process `BrowserWindow` handle stays reachable
// past the `app.whenReady().then(...)` callback unwind. The smoke test
// exits via `app.exit(0)` the moment the probe completes, so V8 never
// reaches a major GC cycle — any future-Electron lifecycle regression is
// silently masked at that surface.
//
// What this test actually asserts:
//   The observable lifecycle contract — across K=20 cycles of explicit GC
//   pressure following the `.then(...)` unwind, `v8.queryObjects(BrowserWindow)`
//   reports `>= 1` AND `window-all-closed` does not fire. Per ADR-024
//   §Antithesis, the load-bearing reachability mechanism is Electron's
//   native-side `BaseWindow::self_ref_` (`v8::Global<v8::Value>` strong-
//   rooted from `InitWith` at `electron_api_base_window.cc:155` to native
//   destruction at `electron_api_base_window.cc:130`). The user-side
//   module-scope `let mainWindow` in `apps/desktop/src/main/index.ts` is
//   defensive consistency with the canonical Electron community pattern,
//   not the primary GC anchor — reverting it does NOT produce a failure
//   in this test on Electron 41.6.1 (the empirical falsification recorded
//   in ADR-024 §Antithesis). Re-run green on the 44.x pin at Plan-023
//   T-023p-1B-4 — the version bump this test's own tripwire row names as
//   its trigger.
//
//   The test therefore serves as a future-regression guard against:
//     • A future Electron release shifting `self_ref_` lifetime semantics
//       (e.g., dropping the wrapper from a strong root before native
//       destruction).
//     • An unrelated lifecycle bug that causes `window-all-closed` to fire
//       while a user-created window is intended to be reachable.
//   It does NOT prove that user-side retention is causally load-bearing
//   in the current fix-state.
//
// Mechanism:
//   The main entrypoint exposes a second compile-time-gated probe path
//   (`SIDEKICKS_GC_PROBE=1`) that does NOT exit immediately. Instead it
//   schedules `runGcProbe` on a fresh event-loop tick (so the `.then(...)`
//   arrow's locals can unwind first) and the probe iterates K=20 cycles of:
//     1. Two bare `globalThis.gc()` calls (precise major collection — see
//        ADR-024 §Antithesis for why `gc(true)` is rejected: that signature
//        is a MINOR scavenge per V8's `gc-extension.cc`, leaving old-
//        generation objects intact).
//     2. An 8 MB Uint8Array allocation to pressure old-generation promotion
//        of the throwaway buffer + reclaim of the prior iteration's buffer.
//     3. Two more `globalThis.gc()` calls.
//     4. A 50 ms wait so any C++ destructor task posted by a V8 weak
//        callback can run.
//     5. A `v8.queryObjects(BrowserWindow, { format: "count" })` sample.
//   The branch also registers a probe-scoped `window-all-closed` listener
//   that toggles a module-scope flag — the listener fires before the
//   pre-existing `app.quit()` handler (EventEmitter listener order is
//   registration order), so the flag captures the event even if the probe's
//   `console.log` would otherwise lose the race against process exit. On
//   completion the probe emits a single `[SIDEKICKS_GC_PROBE]` JSON line
//   to stdout (including `allClosedFired` from the flag) and calls
//   `app.exit(0)`.
//
// Failure shapes:
//   • Shape A — Heap-count threshold: `probe.min < 1`. Some iteration
//     observed `queryObjects` returning zero, meaning a BrowserWindow
//     wrapper was collected mid-loop. Asserted by
//     `expect(probe.min).toBeGreaterThanOrEqual(1)`.
//   • Shape B — `allClosedFired === true`: the probe-scoped listener
//     captured `window-all-closed` firing during the iteration loop.
//     Per ADR-024 this should never happen while a user-created window
//     is intended to be reachable; if it does, the BrowserWindow lifecycle
//     invariant broke (likely a future-Electron `self_ref_` semantics
//     shift). Asserted by `expect(probe.allClosedFired).toBe(false)`.
//   • Shape C — Probe never emits (`result.probe === null`): Electron
//     exited before the probe's `console.log + app.exit(0)` ran. Most
//     likely environmental (missing `xvfb-run` on a Linux runner without
//     `$DISPLAY`, smoke bundle not built, `--js-flags=--expose-gc` not
//     forwarded). Diagnostic surfaces captured stdout / stderr / exit
//     code so a CI failure is debuggable without re-running.
//
// Activation requirements (the production-safety multi-gate):
//   1. Bundle built with `electron-vite build --mode=smoke` (sets
//      `__SIDEKICKS_SMOKE_BUILD__` to `true` via Vite `define`). A release
//      bundle has the entire probe body tree-shaken out — running this
//      test against a release bundle would silently time out.
//   2. Spawn environment carries `SIDEKICKS_GC_PROBE=1` AND does NOT
//      carry `SIDEKICKS_SMOKE_PROBE=1` (the smoke branch is checked first
//      in the if/else if cascade in `apps/desktop/src/main/index.ts`).
//   3. Electron started with `--js-flags=--expose-gc` so `globalThis.gc()`
//      is wired. Without this flag the probe's GC-pressure loop is a
//      no-op (V8 will collect on its own schedule) and the test becomes
//      non-deterministic — see the `globalGcAvailable` setup-correctness
//      assertion below for the explicit gate.
//
// Linux CI handling — same posture as the smoke test. CI now stands up ONE
// Xvfb for the whole job and exports `$DISPLAY` before any test runs (see
// `.github/workflows/ci.yml`), so `needsXvfb()` is false there and this spawns
// the binary directly. The `xvfb-run -a` arm below remains the fallback for a
// Linux contributor running with no display server of their own.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root — `apps/desktop/`. The test file lives at
// `apps/desktop/test/lifecycle.gc.test.ts`; `..` lands on the package root.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

const MAIN_ENTRY = path.join(PACKAGE_ROOT, "out/main/index.js");
const PRELOAD_ENTRY = path.join(PACKAGE_ROOT, "out/preload/index.cjs");
const ELECTRON_BIN = path.join(PACKAGE_ROOT, "node_modules/.bin/electron");

const GC_PROBE_TAG = "[SIDEKICKS_GC_PROBE]";

// K=20 iterations × ~150 ms each ≈ 3 s probe runtime. Plus Electron boot
// (typically 1-2 s on Linux runners). 30 s is a generous backstop.
const SPAWN_TIMEOUT_MS = 30_000;

interface GcProbe {
  readonly ok: boolean;
  readonly queryObjectsAvailable: boolean;
  readonly globalGcAvailable: boolean;
  readonly iterations: number;
  readonly counts: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly allClosedFired: boolean;
}

interface SpawnResult {
  readonly probe: GcProbe | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

function needsXvfb(): boolean {
  return process.platform === "linux" && !process.env["DISPLAY"];
}

function spawnElectronGcProbe(): Promise<SpawnResult> {
  const startedAt = Date.now();

  // Per-spawn userData dir isolates this test's Electron instance from every
  // other Electron running on the default profile — a sibling suite in a
  // parallel vitest worker, a second checkout, a developer's unrelated
  // Electron app, an orphan from an earlier terminated run. They would
  // otherwise race on `~/Library/Application Support/Electron/SingletonLock`
  // (or its $XDG_CONFIG_HOME equivalent on Linux): whichever starts
  // second sees `gotTheLock === false`, calls `app.quit()`, and exits
  // with code 0 before the probe runs — a Shape-C failure that has nothing
  // to do with BrowserWindow GC reachability.
  // `mkdtempSync` returns a unique path; the close handler removes it.
  // `launch.smoke.test.ts` isolates its own profile the same way, for the
  // same reason.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sidekicks-gc-test-"));

  // `--js-flags=--expose-gc` MUST precede the entry script so Electron
  // forwards it to the underlying Chromium/V8 child. The probe's GC-pressure
  // loop is a no-op without it; the test asserts `globalGcAvailable === true`
  // to fail loudly rather than silently produce non-deterministic results.
  const electronArgs = ["--js-flags=--expose-gc", `--user-data-dir=${userDataDir}`, MAIN_ENTRY];
  const spawnCommand = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const spawnArguments = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  // Strip SIDEKICKS_SMOKE_PROBE from the spawn env so the smoke branch
  // (checked first in the if/else if cascade in the main entrypoint) does
  // NOT fire ahead of the GC probe. This guards against a developer's
  // shell having SIDEKICKS_SMOKE_PROBE exported, or a future CI matrix
  // that runs both probes back-to-back.
  const { SIDEKICKS_SMOKE_PROBE: _drop, ...envWithoutSmoke } = process.env;

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(spawnCommand, spawnArguments, {
      cwd: PACKAGE_ROOT,
      env: {
        ...envWithoutSmoke,
        SIDEKICKS_GC_PROBE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let probe: GcProbe | null = null;
    let pending = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const probeTagIndex = line.indexOf(GC_PROBE_TAG);
        if (probeTagIndex < 0) continue;
        const payload = line.slice(probeTagIndex + GC_PROBE_TAG.length).trim();
        if (!payload.startsWith("{")) continue;
        try {
          probe = JSON.parse(payload) as GcProbe;
        } catch {
          // Tagged but malformed — keep scanning subsequent lines.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const cleanup = (): void => {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup. A leftover temp dir is harmless;
        // surfacing the cleanup error would mask the actual test result.
      }
    };

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      cleanup();
      resolve({
        probe: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: null,
        signal: null,
        elapsedMs: Date.now() - startedAt,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      cleanup();
      resolve({
        probe,
        stdout,
        stderr,
        exitCode,
        signal,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

// Governing docs for this suite (Plan-023, ADR-024 §Antithesis) are named in
// the file header and the per-assertion comments — never in test titles.
describe("BrowserWindow lifecycle reachability", () => {
  it("verifies smoke bundle exists before spawning Electron", () => {
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
  });

  it(
    "main-process BrowserWindow handle survives K GC cycles after .then(...) unwind",
    async () => {
      const result = await spawnElectronGcProbe();

      // Shape C: probe never emitted. Electron exited before the probe's
      // `console.log + app.exit(0)` ran. Most likely environmental —
      // missing `xvfb-run` on a Linux runner without `$DISPLAY`, smoke
      // bundle not built (release bundle tree-shakes the probe), or
      // `--js-flags=--expose-gc` not forwarded. A genuine BrowserWindow
      // lifecycle regression (per ADR-024 §Antithesis, a future-Electron
      // `self_ref_` semantics shift would be the proximate cause) would
      // also land here. Surface stdout / stderr / exit code so a CI
      // failure is debuggable without re-running.
      if (!result.probe) {
        throw new Error(
          `GC probe did not emit \`${GC_PROBE_TAG}\` line within ${String(SPAWN_TIMEOUT_MS)}ms.\n` +
            `Most likely cause: environmental (xvfb-run missing on a headless Linux runner, ` +
            `smoke bundle not built, --js-flags=--expose-gc not forwarded). A genuine ` +
            `BrowserWindow lifecycle regression (ADR-024) is also possible — check the ` +
            `Electron version and the BaseWindow::self_ref_ semantics if so.\n` +
            `Exit code: ${String(result.exitCode)}, signal: ${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
            `--- stdout ---\n${result.stdout}\n` +
            `--- stderr ---\n${result.stderr}\n`,
        );
      }

      const probe = result.probe;

      // Setup-correctness gates — these are NOT the bug-state assertions
      // they are environment preconditions. A failure here means the test
      // harness is misconfigured (e.g., `--js-flags=--expose-gc` not
      // wired, `node:v8` not importable) and the count signal below is
      // unreliable.
      expect(
        probe.queryObjectsAvailable,
        "v8.queryObjects is not a function — test harness setup is broken; results below are unreliable",
      ).toBe(true);
      expect(
        probe.globalGcAvailable,
        "globalThis.gc is not a function — `--js-flags=--expose-gc` did not reach Electron; GC pressure cycles are no-ops and counts below are non-deterministic",
      ).toBe(true);
      expect(probe.iterations).toBeGreaterThan(0);
      expect(probe.counts.length).toBe(probe.iterations);

      // Shape A: heap-count threshold. The probe must observe at least
      // one BrowserWindow instance on every iteration; a count of zero
      // means a wrapper was collected mid-loop. The Step 0b empirical
      // baseline recorded in ADR-024 §Antithesis — The Strongest Case
      // Against shows fixed-state count is typically 2 — an internal
      // Electron-managed instance plus the user-created window. Either
      // way the assertion `min >= 1` is the observable contract.
      expect(
        probe.min,
        `Probe saw queryObjects(BrowserWindow) count drop to ${String(probe.min)} (counts: ${JSON.stringify(probe.counts)}). ` +
          `Per ADR-024, the BrowserWindow lifecycle invariant requires at least one wrapper to remain reachable across the probe loop — the proximate cause is most likely a future-Electron BaseWindow::self_ref_ semantics shift.`,
      ).toBeGreaterThanOrEqual(1);

      // Shape B: `allClosedFired === false`. The probe-scoped listener
      // captures whether `window-all-closed` fired during the iteration
      // loop. Per ADR-024 §Antithesis this should never happen while a
      // user-created window is intended to be reachable — `self_ref_`
      // strong-roots the wrapper, so the native window is alive, so
      // `WindowList::RemoveWindow` cannot fire on it. A true value here
      // is the strongest evidence that the lifecycle invariant broke.
      expect(
        probe.allClosedFired,
        `Probe-scoped listener observed window-all-closed firing during the iteration loop. ` +
          `Per ADR-024, this should not be possible while a user-created window is intended to be reachable — the BrowserWindow lifecycle invariant broke.`,
      ).toBe(false);

      // Probe exited cleanly via `app.exit(0)`. Non-zero or signal-killed
      // means something other than the assertions above went wrong.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    SPAWN_TIMEOUT_MS + 5_000,
  );
});
