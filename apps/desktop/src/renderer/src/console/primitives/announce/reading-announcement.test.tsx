// The sentence, said once — and not again on the next render.
//
// Driven through the real announcer over a manual clock rather than a spy, because
// the claim is about the console's one pair of regions and a stand-in would prove
// only this file's own arithmetic.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../../core/index.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { liveRegionText, politeText } from "./live-region.test-support.js";
import { LiveAnnouncerProvider } from "./LiveAnnouncerProvider.js";
import {
  useAnnounceOncePerSentence,
  useReadingAnnouncement,
  useReadSettlementAnnouncement,
  type AnnouncementDedupeKey,
} from "./reading-announcement.js";
import { useSettlementAnnouncement } from "./settlement-announcement.js";
import { uncheckedCoverageReading, type ReadingState } from "../reading/partial-read.js";
import { PARSE_REFUSAL, READING_SUBJECT } from "../reading/partial-read.test-support.js";

/** What one mounted surface hands back, whichever arity of the latch it drives. */
interface AnnouncedRender<SurfaceProps> {
  readonly polite: () => string;
  readonly assertive: () => string;
  readonly rerender: (next: SurfaceProps) => void;
  readonly settle: () => void;
}

/**
 * The window's announcer, and a surface announcing through it.
 *
 * One scaffold for all three arities: the announcer, the provider, the two region
 * readings and the hold are the same for each, and the only thing that differs is the
 * component under it. Written per describe block before the third arity arrived, which
 * is two copies of a mount whose clock and hold have to agree for any of the cases to
 * mean what they say.
 */
