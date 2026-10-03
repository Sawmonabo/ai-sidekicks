import { useMemo } from "react";

import {
  useAnnounceOncePerSentence,
  type AnnouncementDedupeKey,
} from "./useAnnounceOncePerSentence.js";

/**
 * Announce one read's settlement, once per settlement rather than once per sentence.
 *
 * For a caller whose distinct settlements can say the same words. The identity of
 * `settlement` (the read's state object, or the value it settled on) is what "once" is
 * counted by; it is optional because a scope that has settled on no session has nothing to be
 * identified by. `sentence` is what to say about it, or `undefined` while nothing has settled;
 * an unsettled read is recorded as unannounced, so the same object speaks once it has a
 * sentence.
 */
export function useReadSettlementAnnouncement(
  settlement: AnnouncementDedupeKey | undefined,
  sentence: string | undefined,
): void {
  // An unidentified settlement is folded into the silent arm rather than announced under an
  // absent key: a sentence said under no identity could not be counted and would speak on
  // every pass.
  const sentences = useMemo(
    () => (settlement === undefined || sentence === undefined ? undefined : [sentence]),
    [settlement, sentence],
  );
  useAnnounceOncePerSentence(sentences, settlement);
}
