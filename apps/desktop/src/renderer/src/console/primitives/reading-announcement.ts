// How an incomplete reading is said out loud, when it has to be.
//
// `PartialRead` renders its notices into the page and creates no live region, on
// `LiveAnnouncerProvider`'s standing absolute. That leaves the case the absolute
// exists to serve properly rather than to forbid: a surface whose read settles while
// a person is already on it, where the notice appears in a part of the page nothing
// draws their attention to. The answer is the console's one announcer, and this is
// the route to it — so a family never mints its own region and never writes its own
// "announce once" latch.
//
// ONCE PER SENTENCE, AND THE SENTENCE IS THE KEY. The frame's banner announcements
// diff by banner id because a banner has one; a reading has none, and the thing a
// person must not hear twice is the sentence itself. So the sentences announced last
// pass are held and REPLACED, never accumulated: a re-render announces nothing, a
// route change announces nothing, and a reading that goes back to incomplete after
// serving is a second, real announcement.
//
// AND THE KEY IS THE KEY WITHIN A PASS TOO, which is the half that was missing. Two
// readings of one surface can say the same words — two `stale` readings for one
// subject are one sentence twice — and a pass that walked a LIST checked each of them
// against the previous pass only, so both passed and the region was asked to say the
// text twice. The announcer coalesces an immediate repeat and would have hidden that
// on the pair; it does not coalesce a repeat with another sentence between it, so
// `[stale, cut, stale]` really did speak, then speak again, then speak the first
// sentence a third time. The pass's sentences are therefore collected as a SET rather
// than deduplicated as the loop runs: the rule is stated once, in the value, and the
// set held for the next pass is the same object this one announced from.
//
// POLITE, ALWAYS. `live-announcer.ts` reserves the assertive lane for refusals that
// change what the whole room can do. An incomplete reading changes what one surface
// is claiming about itself, and interrupting somebody mid-sentence to tell them a
// list may be short is the wrong trade.

import { useEffect, useRef } from "react";

import { useAnnounce } from "./LiveAnnouncerProvider.js";
import { partialReadNotices, type PartialReadNotice, type ReadingState } from "./partial-read.js";

/**
 * The words a notice is spoken as, or `undefined` where it says nothing aloud.
 *
 * A `reading` notice is deliberately silent: rule 8's `not-loaded` absence announces
 * its own title through `Nothing`, and saying it here as well would be the second
 * read this family's absolute exists to prevent. The figure travels with its
 * sentence, because "3" and "deliveries could not be read" spoken apart are two
 * fragments.
 */
function spokenSentenceFor(notice: PartialReadNotice): string | undefined {
  switch (notice.shape) {
    case "none":
    case "reading":
      return undefined;
    case "sentence":
      return notice.copy;
    case "counted-sentence":
      return `${notice.figure} ${notice.copy}`;
  }
}

/**
 * Announce each reading that is not the whole of it, once, in the polite region.
 *
 * @param states Every reading the surface holds — the same set `PartialRead` renders,
 *   so what is spoken and what is on screen cannot drift apart.
 * @param subject What was read, as the lowercase noun phrase the sentences take.
 */
export function useReadingAnnouncement(states: readonly ReadingState[], subject: string): void {
  const announce = useAnnounce();
  const announcedSentencesRef = useRef<ReadonlySet<string>>(undefined);

  useEffect(() => {
    const sentences = new Set(
      partialReadNotices(states, subject)
        .map(spokenSentenceFor)
        .filter((sentence): sentence is string => sentence !== undefined),
    );
    const alreadyAnnounced = announcedSentencesRef.current;
    for (const sentence of sentences) {
      if (alreadyAnnounced?.has(sentence) === true) {
        continue;
      }
      announce(sentence, "polite");
    }
    announcedSentencesRef.current = sentences;
  }, [states, subject, announce]);
}
