// The three admissions, each with the case that must NOT refuse beside it.
//
// A ceiling check that refused everything would pass a test asserting only that the
// over-bound value refuses, so every case below is a pair: the value at the ceiling is
// admitted and the value past it is refused. That pairing is the negative control
// `apps/desktop/AGENTS.md` requires of a clean result, applied per bound rather than
// once for the module.
//
// NO NUMBER IS WRITTEN HERE. Every case reads its ceiling out of `BROWSER_BOUNDS` and
// drives the admission at that value and one past it, so the cases stay true when a
// bound is re-derived and a copied threshold cannot drift from the table. What IS
// asserted about the sentence is that it names the constant — which is 12.10's actual
// requirement — rather than the exact prose, which would make every wording change a
// test change.

import { describe, expect, it } from "vitest";

import {
  BROWSER_BOUND_REFUSAL_CODE,
  BROWSER_BOUND_REFUSAL_ORIGIN,
  BROWSER_BYTE_BOUND_NAMES,
  admitByteLength,
  admitAnotherPage,
  admitFullPageCapture,
} from "./bound-enforcement.js";
import {
  BROWSER_BOUNDS,
  BROWSER_SCALAR_UNIT_BYTE_QUALIFIER,
  type BrowserBoundName,
} from "./browser-bounds.js";

/** The scalar value a case drives against, or a failure naming the row that moved. */
function scalarBoundValue(name: BrowserBoundName): number {
  const measure = BROWSER_BOUNDS[name].measure;
  if (measure.kind !== "scalar") {
    throw new Error(`${name} is no longer a scalar bound, so this case drives nothing`);
  }
  return measure.value;
}

describe("the session page cap", () => {
  it("admits one more page below the cap", () => {
    expect(admitAnotherPage(scalarBoundValue("PAGES_PER_SESSION_MAX") - 1)).toBeUndefined();
  });

  it("refuses at the cap, naming the constant and the current count", () => {
    const cap = scalarBoundValue("PAGES_PER_SESSION_MAX");
    const refusal = admitAnotherPage(cap);
    expect(refusal?.code).toBe(BROWSER_BOUND_REFUSAL_CODE);
    expect(refusal?.origin).toBe(BROWSER_BOUND_REFUSAL_ORIGIN);
    expect(refusal?.detail).toContain("PAGES_PER_SESSION_MAX");
    expect(refusal?.detail).toContain(String(cap));
  });
});

describe("the full-page capture extent", () => {
  it("admits a box at the ceiling in both dimensions", () => {
    const measure = BROWSER_BOUNDS.FULL_PAGE_CAPTURE_MAX.measure;
    if (measure.kind !== "extent") {
      throw new Error("FULL_PAGE_CAPTURE_MAX is no longer an extent bound");
    }
    expect(admitFullPageCapture(measure.widthPx, measure.heightPx)).toBeUndefined();
  });

  it("refuses a box over the ceiling in either dimension alone", () => {
    const measure = BROWSER_BOUNDS.FULL_PAGE_CAPTURE_MAX.measure;
    if (measure.kind !== "extent") {
      throw new Error("FULL_PAGE_CAPTURE_MAX is no longer an extent bound");
    }
    const overWidth = admitFullPageCapture(measure.widthPx + 1, measure.heightPx);
    const overHeight = admitFullPageCapture(measure.widthPx, measure.heightPx + 1);
    expect(overWidth?.detail).toContain("FULL_PAGE_CAPTURE_MAX");
    expect(overHeight?.detail).toContain("FULL_PAGE_CAPTURE_MAX");
  });
});

describe("the byte ceilings", () => {
  it("names only scalar bounds measured in bytes", () => {
    // "Measured in bytes" is the block's own question, not a string comparison: the
    // qualifier map is what decides which chokepoint a unit's figure renders through,
    // and `bytes per entry` is a byte unit that spells itself differently.
    for (const name of BROWSER_BYTE_BOUND_NAMES) {
      const measure = BROWSER_BOUNDS[name].measure;
      expect(measure.kind).toBe("scalar");
      if (measure.kind === "scalar") {
        expect(BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[measure.unit]).toBeDefined();
      }
    }
  });

  it("holds every byte-measured bound in the block", () => {
    // The other half of the claim above: a byte bound that lands in the table and
    // never reaches the tuple would leave an admission nobody can make, and the tuple
    // alone cannot report that.
    const byteBoundsInBlock = Object.entries(BROWSER_BOUNDS)
      .filter(
        ([, bound]) =>
          bound.measure.kind === "scalar" &&
          BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[bound.measure.unit] !== undefined,
      )
      .map(([name]) => name)
      .sort();
    expect([...BROWSER_BYTE_BOUND_NAMES].sort()).toStrictEqual(byteBoundsInBlock);
  });

  it("admits a length at each ceiling and refuses one past it", () => {
    for (const name of BROWSER_BYTE_BOUND_NAMES) {
      const ceiling = scalarBoundValue(name);
      expect(admitByteLength(name, ceiling)).toBeUndefined();
      const refusal = admitByteLength(name, ceiling + 1);
      expect(refusal?.code).toBe(BROWSER_BOUND_REFUSAL_CODE);
      expect(refusal?.detail).toContain(name);
    }
  });

  it("does not admit against the ingest pipeline's deferred byte row", () => {
    // The one row the tuple exists to exclude. `CAPTURE_AND_DOWNLOAD_BYTES` is the
    // attachment pipeline's, and an admission here would be the second byte ceiling
    // 12.10 forbids — so it is not assignable, and this is the compile-time proof.
    // @ts-expect-error CAPTURE_AND_DOWNLOAD_BYTES is not a browser byte bound name
    expect(() => admitByteLength("CAPTURE_AND_DOWNLOAD_BYTES", 1)).toBeDefined();
    expect(BROWSER_BOUNDS.CAPTURE_AND_DOWNLOAD_BYTES.measure.kind).toBe("deferred");
  });
});
