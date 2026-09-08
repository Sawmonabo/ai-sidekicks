// The timeline row's FOOTER seat — where a row-level control another plan owns sits.
//
// WHY A SECOND SEAT BESIDE THE ROW SLOT. `timeline-row-slot.ts` hands out the whole
// row body, and the family that fills it owns everything inside. The edit-and-resend
// affordance is not inside it: the pencil belongs in the footer of a participant
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
// AND IT IS NOT THE CARD'S OWN `editAffordance` HOLE, WHICH IS WHY BOTH EXIST.
// `ledger/cards/MessageCard.tsx` carries an owner slot on its footer, and that slot
// lives INSIDE the fixture shell's row body — the body the timeline subtree replaces
// and deletes. A seat that dies with the shell is not a seat the affordance's owner
// can be handed, so the durable one is mounted by the FEED, outside the body, and
// survives that replacement. The card's hole stays a hole the shell hands nothing.
//
// WHICH ROWS GET ONE IS THE MOUNT'S DECISION AND IS WIRE-VERBATIM. The footer is
// offered on participant message rows, read off the row's own `type`. That is a
// fact the wire states, not a rule this console invents.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type OwnerSlotContract } from "../owner-slot.js";
import { SingleSlotSeat } from "./single-slot-seat.js";

/**
 * The three facts this seat answers. Developer-facing; never rendered.
 *
 * GOVERNANCE IDS LIVE IN THE PROSE ABOVE AND NOT IN THESE VALUES — the repository
 * keeps plan, spec, and task ids out of runtime strings, and every member here is a
 * string a program holds. The body is the queue-and-intervention plan's edit-and-
 * resend affordance; a reader who needs the identifier reads it in this comment.
 */
export const TIMELINE_ROW_FOOTER_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the queue-and-intervention plan's edit-and-resend affordance",
  mountObligation:
    "the ledger renders this footer under the body of a participant message row and supplies the row wire-verbatim beside the list's supersession ranking; the body owns the hover affordance, the eligibility predicate it projects from the daemon, and the intervention it dispatches",
  deleteShellIn: "the PR that registers the edit-and-resend affordance in this seat",
};

/** What the ledger hands a row footer. */
export interface TimelineRowFooterSlotProps {
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
export type TimelineRowFooterRenderer = (props: TimelineRowFooterSlotProps) => React.ReactNode;

const timelineRowFooterSeat = new SingleSlotSeat<TimelineRowFooterRenderer>(
  "timeline row footer",
  "the fixture shell is REPLACED by the affordance's owner, not registered beside it — delete the shell in the PR that registers the real footer",
);

/**
 * The call a footer owner makes to fill the seat.
 *
 * Both owners call this: the fixture shell first, then the affordance's owner in the
 * PR that deletes the shell. Owner-scoped, so forgetting the deletion is a refusal
 * naming both rather than a race decided by import order.
 */
export function registerTimelineRowFooterRenderer(
  owner: string,
  render: TimelineRowFooterRenderer,
): void {
  timelineRowFooterSeat.register({ owner, render });
}

/**
 * Release the seat.
 *
 * Test scaffolding: the seat is module-scope, so a case that fills it would leak
 * into the next one. The shell is retired by DELETING its registration.
 */
export function unregisterTimelineRowFooterRenderer(): void {
  timelineRowFooterSeat.unregister();
}

/** The footer body, or `undefined` while the seat is empty. */
export function timelineRowFooterRenderer(): TimelineRowFooterRenderer | undefined {
  return timelineRowFooterSeat.renderer();
}

/**
 * The row types that get a footer.
 *
 * A closed tuple with one member today rather than a bare comparison, so the
 * membership question has one home: the affordance corrects what a participant
 * SENT, and no other row is a thing a participant sent.
 */
export const TIMELINE_ROW_FOOTER_TYPES = ["user.message"] as const;

/** Whether this row is one the footer is offered on. Wire-verbatim, never inferred. */
export function rowTakesFooter(row: TimelineRow): boolean {
  return (TIMELINE_ROW_FOOTER_TYPES as readonly string[]).includes(row.type);
}
