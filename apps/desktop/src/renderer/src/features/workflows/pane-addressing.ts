// The address check both workflows panes make first: a pane pointed at a kind it does not open
// is refused, never thrown (a throw would take the whole pane layout down) and never read (a
// definition id read as a run id composes a well-formed request about something that does not
// exist). The sentence is composed once so the two panes cannot drift; each pane binds its own
// origin and kinds and lists the code in its own closed code set.

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { EntityRef } from "#renderer/lib/entity-kinds.js";

/**
 * The code a pane raises when its address names a kind it does not open. It is a const
 * assertion so each pane's refusal-code tuple can name it through `typeof` without widening
 * to `string[]`.
 */
export const PANE_ADDRESS_INVALID_CODE = "pane-address-invalid" as const;

/**
 * The refusal for a pane handed an entity of a kind it does not open. The detail names both
 * kinds and never an id: `detail` is one actionable sentence that is never the refused value.
 */
export function misaddressedPane(
  origin: string,
  subjectKind: EntityRef["kind"],
  addressedKind: EntityRef["kind"],
): Refusal {
  return refuse(
    origin,
    PANE_ADDRESS_INVALID_CODE,
    `This pane's subject is a ${subjectKind} and it was opened on a ${addressedKind}.`,
  );
}
