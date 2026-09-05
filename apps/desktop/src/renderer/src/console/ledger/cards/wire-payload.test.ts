// Reading a member off an open payload — and refusing to coerce one that is not there.

import { describe, expect, it } from "vitest";

import { sampleRunRow } from "./row-samples.test-support.js";
import { projectedPayload, readWireCount, readWireString } from "./wire-payload.js";

describe("reading a string member", () => {
  it("returns the member when it is a non-empty string", () => {
    expect(readWireString({ toolName: "Bash" }, "toolName")).toBe("Bash");
  });

  it("returns nothing for an absent, empty, or wrongly-typed member", () => {
    expect(readWireString({}, "toolName")).toBeUndefined();
    expect(readWireString({ toolName: "" }, "toolName")).toBeUndefined();
    expect(readWireString({ toolName: 7 }, "toolName")).toBeUndefined();
    expect(readWireString({ toolName: { name: "Bash" } }, "toolName")).toBeUndefined();
  });

  it("negative control: it never coerces", () => {
    // `String({})` is "[object Object]", which would reach the screen as a tool name.
    expect(readWireString({ toolName: {} }, "toolName")).not.toBe("[object Object]");
  });
});

describe("reading a count member", () => {
  it("accepts a finite non-negative number, including zero", () => {
    expect(readWireCount({ durationMs: 0 }, "durationMs")).toBe(0);
    expect(readWireCount({ durationMs: 1250 }, "durationMs")).toBe(1250);
  });

  it("refuses a negative, infinite, or non-numeric member", () => {
    expect(readWireCount({ durationMs: -1 }, "durationMs")).toBeUndefined();
    expect(readWireCount({ durationMs: Number.POSITIVE_INFINITY }, "durationMs")).toBeUndefined();
    expect(readWireCount({ durationMs: Number.NaN }, "durationMs")).toBeUndefined();
    expect(readWireCount({ durationMs: "1250" }, "durationMs")).toBeUndefined();
  });
});

describe("the projected payload", () => {
  it("is the row's own payload on an open arm", () => {
    const row = sampleRunRow({ payload: { toolName: "Bash" } });
    expect(readWireString(projectedPayload(row), "toolName")).toBe("Bash");
  });

  it("negative control: reading it twice yields the same object, not a copy", () => {
    // A reader that rebuilt or spread the payload would pass every case above and
    // hand a memoizing caller a new identity on every render.
    const row = sampleRunRow({ payload: { toolName: "Bash" } });
    expect(projectedPayload(row)).toBe(projectedPayload(row));
  });
});
