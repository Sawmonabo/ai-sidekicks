// The three ways this window is not the whole session, each said out loud.
//
// Its own module for the one-component rule, and the reasoning lives on the component
// below rather than being said twice: a reader who opens this file meets the JSDoc,
// and a header restating it is a second copy that goes stale on the first edit that
// touches only one of them.

import { WindowAbsences } from "../../../primitives/index.js";

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
 * says it once and this hands it the readings it derived.
 */
export function LedgerWindowAbsences(props: LedgerWindowAbsencesProps): React.JSX.Element | null {
  return (
    <WindowAbsences
      // The order is the pipeline's: what this build cannot place, what the cap took,
      // and what never arrived. Counted absences at zero are dropped by the model, so
      // nothing is guarded here.
      absences={[
        { kind: "unprojectable", count: props.unprojectableEventCount },
        { kind: "dropped", count: props.droppedRowCount },
        ...(props.hasUnreceivedEntries ? ([{ kind: "never-received" }] as const) : []),
      ]}
      subject="entries"
    />
  );
}

interface LedgerWindowAbsencesProps {
  /** Events the contract package registers no category for. */
  readonly unprojectableEventCount: number;
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
  /** The store recorded sequences it never received. */
  readonly hasUnreceivedEntries: boolean;
}
