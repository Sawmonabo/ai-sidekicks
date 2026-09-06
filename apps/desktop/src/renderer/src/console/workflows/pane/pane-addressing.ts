// The question both workflows panes answer before they answer their own: is this
// pane pointed at a subject it opens?
//
// TWO PANES, ONE MISTAKE. The deck hands a pane a `ConsoleEntityRef`, and the entity
// set registers `workflow-definition` and `workflow-run` as two kinds deliberately —
// a definition is authored, versioned and scoped and outlives every run of it. The
// builder opens the first and the run view the second, and neither may read an id off
// the other: a definition id carried into a run read, or a run id into a definition
// read, composes a WELL-FORMED request about something that does not exist, and
// whatever comes back is then presented as the subject the person asked for.
//
// ONE SENTENCE, TWO PRODUCERS, AND THAT IS WHY IT IS HERE. The two refusals differ
// only in which subsystem raised one and which kind the pane opens, so the sentence
// is composed once and each pane binds its own two values. Written twice, the copies
// say different things about one mistake and the drift is invisible: a mis-addressed
// pane is rare by construction, so nobody reads either sentence often enough to
// notice they have come apart. `core/refusal.ts`'s rule still holds — each producer
// keeps its own closed code set and widens into the shared shape at its boundary —
// so the CODE is declared once here and each pane's own vocabulary lists it.
//
// REFUSED, NEVER THROWN, AND NEVER QUIETLY READ. Both of the other dispositions are
// worse: a throw takes the whole deck down over one mis-addressed pane, and reading
// the id anyway is the defect this replaces. The refusal is a `ConsoleRefusal` rather
// than a boolean so the two panes render one grammar — rule 9's code in mono and the
// sentence verbatim — instead of each writing its own words for the same state.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import type { ConsoleEntityRef } from "../../store/index.js";

/**
 * The code a pane raises when its address names a kind it does not open.
 *
 * A const assertion rather than a widening annotation: each pane's refusal-code
 * tuple names this constant through `typeof`, and a widened `string` would turn
 * those closed sets into `string[]` — the set no longer being closed at all.
 */
export const PANE_ADDRESS_INVALID_CODE = "pane-address-invalid" as const;

/**
 * The state of a pane handed an entity of a kind it does not open.
 *
 * The kinds are named in the detail because they are the whole content of the
 * refusal: a person looking at a pane that will not open needs to know it was pointed
 * at the wrong thing, and the deck's own address is what there is to fix. Neither id
 * appears — `core/refusal.ts` fixes `detail` as one actionable sentence that is never
 * the refused value.
 */
export function misaddressedPane(
  origin: string,
  subjectKind: ConsoleEntityRef["kind"],
  addressedKind: ConsoleEntityRef["kind"],
): ConsoleRefusal {
  return refuse(
    origin,
    PANE_ADDRESS_INVALID_CODE,
    `This pane's subject is a ${subjectKind} and it was opened on a ${addressedKind}. Nothing was read for it.`,
  );
}
