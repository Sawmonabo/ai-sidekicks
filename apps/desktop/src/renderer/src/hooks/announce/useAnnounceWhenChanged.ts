// A line that mounts already holding its words is not announced from a live role (the reason
// `announcer.ts` keeps its regions mounted empty), so a line drawn on a refusal, a failure or a
// settled act speaks through the app's one announcer.
//
// What a line reports is said when it changed after its view's first read settled: a line that
// appears or whose words change after that, or whose attempt changes in place. What a view's first
// read draws, what a stream replays and what a remounted row redraws stands, and is reached by
// browsing. A line drawn again in the words it last showed is a re-read, not a change, and says
// nothing; so a retry the person asked for, which can end in the same words, passes its attempt,
// and a new attempt says the words again.
//
// A read's settled sentence, which sums a view's read up for a screen reader rather than drawing
// one line, follows the same rule: its first settlement answers the first read and stands, even
// where that settlement has nothing to say.

import { useContext, useEffect, useRef } from "react";

import type { AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/announcer.js";
import { StandingContentContext } from "#renderer/components/LiveAnnouncer/context.js";
import { useAnnounce } from "./useAnnounce.js";

/** What a line adds to its words when it says them. */
export interface AnnounceWhenChangedOptions {
  /**
   * The attempt the words answer: a new value says them again. Keep its identity across renders
   * (the refusal or reading object a retry replaces), or every render speaks.
   */
  readonly attempt?: unknown;
  /**
   * The words now drawn were already true when the person arrived (a replayed outcome): they are
   * not said, and stay unsaid until they change.
   */
  readonly isStanding?: boolean | undefined;
  /**
   * The words are a read's settled sentence rather than a drawn line: the first settlement, words
   * or `null`, answers the view's first read and stands, and a later change is said. The sentence
   * carries no figure that moves without the reading (a percent, a relative time), or every push
   * would be news.
   */
  readonly isReadSettlement?: boolean | undefined;
}

/**
 * Announce a line's words when they report a change after its view's first read settled; words
 * drawn as the view opens or a row remounts stand (inside `StandingContent`, or `isStanding`), and
 * a view's own first read failing is drawn outside its `StandingContent`, so it is said.
 * `sentence` is `undefined` while nothing is drawn or the read is in flight, which keeps the last
 * words so a re-read in them says nothing, and `null` where the read settled with nothing to say,
 * after which any words are said.
 */
export function useAnnounceWhenChanged(
  sentence: string | null | undefined,
  politeness: AnnouncementPoliteness,
  options: AnnounceWhenChangedOptions = {},
): void {
  const announce = useAnnounce();
  const standingContent = useContext(StandingContentContext);
  const { attempt, isStanding = false, isReadSettlement = false } = options;
  // What this line last reported and what it last said: refs, since neither may cause a render, and
  // a repeat of the same words and attempt (a re-render, a strict-mode effect pass, a re-read) says
  // nothing. Not drawn, the line keeps both; settled with nothing to say, it reports `null`.
  const reportedRef = useRef<{ readonly sentence: string | null; readonly attempt: unknown }>(
    undefined,
  );
  const saidRef = useRef<string>(undefined);
  useEffect(() => {
    if (sentence === undefined || sentence === "") {
      return;
    }
    const reported = reportedRef.current;
    if (reported !== undefined && reported.sentence === sentence && reported.attempt === attempt) {
      return;
    }
    reportedRef.current = { sentence, attempt };
    if (sentence === null) {
      return;
    }
    const isFirstSettlement = isReadSettlement && reported === undefined;
    if (isStanding || isFirstSettlement || standingContent?.isOpening() === true) {
      return;
    }
    announce(sentence, politeness, { replacing: saidRef.current });
    saidRef.current = sentence;
  }, [sentence, politeness, attempt, isStanding, isReadSettlement, announce, standingContent]);
}
