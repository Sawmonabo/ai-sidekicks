// One act at a time, and what a superseded reply is allowed to do. The register is driven
// directly, since a test that reproduced the predicate would agree with a drifted copy. What a
// reader that joins a round it did not start (`currentClaim`) may do is at the end.

import { describe, expect, it } from "vitest";

import { GenerationLatch } from "./generation-latch.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "@test/helpers/subject-fixtures.js";

describe("GenerationLatch — single flight, per subject and per key", () => {
  it("refuses a second claim on a held key and admits it again once released", () => {
    const latch = new GenerationLatch();
    const claim = latch.claim(SUBJECT_ONE, "compact");
    expect(claim).toBeDefined();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeUndefined();
    claim?.release();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
  });

  it("drops a settlement whose key was superseded, and frees the key", () => {
    const latch = new GenerationLatch();
    const claim = latch.claim(SUBJECT_ONE, "compact");
    latch.supersede(SUBJECT_ONE, "compact");
    let applied = 0;
    expect(
      claim?.settle(() => {
        applied += 1;
      }),
    ).toBe(false);
    expect(applied).toBe(0);
    expect(claim?.isCurrent).toBe(false);
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
  });

  it("drops every outstanding settlement when the whole register is superseded", () => {
    const latch = new GenerationLatch();
    const onSubjectOne = latch.claim(SUBJECT_ONE, "compact");
    const onSubjectTwo = latch.claim(SUBJECT_TWO, "detach");
    latch.supersedeAll();
    expect(onSubjectOne?.settle(() => undefined)).toBe(false);
    expect(onSubjectTwo?.settle(() => undefined)).toBe(false);
  });

  it("never lets an abandoned claim release the key a later one holds", () => {
    // The serial exists because an earlier press's cleanup once deleted unconditionally and freed a
    // call still in flight, so a second press dispatched a duplicate.
    const latch = new GenerationLatch();
    const abandoned = latch.claim(SUBJECT_ONE, "compact");
    latch.supersede(SUBJECT_ONE, "compact");
    const live = latch.claim(SUBJECT_ONE, "compact");
    abandoned?.release();
    expect(live?.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeUndefined();
  });
});

describe("GenerationLatch — supersedeAndClaim, for the write whose newest intent wins", () => {
  it("drops the settlement of the act it displaced", () => {
    // Superseding rather than queueing: the older write installs nothing, so an overtaking reply
    // cannot be shown as the answer.
    const latch = new GenerationLatch();
    const displaced = latch.claim(SUBJECT_ONE, "goal");
    const admitted = latch.supersedeAndClaim(SUBJECT_ONE, "goal");
    let applied = 0;
    expect(
      displaced?.settle(() => {
        applied += 1;
      }),
    ).toBe(false);
    expect(displaced?.isCurrent).toBe(false);
    expect(
      admitted.settle(() => {
        applied += 1;
      }),
    ).toBe(true);
    expect(applied).toBe(1);
  });
});

describe("GenerationLatch — asking whether a key is held, without taking it", () => {
  it("answers for a free key and for a held one, and takes nothing asking", () => {
    // A caller that must refuse because the key is held has to ask without consuming the answer.
    const latch = new GenerationLatch();
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(false);
    expect(latch.claim(SUBJECT_ONE, "retry")).toBeDefined();
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(true);
  });
});

describe("GenerationLatch — currentClaim, for the reader that joins the round", () => {
  it("joins the live round rather than superseding it", () => {
    // Both handles name one round: the claim that took the key is current, and the joined handle
    // settles through it.
    const latch = new GenerationLatch();
    const started = latch.claim(SUBJECT_ONE, "preferences");
    const joined = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(started?.isCurrent).toBe(true);
    expect(joined.isCurrent).toBe(true);
    expect(joined.settle(() => undefined)).toBe(true);
    expect(latch.isHeld(SUBJECT_ONE, "preferences")).toBe(true);
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

  it("leaves the write that took the key holding it after the joiner settles", () => {
    const latch = new GenerationLatch();
    const write = latch.claim(SUBJECT_ONE, "preferences");
    const joined = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(joined.settle(() => undefined)).toBe(true);
    expect(write?.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeUndefined();
    // Control: the taker's own release does free it, so the claim above is about who may give the
    // key back.
    write?.release();
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeDefined();
  });

  it("ends a round it minted on a free key when that round settles", () => {
    // Nobody else took this key, so nobody else can give it back; a read-only handle would hold it
    // for the life of the subject.
    const latch = new GenerationLatch();
    const minted = latch.currentClaim(SUBJECT_ONE, "preferences");
    expect(latch.claim(SUBJECT_ONE, "preferences")).toBeUndefined();
    expect(minted.settle(() => undefined)).toBe(true);
    expect(latch.isHeld(SUBJECT_ONE, "preferences")).toBe(false);
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
    expect(latch.isHeld(SUBJECT_ONE, "preferences")).toBe(false);
  });
});
