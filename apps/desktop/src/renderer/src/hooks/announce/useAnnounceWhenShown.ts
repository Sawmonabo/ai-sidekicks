// A line that mounts already holding its words is not announced by most screen readers, so a
// line drawn on a refusal, a failure or a settled act speaks through the app's one announcer.
//
// The words are said when the line is drawn and again when they change; a re-render says
// nothing, and a line taken away and drawn again speaks again. A retry that fails the same way
// can leave the line drawn with the same words, so a caller passes the attempt: a new attempt
// value says the words again even when they have not changed.

import { useEffect } from "react";

import type { AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/announcer.js";
import { useAnnounce } from "./useAnnounce.js";

/**
 * Announce a drawn line's words when it is shown, when they change, and when `attempt` changes.
 * `sentence` is `undefined` while the line is not drawn. `attempt` must keep its identity across
 * renders (a refusal or reading object the retry replaces), or every render speaks.
 */
export function useAnnounceWhenShown(
  sentence: string | undefined,
  politeness: AnnouncementPoliteness,
  attempt?: unknown,
): void {
  const announce = useAnnounce();
  useEffect(() => {
    if (sentence !== undefined) {
      announce(sentence, politeness);
    }
  }, [sentence, politeness, attempt, announce]);
}
