// The three ways this window is not the whole session, each said out loud.
//
// Its own module for the one-component rule, and the reasoning lives on the component
// below rather than being said twice: a reader who opens this file meets the JSDoc,
// and a header restating it is a second copy that goes stale on the first edit that
// touches only one of them.

import { WindowAbsences } from "../../../primitives/index.js";
import { type LedgerScope } from "../../frame/index.js";

/**
 * What the window holds, named so the sentence says WHOSE absence it is.
 *
 * The unrecognised count is measured before a channel scope can apply, and an event
 * this build cannot place carries no channel it could be counted under — so a channel
 * pane says it is the session's fact rather than implying its own. It is a subject
 * noun and not a second set of sentences: `primitives/absence/window-absence.ts` writes the
 * words, and this decides only which things they are about.
 */
const SESSION_WIDE_SUBJECT: Readonly<Record<LedgerScope, string>> = {
  session: "entries",
  channel: "of the session's entries",
};

/**
 * The three ways this window is not the whole session, each said out loud.
 *
 * Three separate sentences because a person's next move differs for each: an
 * unrecognised type is this build's limit, a dropped row is the window's cap, and a
 * sequence that never arrived is the stream's. Collapsing any two would tell somebody
 * the console failed where it merely stopped holding, or the reverse.
 *
 * THE SENTENCES ARE THE CONSOLE'S NOW, NOT THIS LEDGER'S. Six families each wrote
 * their own wording for this case and they disagreed; `primitives/absence/window-absence.ts`
 * says it once and this hands it the readings it derived. One behaviour change comes
 * with that, on purpose: the never-received arm used to render as `not-loaded`, whose
 * skeleton branch drops `title` and `detail`, so its sentence reached nobody. The
 * shared module renders it as the settled absence it is, so it is shown.
 *
 * TWO GROUPS AND NOT ONE, because the session-wide absence and the window absences are
 * about different things and the subject noun is how the shared sentences say which.
 * The unrecognised count takes the scoped noun; the rest take the plain one. The
 * never-received arm is in the second group even though its fact is the session's as
 * well — the shared sentence for it puts the subject inside its detail line too, where
 * "of the session's entries" does not parse — so a channel pane no longer qualifies
 * that one. That is the honest limit of the shared shape, and it is worth less than a
 * seventh copy of all three sentences.
 */
export function LedgerWindowAbsences(props: LedgerWindowAbsencesProps): React.JSX.Element | null {
  return (
    <>
      <WindowAbsences
        absences={[{ kind: "unprojectable", count: props.unprojectableEventCount }]}
        subject={SESSION_WIDE_SUBJECT[props.scope]}
      />
      <WindowAbsences
        // The order is the pipeline's: what the cap took, and what never arrived.
        // Counted absences at zero are dropped by the model, so nothing is guarded
        // here.
        absences={[
          { kind: "dropped", count: props.droppedRowCount },
          ...(props.hasUnreceivedEntries ? ([{ kind: "never-received" }] as const) : []),
        ]}
        subject="entries"
      />
    </>
  );
}

interface LedgerWindowAbsencesProps {
  /** Events the contract package registers no category for. */
  readonly unprojectableEventCount: number;
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
  /** The store recorded sequences it never received. */
  readonly hasUnreceivedEntries: boolean;
  /** What this ledger is a log of — whose absence the first one is. */
  readonly scope: LedgerScope;
}
