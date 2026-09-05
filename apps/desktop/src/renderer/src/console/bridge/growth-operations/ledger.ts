// The ledger plane's rows: one event's hydrated body, and the session's cost fold.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. Two of the
// single table's own sections share a module because they share a reader, and both
// comments are kept apart so the seam between them is still legible.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` is what makes the annotation below exhaustive in both directions: a row
 * this plane owns and forgot fails here, and a key that is not an operation id fails
 * here too. The ids are named rather than matched by an `orchestration` pattern
 * because that root is split across two planes — the agent plane holds the
 * child-run linkage read, which shares its reader and not this one's — and a pattern
 * would silently claim a row that belongs next door.
 */
type LedgerOperationId = Extract<
  GrowthOperationId,
  "hydratedEventRead" | "orchestrationCostReceiptRead" | "orchestrationBudgetRead"
>;

/** The ledger rows, in the order the single table carried them. */
export const LEDGER_GROWTH_OPERATIONS: Readonly<Record<LedgerOperationId, GrowthOperationEntry>> = {
  // The hydrated event read. It names no wire method for the same reason the two
  // identity rows above name none: the projection is built daemon-side and reaches
  // no bridge namespace, so an invented string here would be traceable to nothing.
  hydratedEventRead: op(
    "hydratedEventRead",
    "hydrated-event-read",
    "method",
    "open one event's machine-authored body — the assistant and tool prose the taxonomy records the existence of and the event payload does not carry — so a ledger row renders what was said rather than only that something was",
  ),
  // The session cost plane. Both ids are the registered method's TAIL without its
  // root, unlike the workflow and sidekick blocks above: the console calls exactly
  // these two verbs of a plane whose other pairs it never reaches, so a root folded
  // into both ids would lengthen every call site and disambiguate nothing. The
  // entry still names the method in full, so the transcription stays checkable.
  orchestrationCostReceiptRead: op(
    "orchestrationCostReceiptRead",
    "cost-receipt-read",
    "method",
    "read the committed-spend fold decomposed along its per-run, per-caused-by, and per-paying-account axes, each a partition of the same session figure rather than a second computation of it",
    "orchestration.costReceiptRead",
  ),
  orchestrationBudgetRead: op(
    "orchestrationBudgetRead",
    "cost-receipt-read",
    "method",
    "read the session's limits and the committed-spend figure admission compares against, served from the same accountant accessor the receipt is, so the two can never disagree",
    "orchestration.budgetRead",
  ),
};
