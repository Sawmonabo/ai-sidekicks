// Regression test for the main-process window handle staying reachable after the
// `app.whenReady().then(...)` callback unwinds. `launch.smoke.test.ts` cannot see this: it exits
// via `app.exit(0)` as soon as the probe completes, so V8 never reaches a major GC.
//
// Across 20 cycles of explicit GC pressure, `v8.queryObjects(BaseWindow)` must hold a stable
// count and `window-all-closed` must not fire; once every window is closed the count must drop by
// at least one per window (the delta separates the instance from a fixed non-instance match that
// a count-only sample cannot tell apart). Two anchors keep a window reachable: main's registry of
// open windows (`src/main/windows/open-windows.ts`) and Electron's native `BaseWindow::self_ref_`,
// so this guards against either letting go of an open window, or an unrelated bug that fires
// `window-all-closed`.
//
// The probe, its gates, the spawn and the display handling are in `lifecycle.gc.test-support.ts`
// and `src/main/probes/gc-probe.ts`. Failure shapes: A, count drift or a missing per-window
// delta; B, `allClosedFired`; C, no probe line (usually environmental: no `xvfb-run`, smoke
// bundle unbuilt, or `--js-flags=--expose-gc` not forwarded).

import { describe, expect, it } from "vitest";

import { GC_PROBE_TAG } from "@shared/probe-tags.js";

import { GC_TEST_TIMEOUT_MS, spawnElectronGcProbe } from "./lifecycle.gc.test-support.js";
import { SPAWN_TIMEOUT_MS } from "./helpers/smoke-probe-harness.js";

describe("window lifecycle reachability", () => {
  it(
    "main-process window handle survives K GC cycles after .then(...) unwind",
    async () => {
      const result = await spawnElectronGcProbe();

      // Shape C: no probe line. Most likely environmental; a genuine lifecycle regression would
      // also land here. Surface stdout, stderr and the exit code so a CI failure is debuggable
      // without re-running.
      if (!result.probe) {
        throw new Error(
          `GC probe did not emit \`${GC_PROBE_TAG}\` line within ${String(SPAWN_TIMEOUT_MS)}ms.\n` +
            `Most likely cause: environmental (xvfb-run missing on a headless Linux runner, ` +
            `smoke bundle not built, --js-flags=--expose-gc not forwarded). A genuine ` +
            `window lifecycle regression is also possible — check the window registry, the ` +
            `Electron version and the BaseWindow::self_ref_ semantics if so.\n` +
            `Exit code: ${String(result.exitCode)}, signal: ` +
            `${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
            `--- tagged lines that did not parse ` +
            `---\n${result.malformedProbeLines.join("\n") || "<none>"}\n` +
            `--- stdout ---\n${result.stdout}\n` +
            `--- stderr ---\n${result.stderr}\n`,
        );
      }

      const probe = result.probe;

      // Setup gates, not the bug-state assertions: a failure here means the harness is
      // misconfigured and the count signal below is unreliable.
      expect(
        probe.queryObjectsAvailable,
        "v8.queryObjects is not a function — test harness " +
          "setup is broken; results below are unreliable",
      ).toBe(true);
      expect(
        probe.globalGcAvailable,
        "globalThis.gc is not a function — `--js-flags=--expose-gc` did not reach " +
          "Electron; GC pressure cycles are no-ops and counts below are non-deterministic",
      ).toBe(true);
      expect(probe.iterations).toBeGreaterThan(0);
      expect(probe.counts.length).toBe(probe.iterations);

      // Shape A: the count is stable across the GC pressure cycles and drops by at least one per
      // window once every window is closed. The per-window delta separates the user-created
      // instance from the fixed non-instance match: a bare `min >= 1` still passes with the
      // instance gone and that match remaining.
      expect(
        probe.max - probe.min,
        `Probe saw queryObjects(BaseWindow) drift across ` +
          `the loop (counts: ${JSON.stringify(probe.counts)}). ` +
          `A reachable window's count must hold across GC pressure — the proximate ` +
          `cause is the registry dropping a window or a BaseWindow::self_ref_ semantics shift.`,
      ).toBe(0);
      expect(
        probe.windowsOpened,
        "the probe found no open window to measure",
      ).toBeGreaterThanOrEqual(1);
      expect(
        probe.openCount - probe.closedCount,
        `Closing ${String(probe.windowsOpened)} window(s) moved queryObjects(BaseWindow) ` +
          `${String(probe.openCount)} → ${String(probe.closedCount)}. ` +
          `Each open window holds exactly one reachable instance that the close releases; a ` +
          `smaller delta means the count was carried by something other than the instance.`,
      ).toBeGreaterThanOrEqual(probe.windowsOpened);

      // Shape B: `window-all-closed` must not fire during the loop. The registry and `self_ref_`
      // strong-root the wrapper, so the native window stays alive and cannot be removed from the
      // window list; a true value is the strongest evidence the lifecycle invariant broke.
      expect(
        probe.allClosedFired,
        `Probe-scoped listener observed window-all-closed firing during the iteration loop. ` +
          `This should not be possible while a user-created window is intended ` +
          `to be reachable — the window lifecycle invariant broke.`,
      ).toBe(false);

      // The probe exits via `app.exit(0)`; anything else means something outside the above broke.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    GC_TEST_TIMEOUT_MS,
  );
});
