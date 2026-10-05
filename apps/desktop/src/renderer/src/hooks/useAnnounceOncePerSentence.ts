// How an incomplete reading is said out loud, when it has to be.
//
// `PartialRead` creates no live region, so a view whose read settles while a person is on it
// shows the notice where nothing draws their attention. This hook routes the sentence to the
// app's one announcer, so no feature mints its own region or its own latch.
//
// The sentence is the key. The sentences announced last pass are held and replaced, never
// accumulated: a re-render announces nothing, and a reading that goes back to incomplete
// after serving is a new announcement. Within a pass they are collected as a set, since the
// announcer coalesces only an immediate repeat and `[partial, cut, partial]` would speak the
// first sentence twice.
//
// Always polite: an incomplete reading changes only what one view claims about itself, not
// what the person can do, which is the assertive lane (`live-announcer.ts`).
//
// `useSettlementAnnouncement.ts` composes one sentence over this latch.

import { useEffect, useRef } from "react";

import { useAnnounce } from "./useAnnounce.js";

/**
 * Say each of a pass's sentences once, in the polite region. The one latch.
 *
 * `sentences` is what this pass has to say, or `undefined` where it makes no claim. An array
 * replaces what was said, so a sentence absent from it is forgotten and speaks again if it
 * returns; `undefined` leaves the memory standing, since a view whose read has not settled
 * has nothing to retract.
 */
export function useAnnounceOncePerSentence(sentences: readonly string[] | undefined): void {
  const announce = useAnnounce();
  // A ref, not state: it must not cause a render, and it guards the effect's next run.
  const announcedSentencesRef = useRef<ReadonlySet<string>>(undefined);

  useEffect(() => {
    if (sentences === undefined) {
      return;
    }
    // Collected as a set, not deduplicated as the loop runs: two readings in one view can say
    // the same words. The set held for the next pass is the one announced from.
    const spoken = new Set(sentences);
    const alreadyAnnounced = announcedSentencesRef.current;
    for (const sentence of spoken) {
      if (alreadyAnnounced?.has(sentence) === true) {
        continue;
      }
      announce(sentence, "polite");
    }
    announcedSentencesRef.current = spoken;
  }, [sentences, announce]);
}
