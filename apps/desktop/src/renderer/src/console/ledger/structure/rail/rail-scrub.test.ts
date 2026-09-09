// The drag gesture's own cases, driven against the real class.

import { describe, expect, it } from "vitest";

import { RailScrub } from "./rail-scrub.js";
import { type RailTick } from "./rail-model.js";

const FIRST_POINTER = 1;
const SECOND_POINTER = 2;

function tickAt(sequence: number): RailTick {
  return {
    kind: "participant-message",
    rowId: `row-${String(sequence)}`,
    sequence,
    timestamp: "2026-09-02T00:00:00.000Z",
    actorId: undefined,
    tone: "actor",
    glyph: "member",
    summary: `mark ${String(sequence)}`,
    position: sequence / 10,
  };
}

describe("RailScrub", () => {
  it("reports nothing before a press", () => {
    const scrub = new RailScrub();
    expect(scrub.isScrubbing).toBe(false);
    // The negative control for every case below: without the press, the same call
    // that delivers a mark delivers none.
    expect(scrub.crossedTo(tickAt(3))).toBeUndefined();
  });

  it("delivers a mark once per crossing", () => {
    const scrub = new RailScrub();
    expect(scrub.begin(FIRST_POINTER)).toBe(true);
    expect(scrub.crossedTo(tickAt(3))?.sequence).toBe(3);
    expect(scrub.crossedTo(tickAt(3))).toBeUndefined();
    expect(scrub.crossedTo(tickAt(4))?.sequence).toBe(4);
    expect(scrub.crossedTo(tickAt(3))?.sequence).toBe(3);
  });

  it("delivers nothing where the pointer is over no mark", () => {
    const scrub = new RailScrub();
    scrub.begin(FIRST_POINTER);
    expect(scrub.crossedTo(undefined)).toBeUndefined();
  });

  it("refuses a second pointer rather than adopting it", () => {
    const scrub = new RailScrub();
    expect(scrub.begin(FIRST_POINTER)).toBe(true);
    expect(scrub.begin(SECOND_POINTER)).toBe(false);
    // And the second pointer's release does not end the first's gesture.
    scrub.end(SECOND_POINTER);
    expect(scrub.isScrubbing).toBe(true);
    scrub.end(FIRST_POINTER);
    expect(scrub.isScrubbing).toBe(false);
  });

  it("consumes exactly one click after a release", () => {
    const scrub = new RailScrub();
    scrub.begin(FIRST_POINTER);
    scrub.end(FIRST_POINTER);
    expect(scrub.takeSynthesizedClick()).toBe(true);
    expect(scrub.takeSynthesizedClick()).toBe(false);
  });

  it("owes the click nothing after a cancel", () => {
    // A cancelled pointer synthesizes no click, so a debt here would swallow the
    // next real one.
    const scrub = new RailScrub();
    scrub.begin(FIRST_POINTER);
    scrub.cancel(FIRST_POINTER);
    expect(scrub.isScrubbing).toBe(false);
    expect(scrub.takeSynthesizedClick()).toBe(false);
  });

  it("starts each gesture with no mark delivered", () => {
    const scrub = new RailScrub();
    scrub.begin(FIRST_POINTER);
    expect(scrub.crossedTo(tickAt(7))?.sequence).toBe(7);
    scrub.end(FIRST_POINTER);
    scrub.begin(FIRST_POINTER);
    expect(scrub.crossedTo(tickAt(7))?.sequence).toBe(7);
  });
});
