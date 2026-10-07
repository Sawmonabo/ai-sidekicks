// A line that mounts already holding its words is not announced from a live role (the reason
// `announcer.ts` keeps its regions mounted empty), so a line drawn on a refusal, a failure or a
// settled act speaks through the app's one announcer.
//
// What a line reports is said when it changed after its view's first read settled: a line that
// appears because of an act or a pushed change, or whose words or attempt change in place.
// What a view's first read draws, what a stream replays and what a remounted row redraws stands,
// and is reached by browsing. A line drawn again in the words it last showed is a re-read, not a
// change, and says nothing; a retry that fails the same way leaves the same words drawn, so a
// caller passes the attempt: a new attempt value says the words again.
//
// A read's settled sentence, which sums a view's read up for a screen reader rather than drawing
// one line, follows the same rule: its first settlement answers the first read and stands.

import { useContext, useEffect, useRef } from "react";

import type { AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/announcer.js";
import { StandingContentContext } from "#renderer/components/LiveAnnouncer/context.js";
import { useAnnounce } from "./useAnnounce.js";

/** What a line adds to its words when it says them. */
export interface AnnounceWhenShownOptions {
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
   * The words are a read's settled sentence rather than a drawn line: the first one answers the
   * view's first read and stands, and a later different one is said. The sentence carries no figure
   * that moves without the reading (a percent, a relative time), or every push would be news.
   */
  readonly isReadSettlement?: boolean;
}

/**
 * Announce a line's words when they report a change after its view's first read settled, never for
 * words drawn as the view opens or a row remounts: those are inside `StandingContent`, or marked
 * `isStanding`, and stand. A view's own first read failing is drawn outside its `StandingContent`,
 * so it is said. `sentence` is `undefined` while the line is not drawn; drawn again in the words
 * and attempt it last showed, it says nothing.
 */
export function useAnnounceWhenShown(
  sentence: string | undefined,
  politeness: AnnouncementPoliteness,
  options: AnnounceWhenShownOptions = {},
): void {
  const announce = useAnnounce();
  const standingContent = useContext(StandingContentContext);
  const { attempt, isStanding = false, isReadSettlement = false } = options;
  // What this line last showed and what it last said: refs, since neither may cause a render, and a
  // repeat of the same words and attempt (a re-render, a strict-mode effect pass, a re-read) says
  // nothing. Not drawn, the line keeps both.
  const shownRef = useRef<{ readonly sentence: string; readonly attempt: unknown }>(undefined);
  const saidRef = useRef<string>(undefined);
  useEffect(() => {
    if (sentence === undefined || sentence === "") {
      return;
    }
    const shown = shownRef.current;
    if (shown !== undefined && shown.sentence === sentence && shown.attempt === attempt) {
      return;
    }
    shownRef.current = { sentence, attempt };
    const isFirstSettlement = isReadSettlement && shown === undefined;
    if (isStanding || isFirstSettlement || standingContent?.isOpening() === true) {
      return;
    }
    announce(sentence, politeness, { replacing: saidRef.current });
    saidRef.current = sentence;
  }, [sentence, politeness, attempt, isStanding, isReadSettlement, announce, standingContent]);
}
