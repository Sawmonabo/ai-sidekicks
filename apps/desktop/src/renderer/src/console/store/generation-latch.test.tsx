// One act at a time, and what a superseded reply is allowed to do.
//
// The register is driven directly rather than through a stand-in, because the whole
// value of hoisting it is that the PREDICATE is written once — a test that reproduced
// the predicate would agree with a drifted copy as readily as with a correct one.
//
// What a JOINER may do with a round it did not start is a subject of its own and
// lives in `generation-latch.joined-round.test.ts`, which needs no renderer.
//
// The bound is asserted, not argued. A latch that never removed a settled key would
// pass every correctness case here and grow one entry per dispatch for the life of a
// bridge, which on a long session is the leak the endurance tier exists to catch.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { GenerationLatch, useGenerationLatch } from "./generation-latch.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "./subject-fixtures.test-support.js";

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

describe("GenerationLatch — asking whether a key is held, without taking it", () => {
  it("answers for a free key and for a held one", () => {
    const latch = new GenerationLatch();
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(false);
    latch.claim(SUBJECT_ONE, "retry");
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(true);
  });

  it("takes nothing, so the act it was asking about is still admitted", () => {
    // The whole of it: a caller that must refuse BECAUSE the key is held has to be
    // able to ask when it is free without that question consuming the answer.
    const latch = new GenerationLatch();
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(false);
    expect(latch.claim(SUBJECT_ONE, "retry")).toBeDefined();
  });

  it("negative control: claiming as the predicate refuses the very act it admitted", () => {
    // The shape a caller was left with before this predicate existed. `claim` answers
    // by TAKING, so asking with it holds the key — and the dispatch the caller then
    // makes finds the key held by its own question.
    const latch = new GenerationLatch();
    const askedWithAClaim = latch.claim(SUBJECT_ONE, "retry") === undefined;
    expect(askedWithAClaim).toBe(false);
    expect(latch.claim(SUBJECT_ONE, "retry")).toBeUndefined();
  });

  it("goes back to free on release and on supersede", () => {
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "retry")?.release();
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(false);
    latch.claim(SUBJECT_ONE, "retry");
    latch.supersede(SUBJECT_ONE, "retry");
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(false);
  });

  it("reports a key superseded across the whole register as free", () => {
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "retry");
    latch.supersedeAll();
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(false);
  });

  it("holds each key and each subject apart", () => {
    const latch = new GenerationLatch();
    latch.claim(SUBJECT_ONE, "retry");
    expect(latch.isHeld(SUBJECT_ONE, "abort")).toBe(false);
    expect(latch.isHeld(SUBJECT_TWO, "retry")).toBe(false);
  });

  it("reports a round a joiner minted, which is a key somebody now holds", () => {
    // `currentClaim` mints a round on a free key, so the honest answer afterwards is
    // that the key is held: a caller refusing on held would otherwise offer an act
    // against a round already running.
    const latch = new GenerationLatch();
    latch.currentClaim(SUBJECT_ONE, "retry");
    expect(latch.isHeld(SUBJECT_ONE, "retry")).toBe(true);
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
