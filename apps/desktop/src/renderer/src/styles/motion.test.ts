import { describe, expect, it } from "vitest";

import { CHROME_SETTLE_EASING, MOTION_DURATIONS_MS } from "./motion.js";
import { CHROME_SETTLE_SPRING, sampleSpringEasing } from "./spring-sampler.test-support.js";

/** Read a `linear(...)` string back into the numbers it carries. */
function samplesOf(easing: string): readonly number[] {
  const inner = easing.slice("linear(".length, -1);
  return inner.split(", ").map((sample) => Number(sample));
}

// The sampler's public API is the emitted string, so every claim is made about it: the closed
// form and sample count are private, and a test reaching them would check the sampler against
// the function it samples. The last case re-derives the shipped constant, the one place the two
// are held together.
describe("the sampled linear() easing", () => {
  const easing = sampleSpringEasing(CHROME_SETTLE_SPRING);

  it("is pinned to exactly 0 and 1 at its ends", () => {
    // A settle approaches its target asymptotically, so the raw final sample is a hair short and
    // an easing ending at 0.9997 would leave the property short forever.
    const samples = samplesOf(easing);
    expect(samples.length).toBeGreaterThan(2);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(1);
  });

  it("never exceeds 1, which is zero overshoot as the sheet will paint it", () => {
    for (const sample of samplesOf(easing)) {
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it("overshoots once the spring is under-damped — the negative control for that", () => {
    // Without this the assertion above passes over a sampler that clamped, or never reached the
    // under-damped branch.
    const bouncy = { ...CHROME_SETTLE_SPRING, damping: 8 };
    expect(Math.max(...samplesOf(sampleSpringEasing(bouncy, 64)))).toBeGreaterThan(1);
  });

  it("settles without overshoot from the over-damped side too", () => {
    // The over-damped branch, which nothing else reaches: two real roots, no oscillation. It
    // arrives later and never passes its target.
    const sluggish = sampleSpringEasing({ ...CHROME_SETTLE_SPRING, damping: 120 });
    for (const sample of samplesOf(sluggish)) {
      expect(sample).toBeLessThanOrEqual(1);
    }
    expect(samplesOf(sluggish).at(-1)).toBe(1);
  });

  it("rises monotonically and never retreats once it has arrived", () => {
    // Non-decreasing, not strictly increasing: critically damped at these constants the spring is
    // within 1e-4 of its target before the last sample, so at the emitted precision the tail
    // repeats 1. Strict increase is asserted for every step that has not yet arrived.
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

  it("emits the count it was asked for, and refuses one that cannot describe a curve", () => {
    expect(samplesOf(sampleSpringEasing(CHROME_SETTLE_SPRING, 4))).toHaveLength(5);
    expect(() => sampleSpringEasing(CHROME_SETTLE_SPRING, 1)).toThrow(RangeError);
    expect(() => sampleSpringEasing(CHROME_SETTLE_SPRING, 8.5)).toThrow(RangeError);
  });

  it("is deterministic, so the sheet it is emitted into is", () => {
    expect(sampleSpringEasing(CHROME_SETTLE_SPRING)).toBe(easing);
  });

  it("is exactly what `motion.ts` ships, so the shipped curve cannot drift from it", () => {
    // The token sheet spends the shipped string, not the sampler, and this makes that safe:
    // editing a spring constant, the sample count or the precision without re-deriving
    // `CHROME_SETTLE_EASING` fails here.
    expect(CHROME_SETTLE_EASING).toBe(easing);
  });
});

describe("the motion scale", () => {
  it("holds every step to the band the motion rule admits", () => {
    // 120-180 ms for chrome and 240 ms for an attribution thread drawing itself.
    expect(MOTION_DURATIONS_MS["motion-quick"]).toBe(120);
    expect(MOTION_DURATIONS_MS["motion-settle"]).toBe(180);
    expect(MOTION_DURATIONS_MS["motion-thread"]).toBe(240);
  });
});
