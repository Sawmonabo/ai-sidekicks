// How an incomplete reading is said out loud, when it has to be.
//
// `PartialRead` creates no live region, so a view whose read settles while a person is on it
// shows the notice where nothing draws their attention. This hook routes the sentence to the
// console's one announcer, so no feature mints its own region or its own latch.
//
// The sentence is the key. The sentences announced last pass are held and replaced, never
// accumulated: a re-render announces nothing, and a reading that goes back to incomplete
// after serving is a new announcement. Within a pass they are collected as a set, since the
// announcer coalesces only an immediate repeat and `[stale, cut, stale]` would speak the
// first sentence twice.
//
// Always polite: an incomplete reading changes only what one view claims about itself, not
// what the operator can do, which is the assertive lane (`live-announcer.ts`).
//
// `useSettlementAnnouncement.ts` composes one sentence over this latch, and
// `useReadSettlementAnnouncement.ts` counts "once" by a dedupe key, because two sessions with
// the same row count say the same words. The two memories are separate refs because a call
// site is in one mode for its whole life.

import { useEffect, useRef } from "react";

import { useAnnounce } from "./useAnnounce.js";
/**
 * What "once" is counted by, where the sentence itself is the wrong answer.
 *
 * Compared by identity, which suits both members: a read's state object is replaced once per
 * settlement, and a session id is a different string once per scope change.
 */
export type AnnouncementDedupeKey = object | string;

/**
 * Say each of a pass's sentences once, in the polite region. The one latch.
 *
 * `sentences` is what this pass has to say, or `undefined` where it makes no claim. An array
 * replaces what was said, so a sentence absent from it is forgotten and speaks again if it
 * returns; `undefined` leaves the memory standing, since a view whose read has not settled
 * has nothing to retract. `dedupeKey` counts "once" instead of the sentences, for a caller
 * whose distinct settlements can say identical words: a pass carrying a key it has not
 * announced under speaks every sentence, and a pass repeating a key says nothing. A pass with
 * no sentences never reaches that comparison.
 */
export function useAnnounceOncePerSentence(
  sentences: readonly string[] | undefined,
  dedupeKey?: AnnouncementDedupeKey,
): void {
  const announce = useAnnounce();
  // A ref, not state: it must not cause a render, and it guards the effect's next run.
  const announcedSentencesRef = useRef<ReadonlySet<string>>(undefined);
  // The keyed arity's memory, beside the other: a call site is in one mode for its whole life,
  // so one of the two is always untouched, and a single ref holding either shape would make
  // its shape a question about the last pass.
  const announcedKeyRef = useRef<AnnouncementDedupeKey>(undefined);

  useEffect(() => {
    if (sentences === undefined) {
      return;
    }
    if (dedupeKey !== undefined) {
      if (announcedKeyRef.current === dedupeKey) {
        return;
      }
      announcedKeyRef.current = dedupeKey;
      // Said in full rather than filtered against earlier passes: a settlement saying the
      // words a previous one said is a real announcement.
      for (const sentence of new Set(sentences)) {
        announce(sentence, "polite");
      }
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
  }, [sentences, dedupeKey, announce]);
}