function renderThroughAnnouncer<SurfaceProps extends object>(
  Surface: (props: SurfaceProps) => null,
  initialProps: SurfaceProps,
): AnnouncedRender<SurfaceProps> {
  const clock = new ManualClock(0);
  const announcer = new LiveAnnouncer({ clock });
  const mounted = (props: SurfaceProps): React.JSX.Element => (
    <LiveAnnouncerProvider announcer={announcer}>
      <Surface {...props} />
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(mounted(initialProps));
  return {
    polite: () => politeText(container),
    assertive: () => liveRegionText(container, "assertive"),
    rerender: (next) => {
      rerender(mounted(next));
    },
    // Past the announcer's hold, so a second sentence is published rather than
    // queued behind the standing one. The hold is the announcer's own rule and this
    // drives it rather than reaching around it.
    settle: () => {
      act(() => {
        clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      });
    },
  };
}

function AnnouncingSurface(props: { readonly states: readonly ReadingState[] }): null {
  useReadingAnnouncement(props.states, READING_SUBJECT);
  return null;
}

/** The reading arity, mounted over its own announcer. */
function renderAnnouncing(states: readonly ReadingState[]): {
  readonly polite: () => string;
  readonly assertive: () => string;
  readonly rerender: (next: readonly ReadingState[]) => void;
  readonly settle: () => void;
} {
  const mounted = renderThroughAnnouncer(AnnouncingSurface, { states });
  return {
    ...mounted,
    rerender: (next) => {
      mounted.rerender({ states: next });
    },
  };
}

describe("useReadingAnnouncement — the incomplete reading, said out loud", () => {
  it("says nothing at all when every reading served", () => {
    const announced = renderAnnouncing([{ kind: "served" }]);
    expect(announced.polite()).toBe("");
    expect(announced.assertive()).toBe("");
  });

  it("speaks the sentence a person would have read, in the polite lane", () => {
    const announced = renderAnnouncing([
      { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
    ]);
    // The figure travels with its sentence: "3" and "deliveries could not be read"
    // spoken apart are two fragments.
    expect(announced.polite()).toContain("3 deliveries could not be read");
    expect(announced.polite()).toContain(READING_SUBJECT);
    // The assertive lane is for refusals that change what the whole room can do.
    expect(announced.assertive()).toBe("");
  });

  it("says nothing a second time on a re-render", () => {
    const announced = renderAnnouncing([{ kind: "stale", refusal: undefined }]);
    expect(announced.polite()).not.toBe("");
    // Past the hold the announcer clears the lane, so what is in the region after
    // this is what the re-render put there — nothing, if the latch holds.
    announced.settle();
    expect(announced.polite()).toBe("");
    // Same sentence, a fresh array: a caller that maps a store selection hands a new
    // one every render, and none of them is a new thing to say.
    announced.rerender([{ kind: "stale", refusal: undefined }]);
    expect(announced.polite()).toBe("");
  });

  it("negative control: a reading that changes is a second, real announcement", () => {
    // Without this the latch above would also be satisfied by a hook that announced
    // once and never again, which is a surface whose later refusal is silent.
    const announced = renderAnnouncing([{ kind: "stale", refusal: undefined }]);
    announced.settle();
    announced.rerender([{ kind: "cut", servedCount: 40 }]);
    expect(announced.polite()).toContain("40");
  });

  it("speaks a coverage gap with its figure, so a listener hears how much", () => {
    // The arm this vocabulary was extended for. A person who cannot see the panel
    // hears the count, because "some of it went unanswered" and "four of it did" are
    // different facts and only the second is actionable.
    const announced = renderAnnouncing([
      uncheckedCoverageReading(4, PARSE_REFUSAL),
      { kind: "served" },
    ]);
    expect(announced.polite()).toContain("4 parts of");
    expect(announced.polite()).toContain("covers less than was asked for");
    expect(announced.assertive()).toBe("");
  });

  it("negative control: full coverage says nothing, so the figure is the reading", () => {
    // Without this the case above would also be satisfied by a hook that spoke for
    // every fan-out, including one that heard back from every source it asked.
    expect(renderAnnouncing([uncheckedCoverageReading(0, PARSE_REFUSAL)]).polite()).toBe("");
  });

  it("leaves the in-flight read to the absence that already announces it", () => {
    // Rule 8's `not-loaded` shape announces its own title through `Nothing`; saying
    // it here as well would be the second read the console's one announcer exists to
    // prevent.
    expect(renderAnnouncing([{ kind: "reading" }]).polite()).toBe("");
  });
});

describe("useReadingAnnouncement — one sentence, once, within the pass as well", () => {
  // Two readings of one surface can say the same words, and the pass used to walk a
  // LIST: each member was checked against the PREVIOUS pass only, so both passed and
  // the region was asked to say the text twice. The announcer coalesces an immediate
  // repeat, which hid the pair; it does not coalesce a repeat with another sentence
  // between it, so a separated duplicate is where the defect is observable.
  const STALE: ReadingState = { kind: "stale", refusal: undefined };
  const CUT: ReadingState = { kind: "cut", servedCount: 12 };
  const PARTIAL: ReadingState = { kind: "partial", unreadableCount: 3, newestRefusal: undefined };

  it("says a repeated sentence once, however far apart the two readings are", () => {
    const announced = renderAnnouncing([STALE, CUT, STALE]);
    const staleSentence = announced.polite();
    expect(staleSentence).toContain("may be behind what the daemon has sent");
    // The second sentence, published as the first one's hold expires.
    announced.settle();
    expect(announced.polite()).toContain("12");
    // And nothing behind it: the third reading's sentence was the first one's, and
    // one sentence is one announcement.
    announced.settle();
    expect(announced.polite()).toBe("");
  });

  it("negative control: three distinct sentences are still three announcements", () => {
    // Without this the silence above would also be satisfied by a hook that dropped
    // everything after the first sentence, or by a drain that empties the lane
    // whatever was queued. Same shape, same two settles, one sentence still to say.
    const announced = renderAnnouncing([STALE, CUT, PARTIAL]);
    announced.settle();
    announced.settle();
    expect(announced.polite()).toContain("3");
    expect(announced.polite()).toContain("could not be read");
  });

  it("negative control: the two stale readings really do say the same words", () => {
    // Without this the claim above could hold because the duplicate was never a
    // duplicate. One `stale` reading and two of them put the same sentence on the
    // region, which is what makes the second one nothing new to say.
    expect(renderAnnouncing([STALE]).polite()).toBe(renderAnnouncing([STALE, STALE]).polite());
    expect(renderAnnouncing([STALE, STALE]).polite()).not.toBe("");
  });
});

describe("useAnnounceOncePerSentence — the two arms of the latch's memory", () => {
  function LatchedSurface(props: { readonly sentences: readonly string[] | undefined }): null {
    useAnnounceOncePerSentence(props.sentences);
    return null;
  }

  /** The latch driven directly, over the same announcer on the same frozen clock. */
  function renderLatched(sentences: readonly string[] | undefined): {
    readonly polite: () => string;
    readonly rerender: (next: readonly string[] | undefined) => void;
    readonly settle: () => void;
  } {
    const mounted = renderThroughAnnouncer(LatchedSurface, { sentences });
    return {
      ...mounted,
      rerender: (next) => {
        mounted.rerender({ sentences: next });
      },
    };
  }

  it("forgets a sentence an empty pass dropped, and says it again when it returns", () => {
    // The SET arity's rule, and the reason `useReadingAnnouncement` hands over `[]`
    // rather than nothing when a reading completes: an empty pass is the positive
    // claim that nothing is incomplete, so a reading that goes back to incomplete
    // after serving is a second, real announcement.
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
    // The SCALAR arity's rule, and the case that fails the moment `undefined` is folded
    // into `[]`. A read that has not settled is not a read that settled to nothing, so
    // its pass forgets nothing — otherwise one settlement is audible twice, which is the
    // whole defect `settlement-announcement.ts` exists to prevent.
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
  interface SettlementSurfaceProps {
    readonly settlement: AnnouncementDedupeKey | undefined;
    readonly sentence: string | undefined;
  }

  function SettlementSurface(props: SettlementSurfaceProps): null {
    useReadSettlementAnnouncement(props.settlement, props.sentence);
    return null;
  }

  /** The same words through the SENTENCE-keyed arity, which is the foil below. */
  function SentenceKeyedSurface(props: { readonly sentence: string | undefined }): null {
    useSettlementAnnouncement(props.sentence);
    return null;
  }

  it("speaks the settlement it was handed, in the polite lane", () => {
    const announced = renderThroughAnnouncer<SettlementSurfaceProps>(SettlementSurface, {
      settlement: { read: "definitions" },
      sentence: IDENTICAL_SENTENCE,
    });
    expect(announced.polite()).toBe(IDENTICAL_SENTENCE);
    // The interrupting lane belongs to a refusal that changed what the whole room can
    // do; a surface finishing its own read is news for the person reading it.
    expect(announced.assertive()).toBe("");
  });

  it("says nothing a second time for the settlement it already spoke", () => {
    const settlement = { read: "definitions" };
    const announced = renderThroughAnnouncer<SettlementSurfaceProps>(SettlementSurface, {
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
    // The case the family wrote its own latch for, and the reason the key is not the
    // sentence: two sessions holding the same number of rows say the same words, and
    // the second one landing in silence is a surface that told nobody it had changed.
    const announced = renderThroughAnnouncer<SettlementSurfaceProps>(SettlementSurface, {
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
    const announced = renderThroughAnnouncer(SentenceKeyedSurface, {
      sentence: IDENTICAL_SENTENCE,
    });
    announced.settle();
    announced.rerender({ sentence: IDENTICAL_SENTENCE });
    expect(announced.polite()).toBe("");
  });

  it("counts a settled VALUE by its identity too, so a scope change speaks", () => {
    // Not every settlement is an object: the scope this arity was first spent on is a
    // session id, and a different string is a different scope.
    const announced = renderThroughAnnouncer<SettlementSurfaceProps>(SettlementSurface, {
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
    const announced = renderThroughAnnouncer<SettlementSurfaceProps>(SettlementSurface, {
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
    const announced = renderThroughAnnouncer<SettlementSurfaceProps>(SettlementSurface, {
      settlement: undefined,
      sentence: undefined,
    });
    expect(announced.polite()).toBe("");
  });
});
