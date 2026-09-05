// What a reader may do with a round it did not start.
//
// `currentClaim` is the third way into one register, and the only one whose caller
// did not take the key it is asking about. Single flight is the property this object
// exists to supply, so what that caller may do is exactly two things — read whether
// the round is still live, and settle against it — and the register is what proves
// the third is absent: after a joiner is finished, the write that took the key is
// still holding it.
//
// The one round a joiner DOES own is the one it minted on a free key, and its bound
// is asserted rather than argued: a reader that treated the handle as read-only would
// otherwise hold that key for the life of the subject and refuse every later act on
// it, which every correctness case here would still pass.

import { describe, expect, it } from "vitest";

import { GenerationLatch } from "./generation-latch.js";
import { SUBJECT_ONE } from "./subject-fixtures.test-support.js";

describe("GenerationLatch — currentClaim, for the reader that joins the round", () => {
  it("joins the live round rather than superseding it", () => {
    // Both handles name one round: the claim that took the key is still current, and
    // the joined handle settles through it.
    const latch = new GenerationLatch();
    const started = latch.claim(SUBJECT_ONE, "preferences");
    const joined = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(started?.isCurrent).toBe(true);
    expect(joined.isCurrent).toBe(true);
    expect(joined.settle(() => undefined)).toBe(true);
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1);
  });

  it("goes stale with the round it joined, and not on its own", () => {
    const latch = new GenerationLatch();
    const started = latch.claim(SUBJECT_ONE, "preferences");
    const joined = latch.currentClaim(SUBJECT_ONE, "preferences");
    latch.supersede(SUBJECT_ONE, "preferences");
    expect(started?.isCurrent).toBe(false);
    expect(joined.isCurrent).toBe(false);
    expect(joined.settle(() => undefined)).toBe(false);
  });

  it("negative control: superseding one key leaves a round joined on another alone", () => {
    // Without this, "goes stale" above would be satisfied by a handle that reported
    // itself stale from the moment it was minted.
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "preferences");
    const elsewhere = latch.currentClaim(SUBJECT_ONE, "appearance");
    latch.supersede(SUBJECT_ONE, "preferences");
    expect(elsewhere.isCurrent).toBe(true);
    expect(elsewhere.settle(() => undefined)).toBe(true);
  });

  it("mints a round where the key is free, so the caller never handles a refusal", () => {
    const latch = new GenerationLatch();
    const minted = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(minted.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeUndefined();
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1);
  });

  it("answers the round a supersede-and-claim installed, not the one it displaced", () => {
    const latch = new GenerationLatch();
    const displaced = latch.claim(SUBJECT_ONE, "goal");
    latch.supersedeAndClaim(SUBJECT_ONE, "goal");
    const joined = latch.currentClaim(SUBJECT_ONE, "goal");
    expect(displaced?.isCurrent).toBe(false);
    expect(joined.isCurrent).toBe(true);
  });

  it("hands a joiner no way to give back a key it did not take", () => {
    // The type IS the guard, and the control is structural: on a handle that carries
    // `release`, the suppression below is unused and the typecheck fails on TS2578
    // rather than passing quietly. `release()` in the `finally`-shaped position the
    // claim interface invites would delete the key out from under the write still in
    // flight, and the next press would dispatch a duplicate.
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "preferences");
    const joined = latch.currentClaim(SUBJECT_ONE, "preferences");
    // @ts-expect-error TS2339: `release` does not exist on `CurrentGenerationClaim`.
    const release: unknown = joined.release;
    expect(release).toBeUndefined();
  });

  it("leaves the write that took the key holding it after the joiner settles", () => {
    const latch = new GenerationLatch();
    const write = latch.claim(SUBJECT_ONE, "preferences");
    const joined = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(joined.settle(() => undefined)).toBe(true);
    expect(write?.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeUndefined();
    // Negative control: the taker's own release does free it, so the claim above is
    // about WHO may give the key back rather than about a key nothing can free.
    write?.release();
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeDefined();
  });

  it("ends a round it minted on a free key when that round settles", () => {
    // Nobody else took this key, so nobody else can give it back. A reader treating
    // the handle as read-only would otherwise hold it for the life of the subject and
    // refuse every later act on it.
    const latch = new GenerationLatch();
    const minted = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeUndefined();
    expect(minted.settle(() => undefined)).toBe(true);
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeDefined();
  });

  it("frees a minted round's key even when the settlement itself throws", () => {
    const latch = new GenerationLatch();
    const minted = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(() => {
      minted.settle(() => {
        throw new Error("the fold this reader was doing failed");
      });
    }).toThrow(/the fold this reader was doing failed/);
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
  });

  it("never lets a minted round free the key a later act holds", () => {
    // The same rule the taken claims obey: a release is guarded on being current, so
    // a superseded round's settlement gives nothing back.
    const latch = new GenerationLatch();
    const minted = latch.currentClaim(SUBJECT_ONE, "preferences");
    const successor = latch.supersedeAndClaim(SUBJECT_ONE, "preferences");
    expect(minted.settle(() => undefined)).toBe(false);
    expect(successor.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeUndefined();
  });

  it("holds nothing for a subject once every minted round has settled", () => {
    const latch = new GenerationLatch();
    for (let read = 0; read < 1000; read += 1) {
      latch.currentClaim(SUBJECT_ONE, `read-${String(read)}`).settle(() => undefined);
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
  });

  it("negative control: minted rounds that never settle do accumulate", () => {
    // Without this, the bound above would also be satisfied by a `currentClaim` that
    // took no key at all — which is the other way to make the count zero, and the one
    // that would put two writes in flight on one key.
    const latch = new GenerationLatch();
    for (let read = 0; read < 1000; read += 1) {
      latch.currentClaim(SUBJECT_ONE, `read-${String(read)}`);
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1000);
  });

  it("holds one entry however many readers join one round", () => {
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "preferences");
    for (let read = 0; read < 1000; read += 1) {
      latch.currentClaim(SUBJECT_ONE, "preferences");
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1);
  });
});
