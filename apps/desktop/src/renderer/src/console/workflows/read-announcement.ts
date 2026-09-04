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
// POLITE, ALWAYS. `frame/banner-announcements.ts` reserves the assertive lane for a
// refusal that changed what the whole room can do; a list that could not be read is its
// own surface's subject, and its refusal is carried verbatim rather than paraphrased
// into an apology of the console's own.

import { useEffect, useRef } from "react";

import { useAnnounce } from "../primitives/index.js";

/**
 * Announce one read's settlement, once.
 *
 * `settlement` is the state object the read produced — whatever it is, its IDENTITY is
 * what "once" is counted by. `sentence` is what to say about it, or `undefined` while
 * there is nothing settled to say: an unsettled read is recorded as unannounced, so the
 * same object speaks the moment it has a sentence rather than being skipped forever.
 */
export function useReadSettlementAnnouncement(
  settlement: object,
  sentence: string | undefined,
): void {
  const announce = useAnnounce();
  const announcedSettlement = useRef<object | undefined>(undefined);

  useEffect(() => {
    if (sentence === undefined || announcedSettlement.current === settlement) {
      return;
    }
    announcedSettlement.current = settlement;
    announce(sentence, "polite");
  }, [settlement, sentence, announce]);
}
