// A line that mounts already holding its words is not announced by most screen readers, so a
// line drawn on a refusal, a failure or a settled act speaks through the app's one announcer.
//
// The words are the key, over `useAnnounceOncePerSentence.ts`: a re-render says nothing, new
// words speak, and a line taken away is forgotten, so the same line drawn again speaks again.

import { useMemo } from "react";

import type { AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/announcer.js";
import { useAnnounceOncePerSentence } from "./useAnnounceOncePerSentence.js";

/**
 * Announce a drawn line's words once when it is shown and again when they change. `sentence` is
 * `undefined` while the line is not drawn, which forgets it.
 */
export function useAnnounceWhenShown(
  sentence: string | undefined,
  politeness: AnnouncementPoliteness,
): void {
  // Memoized on the words, so the latch's effect runs when they change and not once per render.
  const sentences = useMemo(() => (sentence === undefined ? [] : [sentence]), [sentence]);
  useAnnounceOncePerSentence(sentences, politeness);
}
