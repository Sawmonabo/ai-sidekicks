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
 * What one absence has to be told before it can decide on an act: the acts and the two
 * readings the folded arm consults, in one value, because the table below is keyed by
 * absence and cannot take an argument list per arm.
 */
interface LedgerJumpActContext {
  readonly foldedWindow: TranscriptWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  /** Open the shut run group holding this row, so the jump that follows can land. */
  readonly openFoldsHoldingRow: (row: TimelineRow) => void;
  readonly requestJump: (rowId: string) => void;
}

/** How one absence resolves its act, or answers that this transcript offers none. */
type LedgerJumpAct = (
  row: TimelineRow,
  context: LedgerJumpActContext,
) => TranscriptJumpReach | undefined;

/**
 * The act each absence deserves over THIS transcript, or `undefined` where none exists.
 *
 * A TABLE KEYED BY ABSENCE, total over `ROW_JUMP_ABSENCES` by `satisfies`, so a
 * narrowing added to the pipeline cannot compile and fall through to "Open that
 * run group and go to it", offering an act that could not reach the row.
 *
 * An act is resolved per outcome rather than per absence because both arms are only
 * conditionally reachable:
 *
 *   • A row a fold dropped is reachable by opening the run group that is holding it. That
 *     act does not reach a row whose run group is already OPEN and which sits past the
 *     run group's own row cap — toggling there would close the run group and take the rest
 *     of the run off screen too — so that case, and only that case, offers nothing.
 *   • A row the cap took is reachable by nothing. This console subscribes to the
 *     log and holds no read that fetches a range of it, so the honest surface is
 *     the sentence alone.
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
} satisfies Readonly<Record<RowJumpAbsence, LedgerJumpAct>>;

/**
 * The act this transcript offers for one outcome, or `undefined` where it offers none.
 *
 * The two non-absence arms answer before the table is consulted, and each for its
 * own reason rather than for one shared one: a row the viewport is showing needs no
 * act to reach it, and a row this window never held has none to offer.
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
