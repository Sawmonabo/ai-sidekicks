// A row the window would let go while it still works loses what only the screen holds: a running
// call's place, an open ask, a reply's streaming text. These cases pin which rows work.

import { describe, expect, it } from "vitest";

import { type WaitingOnPersonRecords } from "#renderer/store/session/waiting-on-person/register.js";
import { runRow } from "../event-rows.test-support.js";
import { readWorkingRows } from "./working-rows.js";

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

    expect([...working.rowIds].sort()).toStrictEqual(["asked", "running"]);
    expect([...working.newestReplyRowIds]).toStrictEqual(["newest-reply"]);
  });
});
