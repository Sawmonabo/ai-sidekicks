// The scalar rules several contract modules share. Each module's replies parse
// through these one bodies, so loosening one here loosens every reply that uses it.
import { describe, expect, it } from "vitest";

import { composedTextSchema, countSchema, percentSchema } from "../internal/wire-scalars.js";

describe("shared wire scalars", () => {
  it("a count is a whole number, zero or more", () => {
    expect(countSchema.safeParse(0).success).toBe(true);
    expect(countSchema.safeParse(-1).success).toBe(false);
    expect(countSchema.safeParse(1.5).success).toBe(false);
  });

  it("a percent runs from 0 to 100 and may be fractional", () => {
    expect(percentSchema.safeParse(96.7).success).toBe(true);
    expect(percentSchema.safeParse(100).success).toBe(true);
    expect(percentSchema.safeParse(100.1).success).toBe(false);
    expect(percentSchema.safeParse(-0.1).success).toBe(false);
  });

  it("composed text is never empty", () => {
    expect(composedTextSchema.safeParse("a").success).toBe(true);
    expect(composedTextSchema.safeParse("").success).toBe(false);
  });
});
