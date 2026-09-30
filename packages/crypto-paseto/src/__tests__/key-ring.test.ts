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

  it("throws InvalidKeyError when constructed with more than one active entry", () => {
    expect(() => new KeyRing([entry("k_a"), entry("k_b")])).toThrow(InvalidKeyError);
  });

  it("byId returns retired entries", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1");
    const ring = new KeyRing([retired, active]);
    expect(ring.byId("k_0")?.id).toBe("k_0");
    expect(ring.byId("k_0")?.retiredAt).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("rotate returns a new instance with the prior active entry retired; prior instance is unchanged", () => {
    const ring1 = new KeyRing([entry("k_1")]);
    const next = entry("k_2");
    const ring2 = ring1.rotate(next);
    expect(ring2).not.toBe(ring1);
    expect(ring1.active().id).toBe("k_1"); // unchanged
    expect(ring2.active().id).toBe("k_2");
    const retired = ring2.byId("k_1");
    expect(retired?.retiredAt).toBeInstanceOf(Date);
  });

  it("throws InvalidKeyError when constructor receives duplicate ids (one active, one retired)", () => {
    const retired = entry("k_1", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1"); // same id, active
    expect(() => new KeyRing([retired, active])).toThrow(InvalidKeyError);
  });

  // `readonly` does not stop a caller writing to `entry.key[0]` or `entry.createdAt.setTime()`, so
  // the constructor deep-clones each entry.
  it("isolates the ring from post-construction mutation of caller-owned entries", () => {
    const original = entry("k_1");
    const originalFirstByte = original.key[0];
    const originalCreatedAt = original.createdAt.getTime();
    const ring = new KeyRing([original]);

    // Mutate the caller's reference after construction.
    original.key[0] = (originalFirstByte! + 1) & 0xff;
    original.createdAt.setTime(0);

    // Ring state must be unchanged.
    const active = ring.active();
    expect(active.key[0]).toBe(originalFirstByte);
    expect(active.createdAt.getTime()).toBe(originalCreatedAt);
  });

  // Accessors must also clone on the way out: a shared reference would let a caller change
  // `retiredAt` and break the "exactly one active" invariant, or change key bytes. `readonly` is
  // type-only, so these tests cast via `MutableEntry` to write through the returned value.
  type MutableEntry = { -readonly [K in keyof KeyRingEntry]: KeyRingEntry[K] };

  it("isolates the ring from mutation of values returned by active()", () => {
    const original = entry("k_1");
    const originalFirstByte = original.key[0];
    const ring = new KeyRing([original]);

    // Mutate the returned entry after the accessor call.
    const first = ring.active();
    first.key[0] = (originalFirstByte! + 1) & 0xff;
    (first as MutableEntry).retiredAt = new Date("2026-01-01T00:00:00Z");

    // Ring state must be unchanged on the next accessor call.
    const second = ring.active();
    expect(second.key[0]).toBe(originalFirstByte);
    expect(second.retiredAt).toBeUndefined();
  });

  it("isolates the ring from mutation of values returned by byId()", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1");
    const ring = new KeyRing([retired, active]);

    const looked = ring.byId("k_0")!;
    const lookedFirstByte = looked.key[0];
    // Mutate the returned entry.
    looked.key[0] = (lookedFirstByte! + 1) & 0xff;
    // Would break "exactly one active" if the ring shared its reference.
    (looked as MutableEntry).retiredAt = undefined;

    // Re-lookup must return an unmutated clone.
    const again = ring.byId("k_0")!;
    expect(again.key[0]).toBe(lookedFirstByte);
    expect(again.retiredAt).toEqual(new Date("2026-04-01T00:00:00Z"));
  });
});
