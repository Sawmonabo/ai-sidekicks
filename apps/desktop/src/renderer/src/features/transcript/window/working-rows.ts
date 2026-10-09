// The rows of a log that are still working: a tool call still running, an approval or
// intervention still open, a question its live run still waits on, and a reply still streaming.
// The transcript window never lets go of one; every other row goes when it is far enough from the
// reader, a live run's settled rows among them, and is read again from the store on return.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { readQuestion } from "#renderer/store/session/events/question-reading.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { type WaitingOnPersonRecords } from "#renderer/store/session/waiting-on-person/register.js";
import { classifyTranscriptRow } from "../rows/kind.js";
import { type TranscriptWindowModel } from "./transcript-window.js";

/** A log's working rows, read once per window and register revision. */
export interface WorkingRows {
  /** The running tool calls, open asks and waiting questions, by row id. */
  readonly rowIds: ReadonlySet<string>;
  /**
   * Each live run's newest reply, by row id: the one reply of the run that can still be
   * streaming, which it is while the reveal holds its lane.
   */
  readonly newestReplyRowIds: ReadonlySet<string>;
}

/**
 * The working rows of `window`'s log, read off its live runs and the session's register of what
 * waits on a person:
 *
 * - a `tool.invoked` row of a live run whose call no later `tool.result` or `tool.error` of that
 *   run answered; one naming no call counts as running while it is its run's newest tool row;
 * - the row that opened an approval or intervention the register still holds open;
 * - a question of a live run whose newest state waits on a person;
 * - each live run's newest reply, which is working only while it streams.
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
  const toolCallsByRunId = new Map<string, RunToolCalls>();
  const newestReplyRowIdByRunId = new Map<string, string>();
  for (const row of window.rows) {
    if (openRequestSequences.has(row.sequence)) {
      rowIds.add(row.id);
    }
    const liveRunId =
      row.kind === "run" && window.liveRunGroupKeys.has(row.runId) ? row.runId : undefined;
    if (liveRunId === undefined) {
      continue;
    }
    if (
      readQuestion(row) !== undefined &&
      waitingOnPerson.runsByRunId.get(liveRunId)?.needsAttention === true
    ) {
      rowIds.add(row.id);
    }
    if (classifyTranscriptRow(row)?.kind === "agent-message") {
      newestReplyRowIdByRunId.set(liveRunId, row.id);
    }
    if (isToolRow(row)) {
      followToolCall(toolCallsByRunId, liveRunId, row);
    }
  }
  for (const toolCalls of toolCallsByRunId.values()) {
    for (const rowId of toolCalls.runningRowIdByCallId.values()) {
      rowIds.add(rowId);
    }
    if (toolCalls.unpairedRowId !== undefined) {
      rowIds.add(toolCalls.unpairedRowId);
    }
  }
  return { rowIds, newestReplyRowIds: new Set(newestReplyRowIdByRunId.values()) };
}

/**
 * The check the transcript window asks of each row it would let go: one of `workingRows`, or a
 * live run's newest reply while `isRevealing` says it still streams. Built outside any render,
 * since a closure made in one shares that render's scope, and the window keeps its last check.
 */
export function bindWorkingRowCheck(
  workingRows: WorkingRows,
  isRevealing: (rowId: string) => boolean,
): (rowKey: string) => boolean {
  return (rowKey) =>
    workingRows.rowIds.has(rowKey) ||
    (workingRows.newestReplyRowIds.has(rowKey) && isRevealing(rowKey));
}

/**
 * One run's tool calls still running, by call id, since two runs may reuse a provider's call id,
 * and its newest tool row when that row named no call.
 */
interface RunToolCalls {
  readonly runningRowIdByCallId: Map<string, string>;
  unpairedRowId: string | undefined;
}

function followToolCall(
  toolCallsByRunId: Map<string, RunToolCalls>,
  runId: string,
  row: TranscriptEventRow,
): void {
  let toolCalls = toolCallsByRunId.get(runId);
  if (toolCalls === undefined) {
    toolCalls = { runningRowIdByCallId: new Map(), unpairedRowId: undefined };
    toolCallsByRunId.set(runId, toolCalls);
  }
  // Any newer tool row of the run settles the call that named none.
  toolCalls.unpairedRowId = undefined;
  const toolCallId = readWireString(projectedPayload(row)["toolCallId"]);
  if (row.type !== "tool.invoked") {
    if (toolCallId !== undefined) {
      toolCalls.runningRowIdByCallId.delete(toolCallId);
    }
  } else if (toolCallId === undefined) {
    toolCalls.unpairedRowId = row.id;
  } else {
    toolCalls.runningRowIdByCallId.set(toolCallId, row.id);
  }
}

function isToolRow(row: TranscriptEventRow): boolean {
  return row.type === "tool.invoked" || row.type === "tool.result" || row.type === "tool.error";
}
