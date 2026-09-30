import { useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { findRunGroupRunIdInWindow } from "../event-jump.js";
import { type RowJumpAbsence, type RowJumpOutcome } from "../row-jump.js";

/** What one arm offers, when there is an act that reaches the row. */
export interface TranscriptJumpReach {
  /** The button's words: the act, named for what it does to this transcript. */
  readonly label: string;
  /** Perform it. The jump itself is the deferred request, not this. */
  readonly perform: () => void;
}

/**
 * What one absence needs to decide on an act: the acts and the two readings the folded arm
 * consults, in one value, because the table below is keyed by absence.
 */
interface TranscriptJumpActContext {
  readonly foldedWindow: TranscriptWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  /** Open the shut run group holding this row, so the jump that follows can land. */
  readonly openFoldsHoldingRow: (row: TimelineRow) => void;
  readonly requestJump: (rowId: string) => void;
}

/** How one absence resolves its act, or answers that this transcript offers none. */
type TranscriptJumpAct = (
  row: TimelineRow,
  context: TranscriptJumpActContext,
) => TranscriptJumpReach | undefined;

/**
 * The act each absence deserves over this transcript, or `undefined` where none exists.
 *
 * Total over `ROW_JUMP_ABSENCES` by `satisfies`, so a new narrowing cannot fall through to an
 * act that cannot reach the row. The folded arm offers nothing when its group is already open
 * (toggling would close it and drop the rest of the run); a row the cap took has no act.
 */
const JUMP_ACTS = {
  "folded-into-run-group": (row, context) => {
    const runGroupRunId = findRunGroupRunIdInWindow(row, context.foldedWindow);
    if (runGroupRunId === undefined || context.openedTerminalRunIds.has(runGroupRunId)) {
      return undefined;
    }
    return {
      label: "Open that run group and go to it",
      perform: () => {
        context.openFoldsHoldingRow(row);
        context.requestJump(row.id);
      },
    };
  },
  "outside-window": () => undefined,
} satisfies Readonly<Record<RowJumpAbsence, TranscriptJumpAct>>;

/**
 * The act this transcript offers for one outcome, or `undefined` where it offers none.
 *
 * The two non-absence arms answer before the table: a row on screen needs no act, and a row
 * this window never held has none to offer.
 */
export function useTranscriptJumpReach(inputs: {
  readonly outcome: RowJumpOutcome | undefined;
  readonly foldedWindow: TranscriptWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly openFoldsHoldingRow: (row: TimelineRow) => void;
  readonly requestJump: (rowId: string) => void;
}): TranscriptJumpReach | undefined {
  const { outcome, foldedWindow, openedTerminalRunIds, openFoldsHoldingRow, requestJump } = inputs;
  return useMemo(() => {
    if (
      outcome === undefined ||
      outcome.status === "found" ||
      outcome.status === "not-in-loaded-log"
    ) {
      return undefined;
    }
    return JUMP_ACTS[outcome.status](outcome.row, {
      foldedWindow,
      openedTerminalRunIds,
      openFoldsHoldingRow,
      requestJump,
    });
  }, [outcome, foldedWindow, openedTerminalRunIds, openFoldsHoldingRow, requestJump]);
}
