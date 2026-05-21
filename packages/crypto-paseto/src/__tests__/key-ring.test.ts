import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { KeyRing, type KeyRingEntry } from "../key-ring.js";
import { InvalidKeyError } from "../errors.js";

function entry(id: string, retiredAt?: Date): KeyRingEntry {
  return {
    id,
    key: randomBytes(32),
    createdAt: new Date("2026-05-01T00:00:00Z"),
    retiredAt,
  };
}

describe("KeyRing", () => {
  it("constructs with exactly one active entry", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(ring.active().id).toBe("k_1");
  });

  it("constructs with multiple entries when only one is active", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1");
    const ring = new KeyRing([retired, active]);
    expect(ring.active().id).toBe("k_1");
  });

  it("throws InvalidKeyError when constructed with zero active entries", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    expect(() => new KeyRing([retired])).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError when constructed with no entries at all", () => {
    expect(() => new KeyRing([])).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError when constructed with more than one active entry", () => {
    expect(() => new KeyRing([entry("k_a"), entry("k_b")])).toThrow(InvalidKeyError);
  });

  it("byId returns active entries", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(ring.byId("k_1")?.id).toBe("k_1");
  });

  it("byId returns retired entries", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1");
    const ring = new KeyRing([retired, active]);
    expect(ring.byId("k_0")?.id).toBe("k_0");
    expect(ring.byId("k_0")?.retiredAt).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("byId returns undefined for unknown id", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(ring.byId("k_missing")).toBeUndefined();
  });

  it("rotate returns a new instance; prior instance is unchanged", () => {
    const ring1 = new KeyRing([entry("k_1")]);
    const next = entry("k_2");
    const ring2 = ring1.rotate(next);
    expect(ring2).not.toBe(ring1);
    expect(ring1.active().id).toBe("k_1"); // unchanged
    expect(ring2.active().id).toBe("k_2");
  });

  it("rotate retires the prior active entry in the new instance", () => {
    const ring1 = new KeyRing([entry("k_1")]);
    const ring2 = ring1.rotate(entry("k_2"));
    const retired = ring2.byId("k_1");
    expect(retired?.retiredAt).toBeInstanceOf(Date);
  });

  it("rotate refuses a `next` that is already retired", () => {
    const ring = new KeyRing([entry("k_1")]);
    const retiredNext = entry("k_2", new Date("2026-04-01T00:00:00Z"));
    expect(() => ring.rotate(retiredNext)).toThrow(InvalidKeyError);
  });

  it("rotate refuses a `next` whose id collides with an existing entry", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(() => ring.rotate(entry("k_1"))).toThrow(InvalidKeyError);
  });
});
