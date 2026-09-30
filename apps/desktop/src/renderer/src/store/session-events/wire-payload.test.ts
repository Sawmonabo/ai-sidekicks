// Reading a member off an open payload, and refusing to coerce one that is not there. The
// string rule is tested beside `lib/wire-strings.ts`; this covers the count's range check and
// the arm the projection answers an empty record for.

import { describe, expect, it } from "vitest";

import { readWireString } from "@renderer/lib/wire-strings.js";
import { sampleRunRow } from "@test/helpers/timeline-row-samples.js";
import { projectedPayload, readWireCount } from "./wire-payload.js";

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
    expect(readWireString(projectedPayload(row)["toolName"])).toBe("Bash");
  });

  it("negative control: reading it twice yields the same object, not a copy", () => {
    // A reader that spread the payload would pass the cases above and break memoized callers.
    const row = sampleRunRow({ payload: { toolName: "Bash" } });
    expect(projectedPayload(row)).toBe(projectedPayload(row));
  });
});
