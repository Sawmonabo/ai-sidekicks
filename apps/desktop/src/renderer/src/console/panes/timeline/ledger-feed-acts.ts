// What the feed offers the rest of the console: the palette's eight acts, and the
// workspace's follow seat.
//
// WHY THESE TWO LIVE IN ONE MODULE. They are the same shape of thing — a caller
// outside this pane naming something for the mounted ledger to do — and each is
// reached through a seat rather than through an import, because the caller is
// composed long before any feed exists. The palette's chords are contributed when
// the console composes; a cast chip is pressed in a family that may not import this
// one. Both therefore resolve their target at ACT time, and both are built here so
// the component that mounts them holds calls rather than closures.
//
// EVERY ACT IS A VALUE OVER STATE THE FEED ALREADY HOLDS. Nothing below reaches a
// store, a bridge, or the DOM: find's walk is `ledger-feed-model.ts`', the scroll is
// the viewport binding's, and the replay engine is the replay state's. That is what
// lets the whole set be driven by a test with no render at all.
//
// TWO OF THE EIGHT TOUCH THE REPLAY ENGINE, AND BOTH REVEAL THE DOCK BEFORE THEY
// ACT. Engaging replay withholds rows, and the only other paths to the dock are the
// rail's hover and its focus — so a chord that started playback left the ledger
// collapsed to the window's first instant with no visible control to undo it. The
// dock's own density rule already names a chord among its triggers, so this is
// honouring that rather than adding a third one; conceal is unchanged, and the next
// pointer-leave or focus-out concludes it.
//
// ONE OF THE EIGHT REFUSES, AND IT REFUSES A STATE RATHER THAN AN ABSENCE.
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

import { useEffect, useMemo, useRef } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { raiseConsoleActRefusal } from "../../frame/command-surface.js";
import { useMountedLedger, type LedgerStructureActs } from "../../ledger/structure/index.js";
import {
  actorFollowHandler,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
  type ActorFollowHandler,
  type ActorFollowOutcome,
  type ActorFollowRequest,
} from "../../workspace/index.js";
import {
  type LedgerFilterState,
  type LedgerFindState,
  type LedgerReplayState,
} from "./ledger-feed-model.js";

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
  readonly replay: LedgerReplayState;
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
 * `structure-commands.ts`' reason: a ninth act added to `LedgerStructureActs` fails
 * to compile here instead of silently reaching a mounted ledger through nothing.
 */
export function buildLedgerStructureActs(inputs: LedgerFeedActInputs): LedgerStructureActs {
  const stepAndJump = (direction: "next" | "previous"): void => {
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
  };
}

/**
 * Hold the palette's seat for as long as the feed is mounted.
 *
 * The `useMemo` is what keeps the acts object stable across a render that changed
 * none of its inputs; the seat reads through its own ref either way, so this is a
 * cost the feed avoids rather than a correctness the seat depends on.
 */
export function useLedgerStructureActs(inputs: LedgerFeedActInputs): void {
  const { find, replay, jumpToRow, jumpToTail, collapseAllTerminalChapters, ledgerFilter } = inputs;
  const acts = useMemo(
    () =>
      buildLedgerStructureActs({
        find,
        replay,
        jumpToRow,
        jumpToTail,
        collapseAllTerminalChapters,
        ledgerFilter,
      }),
    [find, replay, jumpToRow, jumpToTail, collapseAllTerminalChapters, ledgerFilter],
  );
  useMountedLedger(acts);
}

/** What the follow handler resolves a request against. */
export interface ActorFollowInputs {
  /** The rows the viewport holds — the only rows a jump can arrive at. */
  readonly visibleRows: readonly TimelineRow[];
  readonly jumpToRow: (rowId: string) => void;
}

/**
 * Resolve a cast chip's follow request against this window's own rows.
 *
 * The request carries a wire `sequence` rather than a row id, because row identity
 * is minted by this family's projection and the workspace holds none of it. So the
 * resolution is a lookup over the VISIBLE rows — not the loaded log — for the
 * reason find's walk is: `jumpToRow` scrolls to what the viewport reconciled, and a
 * row the cap has taken out would report a reveal and move nothing.
 *
 * The participant id is deliberately not re-checked against the row. The workspace
 * resolved this sequence from that participant's newest event over the same log,
 * and asking the projection to agree would be a second derivation of attribution —
 * which is exactly what the seat exists to keep out of two families at once.
 */
export function buildActorFollowHandler(inputs: ActorFollowInputs): ActorFollowHandler {
  return (request: ActorFollowRequest): ActorFollowOutcome => {
    const row = inputs.visibleRows.find(
      (candidate) => candidate.sequence === request.newestSequence,
    );
    if (row === undefined) {
      return "row-not-in-view";
    }
    inputs.jumpToRow(row.id);
    return "revealed";
  };
}

/** The owner string the ledger's follow claim carries, on `registerLedger`'s terms. */
const LEDGER_FOLLOW_SEAT_OWNER = "ledger";

/**
 * Fill the workspace's follow seat for as long as the feed is mounted.
 *
 * The registered handler reads the live inputs through a ref rather than being
 * re-registered whenever the window moves — `useMountedLedger`'s shape, for its
 * reason: a feed rebuilds its callbacks on every render, and a seat re-claimed on
 * each pass would churn a registry whose whole job is to hold one occupant.
 *
 * Release is CONDITIONAL, unlike the palette seat's, because this seat's own
 * release takes no argument: a feed unmounting after a second one had claimed the
 * seat would otherwise empty it under the ledger still on screen.
 */
export function useActorFollowSeat(inputs: ActorFollowInputs): void {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const forwarding = useMemo<ActorFollowHandler>(
    () => (request) => buildActorFollowHandler(inputsRef.current)(request),
    [],
  );
  useEffect(() => {
    registerActorFollowHandler(LEDGER_FOLLOW_SEAT_OWNER, forwarding);
    return () => {
      if (actorFollowHandler() === forwarding) {
        unregisterActorFollowHandler();
      }
    };
  }, [forwarding]);
}
