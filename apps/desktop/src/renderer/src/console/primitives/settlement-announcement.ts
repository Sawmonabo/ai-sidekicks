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
// WHY IT IS NOT `frame/banner-announcements.ts`. That module diffs a LIST by id and
// speaks into the assertive lane, because a refusal banner says the whole room's
// capabilities moved. This one holds a single string and speaks politely, because a
// surface finishing its own read is news for the person reading that surface and
// nobody else. Folding them together would need a shape that is a set on one side and
// a scalar on the other, and would put the two politeness lanes behind one call.

import { useEffect, useRef } from "react";

import { useAnnounce } from "./LiveAnnouncerProvider.js";

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
  const announce = useAnnounce();
  // The last thing this surface said. A ref rather than state, because it must not
  // cause a render — and because what it guards is the effect's next run, which is
  // scheduled before any render it could trigger would land.
  const lastAnnouncedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (sentence === undefined || sentence === lastAnnouncedRef.current) {
      return;
    }
    lastAnnouncedRef.current = sentence;
    announce(sentence);
  }, [sentence, announce]);
}
