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
