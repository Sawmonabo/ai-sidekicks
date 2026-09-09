// The floor seat: how a run control asks the deck to hand a person the work.
//
// "Step in" is one press and three acts — pause the run, put the run's execution root
// on the deck, and address the composer at that run as a steer. The pause is the run
// control's own and reaches the daemon directly. The other two are the DECK'S: which
// panes are open, which one is focused, and therefore what the composer is addressed
// to are all facts about the deck, and the runs family holds none of them.
//
// So the request travels as a SEAT rather than as an import, like every other thing
// two view families hand each other here. What crosses is what the run control can
// honestly say — the run's own identifier — and nothing it derived: which agent that
// run belongs to and which checkout it executes in are both resolved on the deck's
// side, from the session store and from the daemon's own execution-root read.
//
// WHY THE COMPOSER IS ADDRESSED BY FOCUSING A PANE, AND NOT BY A SECOND SEAT. The
// composer resolves its target from the deck's focused pane: a focused pane over an
// agent entity is the provider-bound path, and the addressed run is that agent's
// newest steerable one. So "address the composer at this run" IS "focus that run's
// agent pane" — one mechanism, already built and already tested. A seat that reached
// into the composer to set an address would be a second source of truth for what Send
// is pointing at, and the two would disagree the first time somebody clicked a pane.
//
// THE OUTCOME IS RETURNED, AND EVERY ARM IS A THING THE RECEIPT SAYS. A person who
// pressed one control and got two of three acts needs to be told which two: a run
// whose agent this store has never seen cannot address the composer, and a run that
// names no live execution root has no worktree pane to open. Both are ordinary states
// of a real session rather than failures, and neither is a reason to withhold the
// pause that already happened.
//
// The seat's absence is a real state too, and the caller renders it: an unfilled seat
// means no deck is mounted in this window — a run control in an auxiliary window, or
// a surface composed without one — which is a thing to say rather than a press that
// silently does two thirds of its job.

import { SingleSlotSeat } from "./single-slot-seat.js";

/** Which run a person is taking the floor from. */
export interface TakeTheFloorRequest {
  /** Wire-verbatim, as the run control received it. Never re-parsed here. */
  readonly runId: string;
}

/**
 * What the deck did about the run's execution root.
 *
 * FOUR ARMS RATHER THAN A BOOLEAN, because "no worktree pane opened" has three
 * different causes and each is a thing a person can act on. `opened` is the checkout
 * on the deck — opened rather than focused, because the composer's own address is
 * what takes the focus at the end of the act. `unnamed` is a
 * run that created no live checkout — an ephemeral clone, a read-only workspace, a
 * root already retired. `ambiguous` is more than one live checkout naming this run,
 * which the console refuses to pick between rather than opening whichever the read
 * listed first. `unreadable` is the execution-root read itself refusing, which is the
 * daemon's own answer and is rendered as one.
 */
export const FLOOR_WORKTREE_DISPOSITIONS = [
  "opened",
  "unnamed",
  "ambiguous",
  "unreadable",
] as const;

/** One disposition. Derived from the enumeration, never restated. */
export type FloorWorktreeDisposition = (typeof FLOOR_WORKTREE_DISPOSITIONS)[number];

/** What taking the floor moved, or why the deck could not be asked at all. */
export type TakeTheFloorOutcome =
  | {
      readonly status: "moved";
      /**
       * Whether the composer is now addressed at this run.
       *
       * False when the session store names no agent for the run — the composer stays
       * on the channel path, which is the honest answer rather than a target guessed
       * from the newest row.
       */
      readonly composerAddressed: boolean;
      readonly worktree: FloorWorktreeDisposition;
    }
  | { readonly status: "no-deck" };

/** The deck's half of Step in. Asynchronous: the execution root is a daemon read. */
export type TakeTheFloorHandler = (request: TakeTheFloorRequest) => Promise<TakeTheFloorOutcome>;

const takeTheFloorSeat = new SingleSlotSeat<TakeTheFloorHandler>(
  "take the floor",
  "one deck holds the panes a session view shows; a second owner would make which deck moves depend on import order",
);

/** The call the family that owns the deck makes to fill the seat. */
export function registerTakeTheFloorHandler(owner: string, handle: TakeTheFloorHandler): void {
  takeTheFloorSeat.register({ owner, render: handle });
}

/**
 * Release the seat.
 *
 * Called on unmount, and by a test that filled it: the seat is module-scope, so a case
 * that left a handler behind would leak into the next one.
 */
export function unregisterTakeTheFloorHandler(): void {
  takeTheFloorSeat.unregister();
}

/**
 * Ask the mounted deck to hand this run's work to the person.
 *
 * Answers `no-deck` rather than throwing or resolving to a moved-nothing outcome: the
 * caller has a receipt to compose and needs the difference between "the deck moved and
 * found no checkout" and "there was no deck to ask".
 */
export async function takeTheFloor(request: TakeTheFloorRequest): Promise<TakeTheFloorOutcome> {
  const handle = takeTheFloorSeat.renderer();
  if (handle === undefined) {
    return { status: "no-deck" };
  }
  return handle(request);
}
