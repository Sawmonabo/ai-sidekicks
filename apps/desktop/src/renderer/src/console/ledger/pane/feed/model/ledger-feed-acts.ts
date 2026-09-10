// What the feed offers the palette: six acts, resolved when one is pressed.
//
// The chords are contributed when the console composes, long before any feed exists,
// so an act cannot be a closure over one — it is resolved at PRESS time against
// whichever ledger is mounted then, and built here so the component that mounts them
// holds calls rather than closures. The workspace's follow seat is the same shape of
// thing about a different subject and lives in `ledger-actor-follow-seat.ts`.
//
// EVERY ACT IS A VALUE OVER STATE THE FEED ALREADY HOLDS. Nothing below reaches a
// store, a bridge, or the DOM: find's walk is `ledger-find.ts`', and the scroll is
// the viewport binding's. That is what lets the whole set be driven by a test with no
// render at all.
//
// ONE OF THE SIX CAN REFUSE, AND IT DOES NOT REFUSE AN ABSENT SURFACE.
// "Clear ledger filters" USED TO answer that this ledger had no filter surface at
// all, which was true while `filters.ts` had no caller: the model was complete and
// unreachable, so the press could only pretend. The facet bar reaches it now, so the
// act clears, and the one thing left to refuse is the state a person can still put
// the ledger in — nothing is narrowed, so there is nothing to widen. A no-op there
// would report success for work that did not happen, which is what the banner exists
// to prevent.
//
// "Collapse all finished run chapters" USED TO BE A SECOND SUCH REFUSAL, on the
// reasoning that every finished chapter was already folded and no control opened
// one. That reasoning was true of a ledger that drew no chapter header and false the
// moment one existed: the headers are disclosures, a person can open any of them,
// and this act now folds exactly the ones they opened. A typed refusal for a thing
// that exists is worse than no refusal at all.

import { useMemo } from "react";

import { refuse, type ConsoleRefusal } from "../../../../core/index.js";
import { raiseConsoleActRefusal } from "../../../../palette/index.js";

import {
  useMountedLedger,
  type FindStepDirection,
  type LedgerStructureActs,
} from "../../../structure/index.js";
import { type LedgerFilterState, type LedgerFindState } from "../../find/index.js";

/**
 * What "clear ledger filters" answers over a ledger nobody has narrowed.
 *
 * A refusal about the STATE, not about the surface: the facet bar is on screen and
 * the chips are pressable, and this says the ledger is showing everything already.
 * The alternative — clearing an unfiltered ledger silently — would report a change
 * to a person who pressed a row precisely because they were unsure whether one was
 * in effect.
 */
export const LEDGER_NOTHING_FILTERED_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.nothing_filtered",
  "This ledger is not narrowed. Every loaded entry is already showing, so there is nothing to clear.",
);

/** The state one window's acts are built over. */
export interface LedgerFeedActInputs {
  readonly find: LedgerFindState;
  /** The ledger's one scroll writer, for the walk's jumps. */
  readonly jumpToRow: (rowId: string) => void;
  readonly jumpToTail: () => void;
  /** Fold every terminal chapter the feed has open. */
  readonly collapseAllTerminalChapters: () => void;
  /** The narrowing the facet bar writes, and the one act that widens it back. */
  readonly ledgerFilter: LedgerFilterState;
}

/**
 * Build the acts a contributed ledger command runs.
 *
 * Written out member by member rather than assembled from a name list, for
 * `structure-commands.ts`' reason: a seventh act added to `LedgerStructureActs` fails
 * to compile here instead of silently reaching a mounted ledger through nothing.
 */
export function buildLedgerStructureActs(inputs: LedgerFeedActInputs): LedgerStructureActs {
  const stepAndJump = (direction: FindStepDirection): void => {
    const walked = inputs.find.step(direction);
    if (walked !== undefined) {
      inputs.jumpToRow(walked.match.rowId);
    }
  };
  return {
    openFind: inputs.find.open,
    stepFindNext: () => {
      stepAndJump("next");
    },
    stepFindPrevious: () => {
      stepAndJump("previous");
    },
    clearFilters: () => {
      if (!inputs.ledgerFilter.isFiltered) {
        raiseConsoleActRefusal(LEDGER_NOTHING_FILTERED_REFUSAL);
        return;
      }
      inputs.ledgerFilter.clear();
    },
    scrollToTail: inputs.jumpToTail,
    collapseAllTerminalChapters: inputs.collapseAllTerminalChapters,
  };
}

/**
 * Hold the palette's seat for as long as the feed is mounted.
 *
 * The `useMemo` is what keeps the acts object stable across a render that changed
 * none of its inputs; the seat reads through its own ref either way, so this is a
 * cost the feed avoids rather than a correctness the seat depends on.
 *
 * Nothing is handed back: every one of the six reaches a person through a palette row
 * or a chord, and none of them has a control of its own on this surface. A returned
 * set would be a second way in that no caller takes.
 */
export function useLedgerStructureActs(inputs: LedgerFeedActInputs): void {
  const { find, jumpToRow, jumpToTail, collapseAllTerminalChapters, ledgerFilter } = inputs;
  const acts = useMemo(
    () =>
      buildLedgerStructureActs({
        find,
        jumpToRow,
        jumpToTail,
        collapseAllTerminalChapters,
        ledgerFilter,
      }),
    [find, jumpToRow, jumpToTail, collapseAllTerminalChapters, ledgerFilter],
  );
  useMountedLedger(acts);
}
