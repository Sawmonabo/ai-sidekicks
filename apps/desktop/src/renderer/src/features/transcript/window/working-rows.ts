// The rows of a log that are still working: a tool call still running, an approval or
// intervention still open, a question its live run still waits on, and a reply still streaming.
// The transcript window never lets go of one, nor of the header of the run group it sits in, which
// is all a folded group draws; every other row goes when it is far enough from the reader, a live
// run's settled rows among them, and is read again from the store on return.

import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { readQuestion } from "#renderer/store/session/events/question-reading.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { type WaitingOnPersonRecords } from "#renderer/store/session/waiting-on-person/register.js";
import { classifyTranscriptRow } from "../rows/kind.js";
import { readRunGroupKey } from "../runs/groups.js";
import { type TranscriptWindowModel } from "./transcript-window.js";

/** The state a live run waits in while its newest question is open. */
const WAITING_FOR_INPUT: RunState = "waiting_for_input";

/** A log's working rows, read once per window and register revision. */
export interface WorkingRows {
  /**
   * The running tool calls, open asks and open questions, by row id, and the run id of each one's
   * run group, which is its header's key.
   */
  readonly rowIds: ReadonlySet<string>;
  /**
   * Each live run's newest reply, by run id: the one reply of the run that can still be
   * streaming, which it is while the reveal holds its lane.
   */
  readonly newestReplyRowIdByRunId: ReadonlyMap<string, string>;
  /** The same replies, by row id. */
  readonly newestReplyRowIds: ReadonlySet<string>;
}

/**
 * The working rows of `window`'s log, read off its live runs and the session's register of what
 * waits on a person:
 *
 * - a `tool.invoked` row of a live run whose call no later `tool.result` or `tool.error` of that
 *   run answered; one naming no call counts as running while it is its run's newest tool row;
 * - the row that opened an approval or intervention the register still holds open;
 * - a live run's newest question while the run waits for input: no event closes a question, and the
 *   run moves on once it is answered;
 * - each live run's newest reply, which is working only while it streams.
 *
 * Each working row's run id is working too, so the run group's header stays.
 */
export function readWorkingRows(
  window: Pick<TranscriptWindowModel, "rows" | "liveRunGroupKeys">,
  waitingOnPerson: WaitingOnPersonRecords,
): WorkingRows {
  const openRequestSequences = new Set<number>();
  for (const request of waitingOnPerson.requestsByKey.values()) {
    if (request.openedAtSequence !== undefined && request.closedAtSequence === undefined) {
      openRequestSequences.add(request.openedAtSequence);
    }
  }
  const rowIds = new Set<string>();
  const holdRow = (row: TranscriptEventRow): void => {
    rowIds.add(row.id);
    const runGroupKey = readRunGroupKey(row);
    if (runGroupKey !== undefined) {
      rowIds.add(runGroupKey);
    }
  };
  const toolCallsByRunId = new Map<string, RunToolCalls>();
  const newestQuestionByRunId = new Map<string, TranscriptEventRow>();
  const newestReplyRowIdByRunId = new Map<string, string>();
  for (const row of window.rows) {
    if (openRequestSequences.has(row.sequence)) {
      holdRow(row);
    }
    const liveRunId =
      row.kind === "run" && window.liveRunGroupKeys.has(row.runId) ? row.runId : undefined;
    if (liveRunId === undefined) {
      continue;
    }
    const kind = classifyTranscriptRow(row)?.kind;
    if (readQuestion(row) !== undefined) {
      newestQuestionByRunId.set(liveRunId, row);
    } else if (kind === "agent-message") {
      newestReplyRowIdByRunId.set(liveRunId, row.id);
    } else if (kind === "tool-call") {
      followToolCall(toolCallsByRunId, liveRunId, row);
    }
  }
  for (const [runId, question] of newestQuestionByRunId) {
    if (waitingOnPerson.runsByRunId.get(runId)?.state === WAITING_FOR_INPUT) {
      holdRow(question);
    }
  }
  for (const toolCalls of toolCallsByRunId.values()) {
    for (const toolRow of toolCalls.runningRowByCallId.values()) {
      holdRow(toolRow);
    }
    if (toolCalls.unpairedRow !== undefined) {
      holdRow(toolCalls.unpairedRow);
    }
  }
  return {
    rowIds,
    newestReplyRowIdByRunId,
    newestReplyRowIds: new Set(newestReplyRowIdByRunId.values()),
  };
}

/**
 * The check the transcript window asks of each row it would let go: one of `workingRows`, or a
 * live run's newest reply, or its run group's header, while `isRevealing` says the reply still
 * streams. The window keeps its last check, and a closure keeps alive every variable of the scope
 * it was made in, so it is made here, in a scope holding only these two, and not in the memo's
 * factory, whose scope is the render's.
 */
export function bindWorkingRowCheck(
  workingRows: WorkingRows,
  isRevealing: (rowId: string) => boolean,
): (rowKey: string) => boolean {
  return (rowKey) => {
    if (workingRows.rowIds.has(rowKey)) {
      return true;
    }
    if (workingRows.newestReplyRowIds.has(rowKey)) {
      return isRevealing(rowKey);
    }
    const replyRowId = workingRows.newestReplyRowIdByRunId.get(rowKey);
    return replyRowId !== undefined && isRevealing(replyRowId);
  };
}

/**
 * One run's tool calls still running, by call id, since two runs may reuse a provider's call id,
 * and its newest tool row when that row named no call.
 */
interface RunToolCalls {
  readonly runningRowByCallId: Map<string, TranscriptEventRow>;
  unpairedRow: TranscriptEventRow | undefined;
}

function followToolCall(
  toolCallsByRunId: Map<string, RunToolCalls>,
  runId: string,
  row: TranscriptEventRow,
): void {
  let toolCalls = toolCallsByRunId.get(runId);
  if (toolCalls === undefined) {
    toolCalls = { runningRowByCallId: new Map(), unpairedRow: undefined };
    toolCallsByRunId.set(runId, toolCalls);
  }
  // Any newer tool row of the run settles the call that named none.
  toolCalls.unpairedRow = undefined;
  const toolCallId = readWireString(projectedPayload(row)["toolCallId"]);
  if (row.type !== "tool.invoked") {
    if (toolCallId !== undefined) {
      toolCalls.runningRowByCallId.delete(toolCallId);
    }
  } else if (toolCallId === undefined) {
    toolCalls.unpairedRow = row;
  } else {
    toolCalls.runningRowByCallId.set(toolCallId, row);
  }
}
