// The rows of the log whose state still moves: a tool call still running, and an ask still waiting
// on a person. A reply the reveal is still drawing is the reveal engine's to answer, so the feed
// asks it beside this set. The transcript window keeps such a row while it is near the reader;
// past the let-go distance it goes like a settled row and is drawn again, from the store and this
// register, when the reader comes back.

import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readQuestion } from "#renderer/store/session/events/question-reading.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { type WaitingOnPersonRecords } from "#renderer/store/session/waiting-on-person/register.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { rowGrowthOf, sequenceInsertionPosition } from "./row-positions.js";
import { type TranscriptWindowModel } from "./transcript-window.js";

/** The state a live run waits in while its question is open. */
const WAITING_FOR_INPUT: RunState = "waiting_for_input";

/**
 * The tool calls and questions of one session's log, kept across its windows, so a window that
 * only grew at its end costs its new rows. Which of them still change is read off the window's
 * live runs and the register of what waits on a person, each time it is asked.
 */
export class ChangingRowIndex {
  #rows: readonly TranscriptEventRow[] = [];
  #isInSequenceOrder = true;
  readonly #toolCallsByRunId = new Map<string, RunToolCalls>();
  readonly #questionRowIdsByRunId = new Map<string, string[]>();

  /**
   * The ids of the rows still changing, read off the window's rows and the session's register of
   * what waits on a person:
   *
   * - a `tool.invoked` row of a live run whose call no later `tool.result` or `tool.error` of that
   *   run has answered; one that names no call cannot be paired, so it counts as running while it
   *   is its run's newest tool row;
   * - the row that opened an approval or intervention the register still holds open;
   * - a question asked by a live run whose newest state waits on a person.
   */
  public changingRowIdsOf(
    window: TranscriptWindowModel,
    waitingOnPerson: WaitingOnPersonRecords,
  ): ReadonlySet<string> {
    this.#follow(window.rows);
    const changingRowIds = new Set<string>();
    for (const request of waitingOnPerson.requestsByKey.values()) {
      if (request.openedAtSequence !== undefined && request.closedAtSequence === undefined) {
        for (const rowId of this.#rowIdsAtSequence(request.openedAtSequence)) {
          changingRowIds.add(rowId);
        }
      }
    }
    for (const [runId, questionRowIds] of this.#questionRowIdsByRunId) {
      if (
        window.liveRunIds.has(runId) &&
        waitingOnPerson.runsByRunId.get(runId)?.state === WAITING_FOR_INPUT
      ) {
        for (const rowId of questionRowIds) {
          changingRowIds.add(rowId);
        }
      }
    }
    for (const [runId, toolCalls] of this.#toolCallsByRunId) {
      if (!window.liveRunIds.has(runId)) {
        continue;
      }
      for (const rowId of toolCalls.runningRowIdByCallId.values()) {
        changingRowIds.add(rowId);
      }
      if (toolCalls.unpairedRowId !== undefined) {
        changingRowIds.add(toolCalls.unpairedRowId);
      }
    }
    return changingRowIds;
  }

  // Takes the window's rows up: the new ones when the rows only grew at their end, else all of
  // them again. A row projected again with its type and payload is the same tool call or question.
  #follow(rows: readonly TranscriptEventRow[]): void {
    const growth = rowGrowthOf(this.#rows, rows);
    const isGrowth =
      growth !== undefined &&
      growth.replacedPositions.every((position) => {
        const previousRow = this.#rows[position] as TranscriptEventRow;
        const nextRow = rows[position] as TranscriptEventRow;
        return previousRow.type === nextRow.type && previousRow.payload === nextRow.payload;
      });
    const admitFrom = isGrowth ? growth.appendedFrom : 0;
    if (!isGrowth) {
      this.#isInSequenceOrder = true;
      this.#toolCallsByRunId.clear();
      this.#questionRowIdsByRunId.clear();
    }
    for (let position = admitFrom; position < rows.length; position += 1) {
      const row = rows[position] as TranscriptEventRow;
      const previousRow = position === 0 ? undefined : rows[position - 1];
      if (previousRow !== undefined && previousRow.sequence >= row.sequence) {
        this.#isInSequenceOrder = false;
      }
      this.#admit(row);
    }
    this.#rows = rows;
  }

  #admit(row: TranscriptEventRow): void {
    const questionRunId = readQuestion(row)?.runId;
    if (questionRunId !== undefined) {
      const questionRowIds = this.#questionRowIdsByRunId.get(questionRunId) ?? [];
      questionRowIds.push(row.id);
      this.#questionRowIdsByRunId.set(questionRunId, questionRowIds);
    }
    if (row.kind !== "run" || !isToolRow(row)) {
      return;
    }
    let toolCalls = this.#toolCallsByRunId.get(row.runId);
    if (toolCalls === undefined) {
      toolCalls = { runningRowIdByCallId: new Map(), unpairedRowId: undefined };
      this.#toolCallsByRunId.set(row.runId, toolCalls);
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

  #rowIdsAtSequence(sequence: number): readonly string[] {
    if (!this.#isInSequenceOrder) {
      return this.#rows.filter((row) => row.sequence === sequence).map((row) => row.id);
    }
    const rowIds: string[] = [];
    for (
      let position = sequenceInsertionPosition(this.#rows, sequence);
      this.#rows[position]?.sequence === sequence;
      position += 1
    ) {
      rowIds.push((this.#rows[position] as TranscriptEventRow).id);
    }
    return rowIds;
  }
}

/**
 * One run's tool calls still running, by call id, since two runs may reuse a provider's call id,
 * and its newest tool row when that row named no call.
 */
interface RunToolCalls {
  readonly runningRowIdByCallId: Map<string, string>;
  unpairedRowId: string | undefined;
}

function isToolRow(row: TranscriptEventRow): boolean {
  return row.type === "tool.invoked" || row.type === "tool.result" || row.type === "tool.error";
}
