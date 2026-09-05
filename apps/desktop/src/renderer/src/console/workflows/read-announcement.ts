// Saying, once, how a read on this destination settled.
//
// The destination puts TWO reads — the definition enumeration and the run enumeration
// — and neither moves focus when it lands. A person using a screen reader is therefore
// told which session came into scope and then nothing at all, unless something speaks:
// the list simply becomes populated under a cursor that is somewhere else.
//
// ONE HOOK RATHER THAN ONE PER SECTION. The runs section had this; the browser did not,
// so the definition list finished or failed in silence. The second use is what makes
// it shared: the rule (say it once per settlement, politely, and say the daemon's own
// sentence when the read refused) is one rule, and two copies of it would be two
// chances for a section to announce on every re-render or to paraphrase a refusal.
//
// KEYED ON THE SETTLEMENT'S IDENTITY, NOT ON WHAT IT SAYS. Each directory hook replaces
// its state object exactly once per settlement, so a ref holding the last announced
// object speaks once for each and is silent on every re-render — where a key built from
// the sentence would go quiet on a second session that happened to hold the same number
// of rows, and one built from the count would do the same.
//
// AND THE KEY MAY BE A VALUE RATHER THAN AN OBJECT, because one of the three things
// this destination announces is not a read at all: the SCOPE it settled on, whose
// identity is the session id itself. That site had its own hand-written ref-and-effect
// latch until it was bound here — the third copy of one rule, with the primitive that
// exists to prevent exactly that beside them both.
//
// WHY THIS IS NOT `primitives/reading-announcement.ts`. That primitive is the console's
// route to the announcer and it dedups on the SENTENCE SET, which is right for the
// incomplete-reading notices it speaks and wrong for every settlement here: two
// sessions holding the same number of rows say the same words, and a sentence-keyed
// latch would announce the first and go silent on the second. So this family keeps ONE
// adapter beside its door rather than three latches.
//
// AND THE PRIMITIVE HAS NO READER IN THIS FAMILY, which is the fact rather than a plan.
// Its two rendering sites are `WorkflowsScopePicker.tsx`, whose header records why
// nothing there is announced at all and whose only notice is a `reading` one the
// primitive is deliberately silent about, and `definitions/DefinitionsBrowser.tsx`,
// whose continuation refusal is already announced through the hook below by
// `WorkflowsBrowser.tsx`'s own sentence — so binding it would say that refusal twice.
// The disposition this leaves is the primitive's door line, which names this family
// among the consumers of `useReadingAnnouncement`: either the primitive grows a
// caller-supplied dedup key and this adapter is deleted in that same change, or the
// door line stops naming this family. Both edits are `primitives/`', which is why
// neither is here; what is here is the reason a reader can check.
//
// POLITE, ALWAYS. `frame/banner-announcements.ts` reserves the assertive lane for a
// refusal that changed what the whole room can do; a list that could not be read is its
// own surface's subject, and its refusal is carried verbatim rather than paraphrased
// into an apology of the console's own.

import { useEffect, useRef } from "react";

import { useAnnounce } from "../primitives/index.js";

/**
 * What "once" is counted by: a read's own state object, or the value it settled on.
 *
 * Compared by identity either way, which is the same comparison for both — a state
 * object is replaced once per settlement and a session id is a different string once
 * per scope change.
 */
export type AnnouncedSettlement = object | string;

/**
 * Announce one read's settlement, once.
 *
 * `settlement` is what the read produced — whatever it is, its IDENTITY is what "once"
 * is counted by, and it is optional because a scope that has settled on no session has
 * nothing to be identified by either. `sentence` is what to say about it, or `undefined`
 * while there is nothing settled to say: an unsettled read is recorded as unannounced,
 * so the same object speaks the moment it has a sentence rather than being skipped
 * forever.
 */
export function useReadSettlementAnnouncement(
  settlement: AnnouncedSettlement | undefined,
  sentence: string | undefined,
): void {
  const announce = useAnnounce();
  const announcedSettlement = useRef<AnnouncedSettlement | undefined>(undefined);

  useEffect(() => {
    if (sentence === undefined || announcedSettlement.current === settlement) {
      return;
    }
    announcedSettlement.current = settlement;
    announce(sentence, "polite");
  }, [settlement, sentence, announce]);
}
