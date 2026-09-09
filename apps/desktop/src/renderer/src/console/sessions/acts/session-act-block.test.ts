// The shell arm of the destination's act block, which nothing asserted.
//
// `session-list-degradation.test.ts` next door covers the PROJECTION arm — what the
// sentences say per standing degraded cause — and that is a different fact from this
// one: a degraded projection is a session store reporting that what is on screen may be
// stale, while a supervisor that is not serving is this window reporting that no call
// can leave it. The fold puts the shell first, and until this file there was no case
// that would notice if it stopped doing so.
//
// THE DEFECT THE GAP ADMITTED, stated so a reader can see what these two cases buy: a
// change that read `degradedCause` first and the shell block second would leave the
// start control closed after the runtime came back, because the projection's cause
// outlives the outage that produced it. Every suite in the tree would still have passed.
//
// `reconnecting` RATHER THAN `stopped`, and that is the point of the arm. Its sentence
// carries the attempt and the limit, so a surface that composed its own wording would
// satisfy a `stopped` case and still be wrong here — which is why the expected value
// below is read off `shellMutationBlock` and never typed out.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { shellMutationBlock, type FrameStore } from "../../store/index.js";
import {
  connectedShell,
  quietShell,
  reconnectingShell,
} from "../../store/shell-condition.test-support.js";
import { useSessionActBlock, type SessionActBlock } from "./session-act-block.js";

/** The fold, over one shell condition and a projection with nothing standing on it. */
function blockFor(frameStore: FrameStore): SessionActBlock {
  const { result } = renderHook(() =>
    useSessionActBlock({
      frameStore,
      degradedCause: undefined,
      readDegradedCause: () => undefined,
      startOutstandingSentence: undefined,
    }),
  );
  return result.current;
}

/** The sentence the block itself carries, read off the store rather than retyped. */
function blockSentence(frameStore: FrameStore): string {
  const block = shellMutationBlock(frameStore.getState().shellState);
  if (block === undefined) {
    throw new Error("the reconnecting shell produced no block to read a sentence off");
  }
  return block.detail;
}

describe("the composer's send under a supervisor that is not serving", () => {
  it("closes the start control with the block's own sentence while reconnecting", () => {
    const frameStore = reconnectingShell();

    const block = blockFor(frameStore);

    expect(block.startBlockedSentence).toBe(blockSentence(frameStore));
    // The whole-destination sentence and the start-specific one are the same value
    // here, which is the fold's own rule: a window that cannot reach the runtime
    // cannot put ANY act, so the narrower control is not offered a softer reason.
    expect(block.act.sentence).toBe(blockSentence(frameStore));
  });

  it("re-opens it the moment the supervisor reports the runtime connected", () => {
    const block = blockFor(connectedShell());

    // THE HALF A STALE PROJECTION WOULD BREAK. Nothing standing and the runtime
    // serving is the state that must close nothing at all — an outage that ended and
    // left a control shut is invisible to every case that only drives the outage.
    expect(block.startBlockedSentence).toBeUndefined();
    expect(block.act.sentence).toBeUndefined();
  });

  it("closes nothing while the supervisor has reported nothing at all", () => {
    // Silence is not an outage: a window whose supervisor has not spoken yet offers
    // its acts, and the door refuses one if the runtime turns out not to be there.
    const block = blockFor(quietShell());

    expect(block.startBlockedSentence).toBeUndefined();
    expect(block.act.sentence).toBeUndefined();
  });
});
