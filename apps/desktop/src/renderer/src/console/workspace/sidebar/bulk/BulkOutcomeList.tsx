// What each row that was run settled as — one line per row, never one line for the run.
//
// A failed item renders its own refusal and never hides the others' success, and no
// bulk operation may run sequentially and silently. So this list names every row it was
// given, in the order they were selected, and a refusal renders through the console's
// own inline shape with its code verbatim rather than as a sentence this file wrote.
//
// IT DERIVES NO ELIGIBILITY AND SUMMARISES NOTHING. There is no "3 of 5 succeeded"
// line: a count would be a reading of outcomes a person can already see, and the one
// thing it would add — a green verdict over a set containing a refusal — is the
// rolled-up answer this whole surface exists to avoid.

import { InlineRefusal } from "../../../primitives/index.js";
import { type SidebarBulkItem, type SidebarBulkOutcome } from "../../../seats/index.js";

/** One row and what it settled as. */
export interface BulkOutcomeRow {
  readonly item: SidebarBulkItem;
  readonly outcome: SidebarBulkOutcome;
}

export interface BulkOutcomeListProps {
  readonly rows: readonly BulkOutcomeRow[];
  /** Drop every outcome from the screen. The only way one leaves. */
  readonly onDismiss: () => void;
}

/** What a settled row says beside its label, per state. */
const OUTCOME_PHRASE: Readonly<Record<"running" | "done", string>> = {
  running: "in flight",
  done: "accepted",
};

export function BulkOutcomeList(props: BulkOutcomeListProps): React.JSX.Element | null {
  if (props.rows.length === 0) {
    return null;
  }
  return (
    <div className="meridian-sidebar-bulk__outcomes">
      <ul className="meridian-sidebar-bulk__outcome-rows">
        {props.rows.map((row) => (
          <li
            key={`${row.item.sectionId}:${row.item.act}:${row.item.itemId}`}
            className="meridian-sidebar-bulk__outcome"
            data-outcome={row.outcome.state}
          >
            <span className="meridian-sidebar-bulk__outcome-label">{row.item.label}</span>{" "}
            {/* A real space between the two, and not only the flex gap: the row's
                accessible text is the concatenation of its children, and a screen
                reader reading "Draft the migrationaccepted" is reading one word. */}
            {row.outcome.state === "refused" ? (
              <InlineRefusal code={row.outcome.refusal.code} detail={row.outcome.refusal.detail} />
            ) : (
              <span className="meridian-sidebar-bulk__outcome-state">
                {OUTCOME_PHRASE[row.outcome.state]}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="meridian-sidebar-bulk__dismiss"
        onClick={() => {
          props.onDismiss();
        }}
      >
        Dismiss results
      </button>
    </div>
  );
}
