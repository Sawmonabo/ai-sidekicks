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
//
// THE LATCH ITSELF IS PUBLISHED, because a second arity of the same rule reached this
// directory. `settlement-announcement.ts` beside it holds ONE composed sentence rather
// than a reading's set, and it was written with its own ref, its own comparison and its
// own paragraph stating the same "once per distinct sentence, replaced each pass"
// discipline. The place two copies of a latch drift is the comparison, and a drifted
// comparison is a sentence a person hears twice with every test still green. So the
// rule lives once, in `useAnnounceOncePerSentence` below, and each arity is the caller
// that composes its own sentences and hands them over.

import { useEffect, useMemo, useRef } from "react";

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
 * Say each of a pass's sentences once, in the polite region. The one latch.
 *
 * @param sentences What this pass has to say, or `undefined` where it makes no claim at
 *   all. That distinction IS the memory. An array REPLACES what was said, so a sentence
 *   absent from it is forgotten and speaks again if it returns — which is what a reading
 *   that goes back to incomplete after serving must do, and what an empty pass means:
 *   nothing is incomplete any more. `undefined` leaves the memory standing, which is
 *   what a surface whose read has not settled needs — it has nothing to say and nothing
 *   to retract, and forgetting there would make one settlement audible twice.
 */
export function useAnnounceOncePerSentence(sentences: readonly string[] | undefined): void {
  const announce = useAnnounce();
  // What this surface said last pass. A ref rather than state, because it must not
  // cause a render — and because what it guards is the effect's next run, which is
  // scheduled before any render it could trigger would land.
  const announcedSentencesRef = useRef<ReadonlySet<string>>(undefined);

  useEffect(() => {
    if (sentences === undefined) {
      return;
    }
    // Collected as a SET rather than deduplicated as the loop runs: two readings of one
    // surface can say the same words, and a pass that checked each against the PREVIOUS
    // pass only let both through. The set held for the next pass is the same object this
    // one announced from.
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

/**
 * Announce each reading that is not the whole of it, once, in the polite region.
 *
 * @param states Every reading the surface holds — the same set `PartialRead` renders,
 *   so what is spoken and what is on screen cannot drift apart.
 * @param subject What was read, as the lowercase noun phrase the sentences take.
 */
export function useReadingAnnouncement(states: readonly ReadingState[], subject: string): void {
  // Memoised on exactly the inputs the announcing effect used to depend on, so the latch
  // below re-runs when this reading changes and not once per render.
  const sentences = useMemo(
    () =>
      partialReadNotices(states, subject)
        .map(spokenSentenceFor)
        .filter((sentence): sentence is string => sentence !== undefined),
    [states, subject],
  );
  useAnnounceOncePerSentence(sentences);
}
