import { useMemo } from "react";

import {
  useAnnounceOncePerSentence,
  type AnnouncementDedupeKey,
} from "./useAnnounceOncePerSentence.js";

/**
 * Announce one read's settlement, once per settlement rather than once per sentence.
 *
 * The arity for a caller whose distinct settlements can say the same words.
 * `settlement` is what the read produced — whatever it is, its IDENTITY is what "once"
 * is counted by — and it is optional because a scope that has settled on no session has
 * nothing to be identified by either. `sentence` is what to say about it, or
 * `undefined` while there is nothing settled to say; an unsettled read is recorded as
 * unannounced, so the same object speaks the moment it has a sentence rather than being
 * skipped forever.
 *
 * @param settlement The read's own state object, or the value it settled on.
 * @param sentence What to say about it, or `undefined` while nothing has settled.
 */
export function useReadSettlementAnnouncement(
  settlement: AnnouncementDedupeKey | undefined,
  sentence: string | undefined,
): void {
  // An unidentified settlement is folded into the silent arm rather than announced
  // under an absent key: a sentence said under no identity could not be counted, so it
  // would speak on every pass that produced it. Every caller ties the two together
  // already — a scope with no session composes no sentence about one.
  const sentences = useMemo(
    () => (settlement === undefined || sentence === undefined ? undefined : [sentence]),
    [settlement, sentence],
  );
  useAnnounceOncePerSentence(sentences, settlement);
}
