// A read's settlement, said out loud exactly once.
//
// A surface that renders `not-loaded` and then a list has told everyone who can see
// the screen that its read landed, and nobody else. `Spec-023 §Console Design
// (Meridian)`'s live announcer exists for that gap, and the discipline it needs is
// narrower than "call `announce` when the state changes": a read that refreshes on
// focus settles again on every refresh, a component re-renders for reasons that have
// nothing to do with its read, and a person who navigates away and back did not ask
// to be told twice.
//
// SO THE UNIT IS THE SENTENCE, NOT THE STATE. A caller composes one sentence from
// its settled reading and hands it over; this hook speaks it when it is new and stays
// silent when it is not. That places one obligation on the caller and it is the
// important one: the sentence must not carry a figure that moves without the reading
// changing — a download percent, a relative timestamp — because a sentence that
// changes on every push is a new sentence every time and this hook will say all of
// them. Each caller's own test pins that with a negative control.
//
// IN `primitives/` BECAUSE THREE VIEW FAMILIES READ IT, counted rather than assumed:
// `settings/` from the mount inventory and the updates block, `agents/` from the
// definition registry view, and `sessions/` from the attention read. View families are
// siblings, so no one of them can hold a hook the other two call — the family that
// wrote it would be the family the others deep-import into. That is the same argument
// `SurfaceAbsence` and `chord-format.ts` beside it are here on, and it is why this is a
// primitive rather than a settings module that grew readers.
//
// IT OWNS NO LATCH. `reading-announcement.ts` next door states the "once per distinct
// sentence, replaced each pass" rule and holds the ref that enforces it; this module is
// the SCALAR arity of the same rule and composes over that latch rather than keeping a
// second copy of it. The place two copies of a latch drift is the comparison, and a
// drifted comparison is a sentence a person hears twice with every test still green.
// What is left here is the one thing the two arities genuinely disagree about: an
// unsettled read makes NO claim, where a complete reading claims that nothing is
// incomplete — so this module hands the latch `undefined` and the set arity hands it an
// empty array, and only the second forgets what it said.
//
// WHY IT IS NOT `frame/banner-announcements.ts`. That module diffs a LIST by id and
// speaks into the assertive lane, because a refusal banner says the whole room's
// capabilities moved. This one holds a single string and speaks politely, because a
// surface finishing its own read is news for the person reading that surface and
// nobody else. Folding them together would need a shape that is a set on one side and
// a scalar on the other, and would put the two politeness lanes behind one call.

import { useMemo } from "react";

import { useAnnounceOncePerSentence } from "./reading-announcement.js";

/**
 * Announce a read's settlement, once per distinct sentence, in the polite lane.
 *
 * @param sentence What settled, in one sentence — or `undefined` while nothing has.
 *   `undefined` is the "still reading" arm and is deliberately not a silent empty
 *   string: an empty string is what the announcer publishes to CLEAR a region, and a
 *   caller that reached this hook with one would be asking for a clear rather than
 *   for silence.
 */
export function useSettlementAnnouncement(sentence: string | undefined): void {
  // Memoised on the sentence, so the latch's effect re-runs when the settlement moves
  // and not once per render — which is what depending on a string gave before.
  const sentences = useMemo(() => (sentence === undefined ? undefined : [sentence]), [sentence]);
  useAnnounceOncePerSentence(sentences);
}
