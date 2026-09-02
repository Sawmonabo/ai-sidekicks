// The learner's one job, driven with readbacks whose verdict is known.
//
// No controller and no surface here: the subject is a fold over pairs of numbers,
// and driving it through a scroll controller would make the controller the subject.
// The end-to-end path is `scroll-chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { WholePixelQuantizationLearner } from "./scroll-quantization.js";

describe("the whole-pixel quantization learner", () => {
  it("holds the question open until two witnesses agree", () => {
    const learner = new WholePixelQuantizationLearner();
    expect(learner.verdict).toBeUndefined();
    learner.observe(100.4, 100);
    expect(learner.verdict).toBeUndefined();
    learner.observe(220.4, 220);
    expect(learner.verdict).toBe(true);
  });

  it("negative control: a display that keeps the fraction settles the other way", () => {
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

  it("settles after however many witnesses it was built to want", () => {
    const learner = new WholePixelQuantizationLearner(1);
    learner.observe(100.4, 100);
    expect(learner.verdict).toBe(true);
  });
});
