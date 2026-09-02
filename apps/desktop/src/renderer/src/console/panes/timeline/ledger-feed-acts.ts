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
// TWO OF THE EIGHT REFUSE, AND THAT IS THE HONEST ANSWER RATHER THAN A GAP.
// `Spec-023 §Console Design (Meridian)` rule 8 says a surface never renders a
// default in place of a reading, and the same holds for an act: "clear filters" over
// a ledger with no filter control, and "collapse all finished run chapters" over one
// whose chapters fold by derivation and can be opened by nothing, are both presses
// that could only pretend. A no-op would report success for work that did not
// happen, so each states rule 9's banner instead, naming what is missing.

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
import { type LedgerFindState, type LedgerReplayState } from "./ledger-feed-model.js";

/**
 * What "clear ledger filters" answers on a build with nothing to clear.
 *
 * `filters.ts` holds the whole narrowing model and no surface drives it: the feed
 * renders the window unfiltered, and there is no menu, chip, or chord that narrows
 * it. Holding a `LedgerFilter` here anyway so the act had something to reset would
 * be a control nobody can reach, kept only to make a press look successful.
 */
export const LEDGER_NO_FILTER_SURFACE_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.no_filter_surface",
  "This ledger is not filtered. It offers no participant or event-family narrowing yet, so there is nothing to clear.",
);

/**
 * What "collapse all finished run chapters" answers when none is open.
 *
 * Rule 7 folds a terminal chapter by derivation — `ledger-window.ts` collapses every
 * row of every chapter the index reports terminal, on every pass — and the row seat
 * carries no control that opens one back up. So every finished chapter is already
 * folded whenever this act could run, and the fold that would answer it has nothing
 * to do.
 */
export const LEDGER_NO_OPENED_CHAPTER_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.no_opened_chapter",
  "Every finished run chapter here is already folded, and this ledger offers no control that opens one.",
);

/** The state one window's acts are built over. */
export interface LedgerFeedActInputs {
  readonly find: LedgerFindState;
  readonly replay: LedgerReplayState;
  /** The ledger's one scroll writer, for the walk's jumps. */
  readonly jumpToRow: (rowId: string) => void;
  readonly jumpToTail: () => void;
}

/**
 * Build the eight acts a contributed ledger command runs.
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
      raiseConsoleActRefusal(LEDGER_NO_FILTER_SURFACE_REFUSAL);
    },
    scrollToTail: inputs.jumpToTail,
    collapseAllTerminalChapters: () => {
      raiseConsoleActRefusal(LEDGER_NO_OPENED_CHAPTER_REFUSAL);
    },
    // One discriminator over the four-state union rather than a second boolean:
    // `paused` and `at-tail` both resume, and `idle` starts, so "playing" is the
    // only arm the press turns off.
    toggleReplay: () => {
      if (inputs.replay.position.state === "playing") {
        inputs.replay.pause();
        return;
      }
      inputs.replay.play();
    },
    jumpToNextSeam: inputs.replay.jumpToNextSeam,
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
  const { find, replay, jumpToRow, jumpToTail } = inputs;
  const acts = useMemo(
    () => buildLedgerStructureActs({ find, replay, jumpToRow, jumpToTail }),
    [find, replay, jumpToRow, jumpToTail],
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
