// BrowserWindow lifecycle-reachability regression test.
//
// Closes the gap left by the smoke test: `launch.smoke.test.ts` proves the
// renderer's security-hardening invariants, but it cannot
// observe whether the main-process `BrowserWindow` handle stays reachable
// past the `app.whenReady().then(...)` callback unwind. The smoke test
// exits via `app.exit(0)` the moment the probe completes, so V8 never
// reaches a major GC cycle — any future-Electron lifecycle regression is
// silently masked at that surface.
//
// What this test actually asserts:
//   The observable lifecycle contract — across K=20 cycles of explicit GC
//   pressure following the `.then(...)` unwind, `v8.queryObjects(BrowserWindow)`
//   holds a stable count AND `window-all-closed` does not fire, and once every
//   window is closed and the close has unwound the count drops by at least one
//   per window (the per-window delta that distinguishes the instance from the
//   fixed non-instance match a count-only sample cannot identify). The
//   load-bearing reachability mechanism is Electron's native-side
//   `BaseWindow::self_ref_` (`v8::Global<v8::Value>` strong-rooted in
//   `BaseWindow::InitWith` and released only in `~BaseWindow` at native
//   destruction, read against Electron v41.6.1). The user-side module-scope
//   `let mainWindow` in `apps/desktop/src/main/index.ts` is defensive
//   consistency with the canonical Electron community pattern, not the
//   primary GC anchor — reverting it does NOT produce a failure in this test
//   on Electron 41.6.1. Re-run green on the 44.x pin, the version bump this
//   test's own tripwire row names as its trigger.
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
// How a reading is obtained — the probe branch in the main entrypoint, the
// three activation gates it is behind, the spawn, and the Linux display
// handling — belongs to `helpers/gc-probe.ts` and is documented there. This
// file decides only whether a reading is acceptable.
//
// Failure shapes:
//   • Shape A — Heap-count drift or a missing per-window delta: some
//     iteration saw a different count from the others (`probe.max !==
//     probe.min`), meaning a BrowserWindow wrapper was collected mid-loop; or
//     closing every window released fewer wrappers than there were windows
//     (`probe.openCount - probe.closedCount < probe.windowsOpened`), meaning
//     the surviving match was never the instance. Asserted by the two
//     `expect`s on those quantities; a bare `min >= 1` cannot tell the
//     instance from the fixed match.
//   • Shape B — `allClosedFired === true`: the probe-scoped listener
//     captured `window-all-closed` firing during the iteration loop.
//     This should never happen while a user-created window
//     is intended to be reachable; if it does, the BrowserWindow lifecycle
//     invariant broke (likely a future-Electron `self_ref_` semantics
//     shift). Asserted by `expect(probe.allClosedFired).toBe(false)`.
//   • Shape C — Probe never emits (`result.probe === null`): Electron
//     exited before the probe's `console.log + app.exit(0)` ran. Most
//     likely environmental (missing `xvfb-run` on a Linux runner without
//     `$DISPLAY`, smoke bundle not built, `--js-flags=--expose-gc` not
//     forwarded). Diagnostic surfaces captured stdout / stderr / exit
//     code so a CI failure is debuggable without re-running.

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ELECTRON_BIN, MAIN_ENTRY, PRELOAD_ENTRY } from "./helpers/electron-probe.js";
import {
  GC_PROBE_TAG,
  GC_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
  spawnElectronGcProbe,
} from "./helpers/gc-probe.js";

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
      // lifecycle regression (a future-Electron `self_ref_` semantics shift
      // would be the proximate cause) would
      // also land here. Surface stdout / stderr / exit code so a CI
      // failure is debuggable without re-running.
      if (!result.probe) {
        throw new Error(
          `GC probe did not emit \`${GC_PROBE_TAG}\` line within ${String(SPAWN_TIMEOUT_MS)}ms.\n` +
            `Most likely cause: environmental (xvfb-run missing on a headless Linux runner, ` +
            `smoke bundle not built, --js-flags=--expose-gc not forwarded). A genuine ` +
            `BrowserWindow lifecycle regression is also possible — check the ` +
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

      // Shape A: the count is stable across the GC pressure cycles — no
      // wrapper collected mid-loop — AND drops by at least one per window once
      // every window is closed and the close has unwound. The per-window delta
      // is what distinguishes the user-created instance from the fixed
      // non-instance match a count-only sample cannot identify: a bare
      // `min >= 1` still passes with the instance gone and that match
      // remaining.
      expect(
        probe.max - probe.min,
        `Probe saw queryObjects(BrowserWindow) drift across the loop (counts: ${JSON.stringify(probe.counts)}). ` +
          `A reachable window's count must hold across GC pressure — the proximate cause is most likely a future-Electron BaseWindow::self_ref_ semantics shift.`,
      ).toBe(0);
      expect(
        probe.windowsOpened,
        "the probe found no open window to measure",
      ).toBeGreaterThanOrEqual(1);
      expect(
        probe.openCount - probe.closedCount,
        `Closing ${String(probe.windowsOpened)} window(s) moved queryObjects(BrowserWindow) ${String(probe.openCount)} → ${String(probe.closedCount)}. ` +
          `Each open window holds exactly one reachable instance that the close releases; a smaller delta means the count was carried by something other than the instance.`,
      ).toBeGreaterThanOrEqual(probe.windowsOpened);

      // Shape B: `allClosedFired === false`. The probe-scoped listener
      // captures whether `window-all-closed` fired during the iteration
      // loop. This should never happen while a user-created window is
      // intended to be reachable — `self_ref_`
      // strong-roots the wrapper, so the native window is alive, so
      // `WindowList::RemoveWindow` cannot fire on it. A true value here
      // is the strongest evidence that the lifecycle invariant broke.
      expect(
        probe.allClosedFired,
        `Probe-scoped listener observed window-all-closed firing during the iteration loop. ` +
          `This should not be possible while a user-created window is intended to be reachable — the BrowserWindow lifecycle invariant broke.`,
      ).toBe(false);

      // Probe exited cleanly via `app.exit(0)`. Non-zero or signal-killed
      // means something other than the assertions above went wrong.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    GC_TEST_TIMEOUT_MS,
  );
});
