// The ledger family's pane door — where it claims `timeline` on the deck.
//
// WHY THE CLAIM LIVES HERE AND NOT IN `ledger/index.ts`. The seat board next door
// asks each family to register "from its own `index.ts`", and this IS the ledger's
// own — the family spans `ledger/`, `panes/timeline/`, and `workspace/`, and this is
// the door its pane body is behind. Putting the claim in `ledger/index.ts` instead
// would make that file import this one while this one imports the ledger frame back,
// which is a cycle the layering gate fails and, worse, a module-initialisation order
// nobody can review. The direction is fixed the other way: the pane body reaches
// down into the family's frame, and the family's own door never reaches up into the
// pane.
//
// IT TAKES THE REGISTRY IT IS HANDED. `registerConsolePanes` passes one, so a test
// composes into a registry it owns and an auxiliary window composes a subset without
// a second code path. Reaching for the module-scope singleton instead would leave
// both of those holding an empty table while the console still worked.
//
// The family's stylesheet is imported by `ledger/index.ts`, which is the family's one
// door for it; both doors are composed by `console/families.ts`, so a window that has
// this pane has that sheet.

import { createElement } from "react";

import { refuse } from "../../core/index.js";
import { InlineRefusal } from "../../primitives/index.js";
import { type ConsolePaneContext, type ConsolePaneRegistry } from "../../seats/index.js";
import { TimelinePane } from "./TimelinePane.js";

/** The owner string this family's pane claim carries, on `registerLedger`'s terms. */
const LEDGER_PANE_OWNER = "ledger";

/**
 * Claim the deck's `timeline` kind.
 *
 * The descriptor says WHO owns the kind and WHAT mounts for it, and nothing else.
 * Whether a full-screen timeline may be torn off into an auxiliary window is a
 * property of the KIND — `seats/pane-kinds.ts` derives it from the window model's own
 * closed set through `isDetachablePaneKind` — so a family answering it per descriptor
 * would be six families answering a question the window model settles.
 *
 * The body is mounted with no close and no open-in-window handler: both are the
 * deck's acts, and a control whose act nobody can perform is left out rather than
 * drawn disabled.
 */
export function registerLedgerPanes(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "timeline",
    owner: LEDGER_PANE_OWNER,
    render: mountTimelinePane,
  });
}

/**
 * Mount the pane, or say the address it was handed is not one this body serves.
 *
 * The registry resolves a body BY kind, so the mismatched arm is unreachable through
 * the deck — and it is rendered rather than thrown anyway, because the guard is what
 * narrows the union for the body below it, and `core/refusal.ts`' rule is that a
 * boundary refuses by name and leaves the rest of the surface standing. A throw here
 * would take down whatever deck the pane was mounted in.
 */
function mountTimelinePane(context: ConsolePaneContext): React.ReactNode {
  if (context.kind !== "timeline") {
    const refusal = refuse(
      LEDGER_PANE_OWNER,
      "pane-address-kind-mismatch",
      `the timeline body was mounted at a "${context.kind}" address, which is a view of something else`,
    );
    return createElement(InlineRefusal, refusal);
  }
  return createElement(TimelinePane, { context });
}
