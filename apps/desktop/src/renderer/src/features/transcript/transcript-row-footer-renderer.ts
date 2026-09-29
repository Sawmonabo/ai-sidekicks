// The timeline row's FOOTER seat — where a row-level control another plan owns sits.
//
// WHY A SECOND SEAT BESIDE THE ROW SLOT. `transcript-row-renderer.ts` hands out the whole
// row body, and the family that fills it owns everything inside. The edit-and-resend
// affordance is not inside it: the pencil belongs in the footer of a user
// message row, the body it opens is authored by the run-controls plan, and neither
// of those is the row's renderer. Handing that plan the row slot would make it the
// owner of every row in the ledger to obtain one control on one kind of row.
//
// AND WHY NOT THE COMPOSER'S ACCESSORY RAIL, WHICH ALREADY HAS A SLOT. That one is
// the EDITOR's seat — where the inline editor mounts once it is open. This is the
// seat for the thing that OPENS it, and the design places that in the row, not
// beside the composer. Two seats, two mounting families, one body between them.
//
// THE SEAT DERIVES NO ELIGIBILITY, AND THAT IS THE LOAD-BEARING RULE. Whether a
// person may correct a message is a daemon predicate; the affordance is a
// fail-closed PROJECTION of it and never a second source of truth. So this contract
// hands the body the row and the one fact the row cannot see about itself — whether
// the list ranks it superseded — and nothing about the caller, their role, or the
// run's state. A member saying "this caller may edit" would be exactly the second
// answer the design forbids, and it would be computed here, in the renderer.
//
// WHERE IT IS DRAWN IS THE ROW'S DECISION. The transcript row hands the owner's element to
// `MessageRow` as its edit control on a user's own message, where it sits beside Copy in
// the row's hover footer.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { SingleSlotSeat } from "@renderer/lib/single-entry-registry.js";

/** What the ledger hands a row footer. */
export interface TranscriptRowFooterRendererProps {
  /** The projected row, wire-verbatim, as `@ai-sidekicks/contracts` defines it. */
  readonly row: TimelineRow;
  /**
   * Whether a rollback boundary later in the list supersedes this row.
   *
   * A ranking over the rows AROUND this one, which no single row carries — the same
   * reason `TimelineRowSlotProps` carries it. A footer control that corrects history
   * needs it: the row it would rewind to has already been rewound past.
   */
  readonly isSuperseded: boolean;
}

/** The footer body. Returns `React.ReactNode` so the row can render it directly. */
export type TimelineRowFooterRenderer = (
  props: TranscriptRowFooterRendererProps,
) => React.ReactNode;

const timelineRowFooterSeat = new SingleSlotSeat<TimelineRowFooterRenderer>(
  "timeline row footer",
  "a user message carries one edit control; a second owner would make which one renders depend on import order",
);

/**
 * The call the footer's owner makes to fill the seat.
 *
 * Owner-scoped, so a second owner is a refusal naming both rather than a race decided
 * by import order.
 */
export function registerTranscriptRowFooterRenderer(
  owner: string,
  render: TimelineRowFooterRenderer,
): void {
  timelineRowFooterSeat.register({ owner, render });
}

/**
 * Release the seat.
 *
 * Test scaffolding: the seat is module-scope, so a case that fills it would leak
 * into the next one.
 */
export function unregisterTranscriptRowFooterRenderer(): void {
  timelineRowFooterSeat.unregister();
}

/** The footer body, or `undefined` while the seat is empty. */
export function findTranscriptRowFooterRenderer(): TimelineRowFooterRenderer | undefined {
  return timelineRowFooterSeat.renderer();
}
