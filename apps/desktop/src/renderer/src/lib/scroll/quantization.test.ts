// The learner driven with readbacks whose verdict is known, without a controller or scroll
// container. The end-to-end path is `chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { WholePixelQuantizationLearner } from "./quantization.js";

describe("the whole-pixel quantization learner", () => {
  it("a display that keeps the fraction settles the other way", () => {
    const learner = new WholePixelQuantizationLearner();
    learner.observe(100.4, 100.4);
    learner.observe(220.4, 220.4);
    expect(learner.verdict).toBe(false);
  });

  it("starts over on two readings that disagree rather than averaging them", () => {
    // The disagreeing reading is what a concurrent user scroll looks like from here.
    const learner = new WholePixelQuantizationLearner();
    learner.observe(100.4, 100);
    learner.observe(220.4, 220.4);
    expect(learner.verdict).toBeUndefined();
    learner.observe(300.4, 300.4);
    expect(learner.verdict).toBe(false);
  });

  it("takes no evidence from a whole-pixel request, which lands whole anywhere", () => {
    const learner = new WholePixelQuantizationLearner();
    learner.observe(100, 100);
    learner.observe(200, 200);
    learner.observe(300, 300);
    expect(learner.verdict).toBeUndefined();
  });

  it("skips nothing while the question is open, and skips a rounding no-op once it is not", () => {
    const learner = new WholePixelQuantizationLearner();
    expect(learner.isNoOpWrite(220.2, 220)).toBe(false);
    learner.observe(100.4, 100);
    learner.observe(220.4, 220);
    expect(learner.isNoOpWrite(220.2, 220)).toBe(true);
    expect(learner.isNoOpWrite(221.7, 220)).toBe(false);
  });
});
