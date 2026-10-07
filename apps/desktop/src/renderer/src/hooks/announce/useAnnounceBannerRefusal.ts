// A refusal banner a view draws for itself says its words here: the banner does not speak, since
// the frame says each of its own banners as it is raised.

import { refusalSentence } from "#renderer/lib/code-words.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { useAnnounceWhenShown } from "./useAnnounceWhenShown.js";

/**
 * Announce a view's own refusal banner on the assertive lane: the code's words, then the message,
 * as the banner draws them. `refusal` is `undefined` while none is drawn; a new refusal object is a
 * new attempt, said again in the same words.
 */
export function useAnnounceBannerRefusal(refusal: ExtendedRefusal | undefined): void {
  useAnnounceWhenShown(
    refusal === undefined
      ? undefined
      : refusalSentence(refusal.code, refusal.reason, formatWireString(refusal.detail)),
    "assertive",
    { attempt: refusal },
  );
}
