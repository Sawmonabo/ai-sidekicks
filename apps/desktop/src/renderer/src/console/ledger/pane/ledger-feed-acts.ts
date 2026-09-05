// What the feed offers the palette: nine acts, resolved when one is pressed.
//
// The chords are contributed when the console composes, long before any feed exists,
// so an act cannot be a closure over one — it is resolved at PRESS time against
// whichever ledger is mounted then, and built here so the component that mounts them
// holds calls rather than closures. The workspace's follow seat is the same shape of
// thing about a different subject and lives in `ledger-actor-follow-seat.ts`.
//
// EVERY ACT IS A VALUE OVER STATE THE FEED ALREADY HOLDS. Nothing below reaches a
// store, a bridge, or the DOM: find's walk is `ledger-find.ts`', the scroll is
// the viewport binding's, and the replay engine is the replay state's. That is what
// lets the whole set be driven by a test with no render at all.
//
// THREE OF THE NINE TOUCH THE REPLAY ENGINE, AND ALL THREE REVEAL THE DOCK BEFORE
// THEY ACT. Engaging replay withholds rows, and the only other paths to the dock are the
// rail's hover and its focus — so a chord that started playback left the ledger
// collapsed to the window's first instant with no visible control to undo it. The
// dock's own density rule already names a chord among its triggers, so this is
// honouring that rather than adding a third one; conceal is unchanged, and the next
// pointer-leave or focus-out concludes it.
//
// TWO OF THE NINE CAN REFUSE, AND NEITHER REFUSES AN ABSENT SURFACE.
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

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { raiseConsoleActRefusal } from "../../frame/command-surface.js";
import {
  useMountedLedger,
  type FindStepDirection,
  type LedgerStructureActs,
} from "../structure/index.js";
import { type LedgerFindState } from "./ledger-find.js";
import { type LedgerFilterState } from "./ledger-narrowing.js";
import { type LedgerReplayState } from "./ledger-replay-window.js";

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

/**
 * What "replay from the row in view" answers when it has no row to start from.
 *
 * Two ways to get here and one sentence for both, because the next move is the
 * same: nothing has measured the box yet, or the window moved under the reader
 * between the anchor being read and the press. Substituting the window's head
 * instead would replay from the beginning — an act with its own control on the
 * dock, and not the one that was asked for.
 */
export const LEDGER_NO_REPLAY_ANCHOR_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.no_replay_anchor",
  "There is no row in view to replay from. Scroll to the entry you want to re-watch and try again.",
);

/** The state one window's acts are built over. */
export interface LedgerFeedActInputs {
  readonly find: LedgerFindState;
  readonly replay: LedgerReplayState;
  /** The ledger's one scroll writer, for the walk's jumps. */
  readonly jumpToRow: (rowId: string) => void;
  readonly jumpToTail: () => void;
  /** Fold every terminal chapter the feed has open. */
  readonly collapseAllTerminalChapters: () => void;
  /** The narrowing the facet bar writes, and the one act that widens it back. */
  readonly ledgerFilter: LedgerFilterState;
  /**
   * The row a "replay from here" starts at, or `undefined` for an unmeasured box.
   *
   * Read rather than passed as a callback because the act must be able to REFUSE
   * over an absent anchor, and a callback that answered nothing would leave the
   * press silent — which is the shape this whole module exists to prevent.
   */
  readonly replayAnchorRowId: string | undefined;
}

/**
 * Build the acts a contributed ledger command runs.
 *
 * Written out member by member rather than assembled from a name list, for
 * `structure-commands.ts`' reason: a ninth act added to `LedgerStructureActs` fails
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
    // One discriminator over the four-state union rather than a second boolean:
    // `paused` and `at-tail` both resume, and `idle` starts, so "playing" is the
    // only arm the press turns off.
    toggleReplay: () => {
      if (inputs.replay.position.state === "playing") {
        // Pause deliberately does not reveal: a pause on a dock already on screen
        // needs nothing, and `playing` is only reachable through a press that
        // revealed or a rail the reader is already in.
        inputs.replay.pause();
        return;
      }
      inputs.replay.reveal();
      inputs.replay.play();
    },
    jumpToNextSeam: () => {
      // The scrub inside this promotes an idle engine to `paused`, which counts as
      // engaged, so rows start being withheld the same way a play does — and behind
      // the same hidden dock unless the reveal comes with it.
      inputs.replay.reveal();
      inputs.replay.jumpToNextSeam();
    },
    replayFromRowInView: () => {
      const anchorRowId = inputs.replayAnchorRowId;
      if (anchorRowId === undefined) {
        raiseConsoleActRefusal(LEDGER_NO_REPLAY_ANCHOR_REFUSAL);
        return;
      }
      // Revealed BEFORE the scrub, like the seam jump: the scrub engages replay and
      // starts withholding rows, and doing that behind a hidden dock leaves a reader
      // holding a control they cannot see to undo.
      inputs.replay.reveal();
      if (!inputs.replay.replayFromRow(anchorRowId)) {
        // The engine could not place the row, so nothing moved. Said out loud rather
        // than scrubbed to a neighbour, which would move a reader to a row they did
        // not name and report it as the one they did.
        raiseConsoleActRefusal(LEDGER_NO_REPLAY_ANCHOR_REFUSAL);
      }
    },
  };
}

/**
 * Hold the palette's seat for as long as the feed is mounted, and hand the set back.
 *
 * The `useMemo` is what keeps the acts object stable across a render that changed
 * none of its inputs; the seat reads through its own ref either way, so this is a
 * cost the feed avoids rather than a correctness the seat depends on.
 *
 * RETURNED, because one act now has a control on screen as well as a chord. The
 * dock's "replay from the row in view" and the palette's row must be the same act
 * or they are two answers to one question — and the refusal is inside it, so a
 * second copy would be a second place the console decides what to say.
 */
export function useLedgerStructureActs(inputs: LedgerFeedActInputs): LedgerStructureActs {
  const {
    find,
    replay,
    jumpToRow,
    jumpToTail,
    collapseAllTerminalChapters,
    ledgerFilter,
    replayAnchorRowId,
  } = inputs;
  const acts = useMemo(
    () =>
      buildLedgerStructureActs({
        find,
        replay,
        jumpToRow,
        jumpToTail,
        collapseAllTerminalChapters,
        ledgerFilter,
        replayAnchorRowId,
      }),
    [
      find,
      replay,
      jumpToRow,
      jumpToTail,
      collapseAllTerminalChapters,
      ledgerFilter,
      replayAnchorRowId,
    ],
  );
  useMountedLedger(acts);
  return acts;
}
