// The admissibility rule the pane sweep is judged by, driven over hand-written
// readings rather than over a run.
//
// The rule and the readings it judges are separable on purpose: a sweep costs a real
// Electron window, three WebGL contexts and fifteen forced collections, so the cases
// that prove the rule REJECTS what it is meant to reject cannot be sweeps. Each one
// below is a series the instrument could actually produce — the measured idle figures,
// the loaded-runner figures that sent this control back to be hardened, and the two
// shapes the band exists for — and every clean arm has the negative control beside it
// that fails on a rule that returned `admissible` unconditionally.
//
// The sweep's own arithmetic is `terminal-instance-memory.test.ts`'s subject and is
// not restated here; what this file owns is the verdict taken over it.

import { describe, expect, it } from "vitest";

import {
  admissibilityOf,
  INSTRUMENT_NOISE_FLOOR_BYTES,
  type TerminalInstanceSeries,
} from "./terminal-instance-series.js";

const KILOBYTE = 1024;

/**
 * A series with the per-instance figures a case wants, and the rest filled in.
 *
 * The teardown residue and the baseline are not read by the rule at all — they are
 * the sweep's own claims — so they are held at figures a reader can ignore rather
 * than varied per case.
 */
function seriesOf(
  paneStandingBytes: number,
  perInstanceIntervalBytes: readonly number[],
): TerminalInstanceSeries {
  const everyInstanceBytes = [paneStandingBytes, ...perInstanceIntervalBytes];
  return {
    baselineHeapBytes: 13_000 * KILOBYTE,
    paneStandingBytes,
    perInstanceIntervalBytes,
    laterInstanceBytes:
      perInstanceIntervalBytes.reduce((total, interval) => total + interval, 0) /
      perInstanceIntervalBytes.length,
    perInstanceBytes:
      everyInstanceBytes.reduce((total, instance) => total + instance, 0) /
      everyInstanceBytes.length,
    teardownResidueBytes: 0,
  };
}

/** What this tree measures idle, run after run: a first pane and two agreeing later ones. */
const MEASURED_IDLE_SERIES = seriesOf(955 * KILOBYTE, [840 * KILOBYTE, 837 * KILOBYTE]);

describe("the pane sweep's admissibility rule", () => {
  it("admits the figures this tree measures on an idle machine", () => {
    // The floor under every rejection below: a rule that rejected everything would
    // satisfy all of them and gate nothing.
    expect(admissibilityOf(MEASURED_IDLE_SERIES).admissible).toBe(true);
  });

  it("refuses a figure inside the instrument's noise, and says that is what happened", () => {
    // The loaded-runner reading that sent this control back: 2 021 kB against 310 kB.
    // 310 kB clears the floor, so this case plants a figure that does not — the
    // sentence has to name the instrument rather than the pane, because a sweep whose
    // deltas the instrument cannot resolve has not measured a pane at all.
    const verdict = admissibilityOf(
      seriesOf(955 * KILOBYTE, [840 * KILOBYTE, INSTRUMENT_NOISE_FLOOR_BYTES - 1]),
    );
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) {
      throw new Error("unreachable");
    }
    expect(verdict.reason).toContain("noise floor");
    // And it names the reading that is not a candidate, so a reviewer does not spend
    // the afternoon on the graphics stack.
    expect(verdict.reason).toContain("webgl");
  });

  it("refuses two intervals that disagree, however healthy their mean looks", () => {
    // The counterexample this arm exists for, priced above the noise floor so the
    // floor is not what rejects it: instance 2 at 1.5 MB and instance 3 at 260 kB
    // average to 880 kB, which is inside the slope band against a 955 kB first
    // instance. The mean is admissible and the readings are not.
    const disagreeing = seriesOf(955 * KILOBYTE, [1500 * KILOBYTE, 260 * KILOBYTE]);
    expect(Math.min(...disagreeing.perInstanceIntervalBytes)).toBeGreaterThan(
      INSTRUMENT_NOISE_FLOOR_BYTES,
    );
    expect(disagreeing.laterInstanceBytes).toBeGreaterThan(disagreeing.paneStandingBytes * 0.5);
    expect(disagreeing.laterInstanceBytes).toBeLessThan(disagreeing.paneStandingBytes * 2);
    const verdict = admissibilityOf(disagreeing);
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) {
      throw new Error("unreachable");
    }
    expect(verdict.reason).toContain("disagree");
  });

  it("refuses a slope that is a fraction of the first instance", () => {
    // The finding this control exists for: a one-time cost carried by the first mount
    // and reported as what an instance costs.
    const verdict = admissibilityOf(seriesOf(4000 * KILOBYTE, [900 * KILOBYTE, 880 * KILOBYTE]));
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) {
      throw new Error("unreachable");
    }
    expect(verdict.reason).toContain("paid once");
  });

  it("refuses later panes that cost more than the first, so the gate is not below the worst case", () => {
    const verdict = admissibilityOf(seriesOf(400 * KILOBYTE, [1200 * KILOBYTE, 1180 * KILOBYTE]));
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) {
      throw new Error("unreachable");
    }
    expect(verdict.reason).toContain("worst case");
  });

  it("reports every figure it judged, so a failure can be read without a re-run", () => {
    const verdict = admissibilityOf(seriesOf(4000 * KILOBYTE, [900 * KILOBYTE, 880 * KILOBYTE]));
    if (verdict.admissible) {
      throw new Error("unreachable");
    }
    // Without this a reviewer reading a CI log has the verdict and not the readings,
    // and the first thing anybody asks of a heap gate is what it actually measured.
    expect(verdict.reason).toContain("4000 kB");
    expect(verdict.reason).toContain("900 kB");
    expect(verdict.reason).toContain("880 kB");
  });
});
