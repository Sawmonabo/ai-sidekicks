// A line that mounts already holding its words is not announced from a live role (the reason
// `announcer.ts` keeps its regions mounted empty), so a line drawn on a refusal, a failure or a
// settled act speaks through the app's one announcer.
//
// What a line reports is said when it changed after its view's first read settled: a line that
// appears because of an act or a pushed change, or whose words or attempt change in place.
// What a view's first read draws, what a stream replays and what a remounted row redraws stands,
// and is reached by browsing. A retry that fails the same way leaves the same words drawn, so a
// caller passes the attempt: a new attempt value says the words again.

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
}

/**
 * Announce a line's words when they report a change after its view's first read settled, never for
 * words drawn as the view opens or a row remounts: those are inside `StandingContent`, or marked
 * `isStanding`, and stand. A view's own first read failing is drawn outside its `StandingContent`,
 * so it is said. `sentence` is `undefined` while the line is not drawn; a line taken away and
 * drawn again later is a change.
 *
 * Unlike `useSettlementAnnouncement`, which says a read's one settled sentence politely and
 * remembers it across `undefined`, this follows one drawn line on the lane its kind calls for.
 */
export function useAnnounceWhenShown(
  sentence: string | undefined,
  politeness: AnnouncementPoliteness,
  options: AnnounceWhenShownOptions = {},
): void {
  const announce = useAnnounce();
  const standingContent = useContext(StandingContentContext);
  const { attempt, isStanding = false } = options;
  // What this line last drew and what it last said: refs, since neither may cause a render, and a
  // repeat of the same words and attempt (a re-render, a strict-mode effect pass) says nothing.
  const drawnRef = useRef<{ readonly sentence: string | undefined; readonly attempt: unknown }>(
    undefined,
  );
  const saidRef = useRef<string>(undefined);
  useEffect(() => {
    const drawn = drawnRef.current;
    if (drawn !== undefined && drawn.sentence === sentence && drawn.attempt === attempt) {
      return;
    }
    drawnRef.current = { sentence, attempt };
    if (sentence === undefined || sentence === "" || isStanding) {
      return;
    }
    if (standingContent?.isOpening() === true) {
      return;
    }
    announce(sentence, politeness, { replacing: saidRef.current });
    saidRef.current = sentence;
  }, [sentence, politeness, attempt, isStanding, announce, standingContent]);
}
