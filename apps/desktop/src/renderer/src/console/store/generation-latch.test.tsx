// One act at a time, and what a superseded reply is allowed to do.
//
// The register is driven directly rather than through a stand-in, because the whole
// value of hoisting it is that the PREDICATE is written once — a test that reproduced
// the predicate would agree with a drifted copy as readily as with a correct one.
//
// The bound is asserted, not argued. A latch that never removed a settled key would
// pass every correctness case here and grow one entry per dispatch for the life of a
// bridge, which on a long session is the leak the endurance tier exists to catch.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { GenerationLatch, useGenerationLatch } from "./generation-latch.js";

const SUBJECT_ONE = { name: "subject one" };
const SUBJECT_TWO = { name: "subject two" };

describe("GenerationLatch — single flight, per subject and per key", () => {
  it("admits the first claim on a key and refuses the second", () => {
    const latch = new GenerationLatch();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeUndefined();
  });

  it("holds each key and each subject apart", () => {
    const latch = new GenerationLatch();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
    expect(latch.claim(SUBJECT_ONE, "detach")).toBeDefined();
    expect(latch.claim(SUBJECT_TWO, "compact")).toBeDefined();
  });

  it("admits a key again once the claim that held it releases", () => {
    const latch = new GenerationLatch();
    const claim = latch.claim(SUBJECT_ONE, "compact");
    claim?.release();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
  });

  it("runs a settlement while the claim is current and answers that it ran", () => {
    const latch = new GenerationLatch();
    const claim = latch.claim(SUBJECT_ONE, "compact");
    let applied = 0;
    expect(
      claim?.settle(() => {
        applied += 1;
      }),
    ).toBe(true);
    expect(applied).toBe(1);
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

  it("negative control: those same claims settle when nothing supersedes them", () => {
    // Without this, "dropped" above would be satisfied by a claim that never settles.
    const latch = new GenerationLatch();
    const onSubjectOne = latch.claim(SUBJECT_ONE, "compact");
    const onSubjectTwo = latch.claim(SUBJECT_TWO, "detach");
    expect(onSubjectOne?.settle(() => undefined)).toBe(true);
    expect(onSubjectTwo?.settle(() => undefined)).toBe(true);
  });

  it("never lets an abandoned claim release the key a later one holds", () => {
    // The defect the serial exists for: an earlier press's cleanup ran an
    // unconditional delete and freed a call that was still in flight, so a second
    // press dispatched a duplicate.
    const latch = new GenerationLatch();
    const abandoned = latch.claim(SUBJECT_ONE, "compact");
    latch.supersede(SUBJECT_ONE, "compact");
    const live = latch.claim(SUBJECT_ONE, "compact");
    abandoned?.release();
    expect(live?.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeUndefined();
  });

  it("reissues no serial, so a re-claimed key never revives an abandoned settlement", () => {
    const latch = new GenerationLatch();
    const abandoned = latch.claim(SUBJECT_ONE, "compact");
    latch.supersedeAll();
    latch.claim(SUBJECT_ONE, "compact");
    expect(abandoned?.settle(() => undefined)).toBe(false);
  });

  it("is not terminal: the register works again after a teardown superseded it", () => {
    // React invokes an effect's cleanup between the two invocations strict mode makes
    // of one effect. A latch killed by its own teardown would be dead for the rest of
    // the mount's life.
    const latch = new GenerationLatch();
    latch.supersedeAll();
    latch.supersedeAll();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
  });

  it("settles without releasing, so a control may stay closed past its answer", () => {
    const latch = new GenerationLatch();
    const claim = latch.claim(SUBJECT_ONE, "compact");
    claim?.settle(() => undefined);
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeUndefined();
    claim?.release();
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
  });

  it("is idempotent on both terminal acts", () => {
    const latch = new GenerationLatch();
    const claim = latch.claim(SUBJECT_ONE, "compact");
    claim?.release();
    claim?.release();
    latch.supersede(SUBJECT_ONE, "compact");
    latch.supersede(SUBJECT_ONE, "never-claimed");
    expect(latch.claim(SUBJECT_ONE, "compact")).toBeDefined();
  });
});

describe("GenerationLatch — supersedeAndClaim, for the write whose newest intent wins", () => {
  it("admits every caller, including one whose key is already held", () => {
    const latch = new GenerationLatch();
    expect(latch.claim(SUBJECT_ONE, "goal")).toBeDefined();
    expect(latch.supersedeAndClaim(SUBJECT_ONE, "goal")).toBeDefined();
    expect(latch.supersedeAndClaim(SUBJECT_ONE, "goal")).toBeDefined();
  });

  it("negative control: the refusing form still refuses that same held key", () => {
    // Without this, "admits every caller" would be satisfied by a register that had
    // stopped holding anything at all.
    const latch = new GenerationLatch();
    latch.supersedeAndClaim(SUBJECT_ONE, "goal");
    expect(latch.claim(SUBJECT_ONE, "goal")).toBeUndefined();
  });

  it("drops the settlement of the act it displaced", () => {
    // The whole point of superseding rather than queueing: the older write installs
    // nothing, so a reply that overtakes the newer one cannot be shown as the answer.
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

  it("never lets the displaced act release the key its successor holds", () => {
    const latch = new GenerationLatch();
    const displaced = latch.claim(SUBJECT_ONE, "goal");
    const admitted = latch.supersedeAndClaim(SUBJECT_ONE, "goal");
    displaced?.release();
    expect(admitted.isCurrent).toBe(true);
    expect(latch.claim(SUBJECT_ONE, "goal")).toBeUndefined();
  });

  it("leaves the key free once the admitted act releases it", () => {
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "goal");
    latch.supersedeAndClaim(SUBJECT_ONE, "goal").release();
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
  });

  it("holds one entry however many times one key is superseded", () => {
    const latch = new GenerationLatch();
    for (let write = 0; write < 1000; write += 1) {
      latch.supersedeAndClaim(SUBJECT_ONE, "goal");
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1);
  });
});

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

  it("holds one entry however many readers join one round", () => {
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "preferences");
    for (let read = 0; read < 1000; read += 1) {
      latch.currentClaim(SUBJECT_ONE, "preferences");
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1);
  });
});

describe("GenerationLatch — the register is bounded", () => {
  it("holds nothing for a subject once every key is released", () => {
    const latch = new GenerationLatch();
    for (let dispatch = 0; dispatch < 1000; dispatch += 1) {
      const claim = latch.claim(SUBJECT_ONE, `run-${String(dispatch)}`);
      claim?.settle(() => undefined);
      claim?.release();
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
  });

  it("holds nothing for a subject once its keys are superseded", () => {
    const latch = new GenerationLatch();
    for (let dispatch = 0; dispatch < 1000; dispatch += 1) {
      latch.claim(SUBJECT_ONE, `run-${String(dispatch)}`);
      latch.supersede(SUBJECT_ONE, `run-${String(dispatch)}`);
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
  });

  it("negative control: unreleased keys do accumulate, so the counter is real", () => {
    const latch = new GenerationLatch();
    for (let dispatch = 0; dispatch < 1000; dispatch += 1) {
      latch.claim(SUBJECT_ONE, `run-${String(dispatch)}`);
    }
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(1000);
    latch.supersedeAll();
    expect(latch.heldKeyCount(SUBJECT_ONE)).toBe(0);
  });
});

interface LatchProbeProps {
  readonly onReady: (latch: GenerationLatch) => void;
}

function LatchProbe(props: LatchProbeProps): ReactElement {
  props.onReady(useGenerationLatch());
  return <output>latched</output>;
}

describe("useGenerationLatch — one register per mount", () => {
  it("supersedes every outstanding claim when the surface unmounts", () => {
    let latch: GenerationLatch | undefined;
    const view = render(
      <LatchProbe
        onReady={(mounted) => {
          latch = mounted;
        }}
      />,
    );
    const claim = latch?.claim(SUBJECT_ONE, "compact");
    expect(claim?.isCurrent).toBe(true);
    act(() => {
      view.unmount();
    });
    expect(claim?.isCurrent).toBe(false);
    expect(claim?.settle(() => undefined)).toBe(false);
  });

  it("hands a second mount a register the first one's claims cannot reach", () => {
    let firstLatch: GenerationLatch | undefined;
    let secondLatch: GenerationLatch | undefined;
    const first = render(
      <LatchProbe
        onReady={(mounted) => {
          firstLatch = mounted;
        }}
      />,
    );
    const abandoned = firstLatch?.claim(SUBJECT_ONE, "compact");
    act(() => {
      first.unmount();
    });
    render(
      <LatchProbe
        onReady={(mounted) => {
          secondLatch = mounted;
        }}
      />,
    );
    expect(secondLatch).not.toBe(firstLatch);
    expect(secondLatch?.claim(SUBJECT_ONE, "compact")).toBeDefined();
    expect(abandoned?.settle(() => undefined)).toBe(false);
  });
});
