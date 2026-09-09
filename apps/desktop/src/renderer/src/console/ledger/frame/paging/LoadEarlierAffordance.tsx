// The act at the window's head: read the rows this participant was never sent.
//
// SYMMETRIC WITH `LedgerTailAffordance.tsx`, and the symmetry is the design rather
// than a coincidence. The tail affordance is the way back to rows that arrived while
// somebody was reading; this is the way back to rows that were never delivered at all,
// and both sit outside the scroll surface at the end of the log they are about, so
// neither is a row and neither moves when the window does.
//
// OFFERED ONLY WHILE THERE IS SOMETHING TO READ. `Spec-023 §Meridian, the design
// language` rule 8 — an absence names its cause — is met here by the control's own
// absence being the ordinary case: a window that opens at the beginning of the log has
// no earlier rows, and a control that offered to fetch them would promise a read that
// answers nothing. What rule 8 does apply to is the REFUSAL, which is rendered inline
// on the control through the console's one refusal renderer rather than as a sentence
// this file wrote.
//
// AND IT IS A BUTTON, NOT A SCROLL TRIGGER. Reading to the top of a window is not an
// instruction to fetch history — it is what a reader does on the way to the oldest row
// they have — and a fetch fired by arriving there would grow the log under somebody
// who was only passing through, on a walk with no end while the log has one.

import { InlineRefusal } from "../../../primitives/index.js";
import { type LedgerEarlierPaging } from "./paging-binding.js";

export interface LoadEarlierAffordanceProps {
  readonly paging: LedgerEarlierPaging;
}

/**
 * The head control, or nothing.
 *
 * Nothing is the ordinary state: most windows open at the beginning of their log, and
 * every walk ends exhausted. The one case that renders without an offer is a refused
 * read — the control stays so the refusal has somewhere to be, and the press is
 * offered again beside it, because a transport failure is exactly the kind a second
 * attempt settles.
 */
export function LoadEarlierAffordance(props: LoadEarlierAffordanceProps): React.JSX.Element | null {
  const { canLoadEarlier, isReading, refusal, loadEarlier } = props.paging;
  if (!canLoadEarlier && !isReading && refusal === undefined) {
    return null;
  }
  return (
    <div className="meridian-ledger-viewport__head">
      <button
        type="button"
        className="meridian-ledger-viewport__load-earlier"
        onClick={loadEarlier}
        // Disabled while a page is in flight rather than hidden, so the control does
        // not vanish under the pointer that just pressed it. The reader drops a second
        // press anyway; this is what makes that legible instead of silent.
        disabled={!canLoadEarlier}
      >
        {isReading ? "Loading earlier entries…" : "Load earlier"}
      </button>
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </div>
  );
}
