// The sentence, said once — and not again on the next render.
//
// Driven through the real announcer over a manual clock rather than a spy, because
// the claim is about the console's one pair of regions and a stand-in would prove
// only this file's own arithmetic.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock, refuse } from "../core/index.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { LiveAnnouncerProvider } from "./LiveAnnouncerProvider.js";
import { useReadingAnnouncement } from "./reading-announcement.js";
import { type ReadingState } from "./partial-read.js";

const SUBJECT = "the queue";

const PARSE_REFUSAL = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

function AnnouncingSurface(props: { readonly states: readonly ReadingState[] }): null {
  useReadingAnnouncement(props.states, SUBJECT);
  return null;
}

/** The window's announcer, and a surface announcing through it. */
function renderAnnouncing(states: readonly ReadingState[]): {
  readonly polite: () => string;
  readonly assertive: () => string;
  readonly rerender: (next: readonly ReadingState[]) => void;
  readonly settle: () => void;
} {
  const clock = new ManualClock(0);
  const announcer = new LiveAnnouncer({ clock });
  const { container, rerender } = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <AnnouncingSurface states={states} />
    </LiveAnnouncerProvider>,
  );
  const regionText = (lane: string): string =>
    container.querySelector(`[data-live-region="${lane}"]`)?.textContent ?? "";
  return {
    polite: () => regionText("polite"),
    assertive: () => regionText("assertive"),
    rerender: (next) => {
      rerender(
        <LiveAnnouncerProvider announcer={announcer}>
          <AnnouncingSurface states={next} />
        </LiveAnnouncerProvider>,
      );
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
    expect(announced.polite()).toContain(SUBJECT);
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
