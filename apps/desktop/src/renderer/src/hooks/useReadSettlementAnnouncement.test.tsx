// One announcement per settlement, counted by the settlement's identity.

import { describe, expect, it } from "vitest";

import type { AnnouncementDedupeKey } from "./useAnnounceOncePerSentence.js";
import { renderThroughAnnouncer } from "./useAnnounceOncePerSentence.test-support.js";
import { useReadSettlementAnnouncement } from "./useReadSettlementAnnouncement.js";
import { useSettlementAnnouncement } from "./useSettlementAnnouncement.js";

describe("useReadSettlementAnnouncement — once per settlement, not once per sentence", () => {
  /** Two readings that settled to the same words. What the identity key is for. */
  const IDENTICAL_SENTENCE = "Workflows read: 3 definitions.";

  /**
   * The two things this arity is handed, named as a type rather than inline.
   *
   * The mount's props are inferred from the literal a case passes it, so a case that
   * opens with an absent sentence would fix the whole render at `undefined` and reject
   * the string its second pass supplies — which is the pass the case exists to make.
   */
  interface SettlementAnnouncementProps {
    readonly settlement: AnnouncementDedupeKey | undefined;
    readonly sentence: string | undefined;
  }

  function SettlementAnnouncement(props: SettlementAnnouncementProps): null {
    useReadSettlementAnnouncement(props.settlement, props.sentence);
    return null;
  }

  /** The same words through the SENTENCE-keyed arity, which is the foil below. */
  function SentenceKeyedAnnouncement(props: { readonly sentence: string | undefined }): null {
    useSettlementAnnouncement(props.sentence);
    return null;
  }

  it("speaks the settlement it was handed, in the polite lane", () => {
    const announced = renderThroughAnnouncer<SettlementAnnouncementProps>(SettlementAnnouncement, {
      settlement: { read: "definitions" },
      sentence: IDENTICAL_SENTENCE,
    });
    expect(announced.polite()).toBe(IDENTICAL_SENTENCE);
    // The interrupting lane belongs to a refusal that changed what the whole room can
    // do; a view finishing its own read is news for the person reading it.
    expect(announced.assertive()).toBe("");
  });

  it("says nothing a second time for the settlement it already spoke", () => {
    const settlement = { read: "definitions" };
    const announced = renderThroughAnnouncer<SettlementAnnouncementProps>(SettlementAnnouncement, {
      settlement,
      sentence: IDENTICAL_SENTENCE,
    });
    announced.settle();
    expect(announced.polite()).toBe("");
    // The same object, a fresh render: a parent re-reading and landing on the same arm
    // is not a second settlement.
    announced.rerender({ settlement, sentence: IDENTICAL_SENTENCE });
    expect(announced.polite()).toBe("");
  });

  it("speaks a second settlement that says exactly the same words", () => {
    // The case the settlement-keyed latch exists for, and the reason the key is not the
    // sentence: two sessions holding the same number of rows say the same words, and
    // the second one landing in silence is a view that told nobody it had changed.
    const announced = renderThroughAnnouncer<SettlementAnnouncementProps>(SettlementAnnouncement, {
      settlement: { read: "definitions" },
      sentence: IDENTICAL_SENTENCE,
    });
    announced.settle();
    announced.rerender({ settlement: { read: "definitions" }, sentence: IDENTICAL_SENTENCE });
    expect(announced.polite()).toBe(IDENTICAL_SENTENCE);
  });

  it("negative control: the sentence-keyed arity really does go silent on that pair", () => {
    // Without this the case above could hold because the announcer republishes anything
    // after its hold, rather than because the key decided it. Same two passes, same two
    // settlements, same words — and the arity that counts by the sentence says nothing.
    const announced = renderThroughAnnouncer(SentenceKeyedAnnouncement, {
      sentence: IDENTICAL_SENTENCE,
    });
    announced.settle();
    announced.rerender({ sentence: IDENTICAL_SENTENCE });
    expect(announced.polite()).toBe("");
  });

  it("counts a settled VALUE by its identity too, so a scope change speaks", () => {
    // Not every settlement is an object: the scope this arity was first spent on is a
    // session id, and a different string is a different scope.
    const announced = renderThroughAnnouncer<SettlementAnnouncementProps>(SettlementAnnouncement, {
      settlement: "session-a",
      sentence: "Workflows scoped to session session-a.",
    });
    expect(announced.polite()).toBe("Workflows scoped to session session-a.");
    announced.settle();
    announced.rerender({
      settlement: "session-b",
      sentence: "Workflows scoped to session session-b.",
    });
    expect(announced.polite()).toBe("Workflows scoped to session session-b.");
  });

  it("records an unsettled read as unannounced, so it speaks when it has words", () => {
    // A read that has not settled makes no claim, and holding the settlement as spoken
    // before it had a sentence would skip that settlement forever.
    const settlement = { read: "runs" };
    const announced = renderThroughAnnouncer<SettlementAnnouncementProps>(SettlementAnnouncement, {
      settlement,
      sentence: undefined,
    });
    expect(announced.polite()).toBe("");
    announced.rerender({ settlement, sentence: "Runs read: 2 runs." });
    expect(announced.polite()).toBe("Runs read: 2 runs.");
  });

  it("says nothing for a settlement with no identity to count it by", () => {
    // The scope arm that has settled on no session. Every caller composes no sentence
    // there either, and a sentence said under no identity would speak on every pass.
    const announced = renderThroughAnnouncer<SettlementAnnouncementProps>(SettlementAnnouncement, {
      settlement: undefined,
      sentence: undefined,
    });
    expect(announced.polite()).toBe("");
  });
});
