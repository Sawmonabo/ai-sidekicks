import { describe, expect, it } from "vitest";

import {
  CHROME_SETTLE_SPRING,
  SPRING_SAMPLE_COUNT,
  criticalDamping,
  isSettling,
  motionAllowanceFor,
  runViewTransition,
  sampleSpringEasing,
  springProgressAt,
  transitionDurationMs,
  transitionEasing,
  type ViewTransitionHost,
} from "./motion.js";
import { MOTION_DURATIONS_MS, MOTION_EASE_SETTLE } from "./palette.js";

/** Read a `linear(...)` string back into the numbers it carries. */
function samplesOf(easing: string): readonly number[] {
  const inner = easing.slice("linear(".length, -1);
  return inner.split(", ").map((sample) => Number(sample));
}

describe("the chrome spring", () => {
  it("is critically damped, so rule 5's zero overshoot is a property of the constants", () => {
    expect(criticalDamping(CHROME_SETTLE_SPRING)).toBe(CHROME_SETTLE_SPRING.damping);
    expect(isSettling(CHROME_SETTLE_SPRING)).toBe(true);
  });

  it("overshoots once it is under-damped — the negative control for that check", () => {
    const bouncy = { ...CHROME_SETTLE_SPRING, damping: 8 };
    expect(isSettling(bouncy)).toBe(false);
    const peak = Math.max(
      ...Array.from({ length: 64 }, (_unused, index) => springProgressAt(bouncy, index / 32)),
    );
    expect(peak).toBeGreaterThan(1);
  });

  it("starts at rest and arrives", () => {
    expect(springProgressAt(CHROME_SETTLE_SPRING, 0)).toBe(0);
    expect(springProgressAt(CHROME_SETTLE_SPRING, 1)).toBeCloseTo(1, 3);
  });
});

describe("the sampled linear() easing", () => {
  const easing = sampleSpringEasing(CHROME_SETTLE_SPRING);

  it("is pinned to exactly 0 and 1 at its ends", () => {
    const samples = samplesOf(easing);
    expect(samples).toHaveLength(SPRING_SAMPLE_COUNT + 1);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(1);
  });

  it("never exceeds 1, which is what makes it a settle and not a bounce", () => {
    for (const sample of samplesOf(easing)) {
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  // Non-decreasing rather than strictly increasing, and the difference is a fact
  // about this spring rather than a weakened assertion: critically damped at these
  // constants it is within 1e-4 of its target before the last sample, so at the
  // emitted precision the tail repeats 1. Strict increase is asserted where it is
  // true — every step that has not yet arrived.
  it("rises monotonically and never retreats once it has arrived", () => {
    const samples = samplesOf(easing);
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1] as number;
      const current = samples[index] as number;
      expect(current).toBeGreaterThanOrEqual(previous);
      if (previous < 1) {
        expect(current).toBeGreaterThan(previous);
      }
    }
  });

  it("tracks the closed-form spring it was sampled from", () => {
    const samples = samplesOf(easing);
    for (let index = 1; index < SPRING_SAMPLE_COUNT; index += 1) {
      const exact = springProgressAt(CHROME_SETTLE_SPRING, index / SPRING_SAMPLE_COUNT);
      expect(samples[index]).toBeCloseTo(exact, 3);
    }
  });

  it("refuses a sample count that cannot describe a curve", () => {
    expect(() => sampleSpringEasing(CHROME_SETTLE_SPRING, 1)).toThrow(RangeError);
    expect(() => sampleSpringEasing(CHROME_SETTLE_SPRING, 8.5)).toThrow(RangeError);
  });
});

describe("the reduced-motion allowance", () => {
  it("names the collapse rather than switching motion off", () => {
    expect(motionAllowanceFor(false)).toBe("full");
    expect(motionAllowanceFor(true)).toBe("opacity-only");
  });

  it("keeps a non-zero duration under the collapse, so a fade is still a fade", () => {
    expect(transitionDurationMs("motion-thread", "full")).toBe(
      MOTION_DURATIONS_MS["motion-thread"],
    );
    expect(transitionDurationMs("motion-thread", "opacity-only")).toBe(
      MOTION_DURATIONS_MS["motion-quick"],
    );
    expect(transitionDurationMs("motion-thread", "opacity-only")).toBeGreaterThan(0);
  });

  it("spends no sampled curve on a transition that does not travel", () => {
    expect(transitionEasing("full")).toBe(sampleSpringEasing(CHROME_SETTLE_SPRING));
    expect(transitionEasing("opacity-only")).toBe(MOTION_EASE_SETTLE);
  });
});

describe("running a view transition", () => {
  function recordingHost(behaviour: "runs" | "throws"): {
    readonly host: ViewTransitionHost;
    readonly calls: (() => void)[];
  } {
    const calls: (() => void)[] = [];
    return {
      calls,
      host: {
        startViewTransition: (callback: () => void) => {
          calls.push(callback);
          if (behaviour === "throws") {
            callback();
            throw new Error("the document went away mid-transition");
          }
          return {};
        },
      },
    };
  }

  it("takes the transition when the platform has one and motion is allowed", () => {
    const { host, calls } = recordingHost("runs");
    let mutations = 0;
    expect(runViewTransition(host, "full", () => (mutations += 1))).toBe(true);
    expect(calls).toHaveLength(1);
    calls[0]?.();
    expect(mutations).toBe(1);
  });

  it("still applies the change when the platform has no view transitions", () => {
    let mutations = 0;
    expect(runViewTransition({}, "full", () => (mutations += 1))).toBe(false);
    expect(mutations).toBe(1);
  });

  it("skips the transition under reduced motion and applies the change anyway", () => {
    const { host, calls } = recordingHost("runs");
    let mutations = 0;
    expect(runViewTransition(host, "opacity-only", () => (mutations += 1))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(mutations).toBe(1);
  });

  it("applies the change exactly once when the host runs the callback and then throws", () => {
    const { host } = recordingHost("throws");
    let mutations = 0;
    expect(runViewTransition(host, "full", () => (mutations += 1))).toBe(false);
    expect(mutations).toBe(1);
  });
});
