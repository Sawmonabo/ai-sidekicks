// The guard is read off the daemon's own closed discriminator. Exhaustiveness is a
// compile-time property of the table; what the cases below state is the half a type cannot:
// that the guard has words and a move of its own, and that a rejection the wire attributed to
// no guard is answered with nothing.

import { describe, expect, it } from "vitest";

import { compositeGuardReading } from "./composite-guard.js";

describe("the user-authored-target guard", () => {
  it("answers a reading that names the guard back, with a refusal and a move", () => {
    const reading = compositeGuardReading("user-authored-target");

    expect(reading?.guard).toBe("user-authored-target");
    expect(reading?.refused.length ?? 0).toBeGreaterThan(20);
    expect(reading?.remedy.length ?? 0).toBeGreaterThan(20);
  });

  it("negative control: a rejection carrying no guard gets no reading", () => {
    // Inventing a nearest guard would tell a person to fix something that is not wrong.
    expect(compositeGuardReading(undefined)).toBeUndefined();
  });
});
