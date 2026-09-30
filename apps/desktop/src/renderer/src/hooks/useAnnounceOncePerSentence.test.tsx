// The sentence, said once and not again on the next render.
//
// Driven through the real announcer over a manual clock rather than a spy: the claim is about
// the console's one pair of regions, and a stand-in would prove only this file's arithmetic.

import { describe, expect, it } from "vitest";

import { useAnnounceOncePerSentence } from "./useAnnounceOncePerSentence.js";
import { renderThroughAnnouncer } from "./useAnnounceOncePerSentence.test-support.js";

describe("useAnnounceOncePerSentence — the two arms of the latch's memory", () => {
  function LatchedAnnouncement(props: { readonly sentences: readonly string[] | undefined }): null {
    useAnnounceOncePerSentence(props.sentences);
    return null;
  }

  /** The latch driven directly, over the same announcer on the same frozen clock. */
  function renderLatched(sentences: readonly string[] | undefined): {
    readonly polite: () => string;
    readonly rerender: (next: readonly string[] | undefined) => void;
    readonly settle: () => void;
  } {
    const mounted = renderThroughAnnouncer(LatchedAnnouncement, { sentences });
    return {
      ...mounted,
      rerender: (next) => {
        mounted.rerender({ sentences: next });
      },
    };
  }

  it("forgets a sentence an empty pass dropped, and says it again when it returns", () => {
    // The set arity's rule, and why a reading's caller hands over `[]` rather than nothing
    // when a reading completes: an empty pass is the positive claim that nothing is
    // incomplete, so a reading that goes back to incomplete after serving is a second, real
    // announcement.
    const announced = renderLatched(["Two deliveries could not be read."]);
    expect(announced.polite()).toBe("Two deliveries could not be read.");
    announced.settle();

    announced.rerender([]);
    announced.settle();
    expect(announced.polite()).toBe("");

    announced.rerender(["Two deliveries could not be read."]);
    expect(announced.polite()).toBe("Two deliveries could not be read.");
  });

  it("negative control: holds a sentence across a pass that makes no claim at all", () => {
    // The scalar arity's rule; it fails the moment `undefined` is folded into `[]`. A read
    // that has not settled is not a read that settled to nothing, so its pass forgets
    // nothing; otherwise one settlement is audible twice.
    const announced = renderLatched(["Four mounts were read."]);
    expect(announced.polite()).toBe("Four mounts were read.");
    announced.settle();

    announced.rerender(undefined);
    announced.settle();
    expect(announced.polite()).toBe("");

    announced.rerender(["Four mounts were read."]);
    expect(announced.polite()).toBe("");
  });
});
