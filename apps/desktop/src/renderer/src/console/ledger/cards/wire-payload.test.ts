// Reading a member off an open payload — and refusing to coerce one that is not there.
//
// The string rule itself is `core/wire-strings.ts`' and is tested beside it; what is
// left here is the count's range check and the arm the projection answers an empty
// record for. The one case that still reads a string does so through the core
// predicate, because what it is claiming is about the PROJECTION and not the read.

import { describe, expect, it } from "vitest";

import { readWireString } from "../../core/index.js";
import { sampleRunRow } from "./row-samples.test-support.js";
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
    // A reader that rebuilt or spread the payload would pass every case above and
    // hand a memoizing caller a new identity on every render.
    const row = sampleRunRow({ payload: { toolName: "Bash" } });
    expect(projectedPayload(row)).toBe(projectedPayload(row));
  });
});
