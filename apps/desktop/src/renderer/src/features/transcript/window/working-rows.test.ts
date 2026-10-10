// A row the window would let go while it still works loses what only the screen holds: a running
// call's place, an open ask, a reply's streaming text. These cases pin which rows work, and that
// each one's run group header works with it, since that header is all a folded group draws.

import { describe, expect, it } from "vitest";

import { type WaitingOnPersonRecords } from "#renderer/store/session/waiting-on-person/register.js";
import { runRow } from "../event-rows.test-support.js";
import { bindWorkingRowCheck, readWorkingRows } from "./working-rows.js";

const NOTHING_WAITING: WaitingOnPersonRecords = {
  requestsByKey: new Map(),
  runsByRunId: new Map(),
  isWindowHeadUnread: false,
};

function toolRow(
  id: string,
  sequence: number,
  type: "tool.invoked" | "tool.result",
  runId: string,
  toolCallId?: string,
): ReturnType<typeof runRow> {
  return runRow({
    id,
    sequence,
    type,
    category: "tool_activity",
    runId,
    position: sequence,
    payload: toolCallId === undefined ? {} : { toolCallId },
  });
}

describe("the working rows of a log", () => {
  it("counts a live run's unanswered call and newest reply, and an open ask", () => {
    const rows = [
      toolRow("answered", 1, "tool.invoked", "run-live", "call-1"),
      toolRow("answer", 2, "tool.result", "run-live", "call-1"),
      toolRow("running", 3, "tool.invoked", "run-live", "call-2"),
      runRow({
        id: "older-reply",
        sequence: 4,
        type: "assistant.message",
        category: "assistant_output",
        runId: "run-live",
        position: 4,
      }),
      runRow({
        id: "newest-reply",
        sequence: 5,
        type: "assistant.message",
        category: "assistant_output",
        runId: "run-live",
        position: 5,
      }),
      // Named no call, then a newer tool row of its run settled it.
      toolRow("unnamed-settled", 6, "tool.invoked", "run-live"),
      toolRow("later", 7, "tool.result", "run-live", "call-9"),
      toolRow("ended-unanswered", 8, "tool.invoked", "run-ended", "call-3"),
      toolRow("ended-unnamed", 9, "tool.invoked", "run-ended"),
      runRow({
        id: "asked",
        sequence: 10,
        type: "approval.requested",
        category: "approval_flow",
        runId: "run-ended",
        position: 10,
      }),
    ];
    const working = readWorkingRows(
      { rows, liveRunGroupKeys: new Set(["run-live"]) },
      {
        ...NOTHING_WAITING,
        requestsByKey: new Map([
          ["open", { openedAtSequence: 10, closedAtSequence: undefined }],
          ["closed", { openedAtSequence: 4, closedAtSequence: 6 }],
        ]),
      },
    );

    expect([...working.rowIds].sort()).toStrictEqual(["asked", "run-ended", "run-live", "running"]);
    expect([...working.newestReplyRowIds]).toStrictEqual(["newest-reply"]);
  });

  it("holds only a run's newest question, and only while the run waits for input", () => {
    // No event closes a question: an answered one stays in the log, and a run blocked on an
    // approval is not waiting on its question.
    const rows = [
      questionRow("answered-question", 1, "run-asking"),
      questionRow("open-question", 2, "run-asking"),
      questionRow("question-behind-approval", 3, "run-approving"),
    ];
    const working = readWorkingRows(
      { rows, liveRunGroupKeys: new Set(["run-asking", "run-approving"]) },
      {
        ...NOTHING_WAITING,
        runsByRunId: new Map([
          ["run-asking", { atSequence: 2, state: "waiting_for_input" }],
          ["run-approving", { atSequence: 3, state: "waiting_for_approval" }],
        ]),
      },
    );

    expect([...working.rowIds].sort()).toStrictEqual(["open-question", "run-asking"]);
  });

  it("counts a live run's newest reply, and its header, only while the reply streams", () => {
    const rows = [replyRow("older-reply", 1), replyRow("newest-reply", 2)];
    const revealingRowIds = new Set(["older-reply", "newest-reply"]);
    const isWorkingRow = bindWorkingRowCheck(
      readWorkingRows({ rows, liveRunGroupKeys: new Set(["run-live"]) }, NOTHING_WAITING),
      (rowId) => revealingRowIds.has(rowId),
    );

    expect(isWorkingRow("newest-reply")).toBe(true);
    expect(isWorkingRow("run-live")).toBe(true);
    expect(isWorkingRow("older-reply")).toBe(false);

    revealingRowIds.clear();

    expect(isWorkingRow("newest-reply")).toBe(false);
    expect(isWorkingRow("run-live")).toBe(false);
  });
});

function questionRow(id: string, sequence: number, runId: string): ReturnType<typeof runRow> {
  return runRow({
    id,
    sequence,
    type: "question.asked",
    category: "interactive_request",
    runId,
    position: sequence,
    payload: { questionId: `${id}-id` },
  });
}

function replyRow(id: string, sequence: number): ReturnType<typeof runRow> {
  return runRow({
    id,
    sequence,
    type: "assistant.message",
    category: "assistant_output",
    runId: "run-live",
    position: sequence,
  });
}
