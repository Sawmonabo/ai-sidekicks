// A read's settlement, said out loud exactly once.
//
// A view that renders `not-loaded` and then a list has told only the sighted that its read
// landed. A read that refreshes on focus settles on every refresh and a component re-renders
// for unrelated reasons, so the unit is the sentence, not the state: the caller composes one
// sentence from its settled reading and this hook speaks it when it is new. That sentence
// must not carry a figure that moves without the reading changing (a percent, a relative
// timestamp), or every push is a new sentence; each caller's test pins that with a negative
// control.
//
// It owns no latch: it composes over `useAnnounceOncePerSentence.ts`, handing it `undefined` for
// an unsettled read (no claim), where the set arity hands an empty array and so forgets what it
// said.
//
// Unlike `layout/AppShell/hooks/useRefusalBannerAnnouncements.ts`, which diffs a list by id
// and speaks assertively, this holds one string and speaks politely: a view finishing its own
// read is news only for the person reading it.

import { useMemo } from "react";

import { useAnnounceOncePerSentence } from "./useAnnounceOncePerSentence.js";

/**
 * Announce a read's settlement, once per distinct sentence, in the polite lane.
 *
 * `sentence` is what settled, in one sentence, or `undefined` while nothing has. `undefined`
 * is deliberately not an empty string: the announcer publishes an empty string to clear a
 * region, so an empty string would ask for a clear rather than for silence.
 */
export function useSettlementAnnouncement(sentence: string | undefined): void {
  // Memoized on the sentence, so the latch's effect re-runs when the settlement moves and not
  // once per render.
  const sentences = useMemo(() => (sentence === undefined ? undefined : [sentence]), [sentence]);
  useAnnounceOncePerSentence(sentences);
}
