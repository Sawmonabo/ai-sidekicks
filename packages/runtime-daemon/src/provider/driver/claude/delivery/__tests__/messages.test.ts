// `messages.ts`: an assistant frame's text and thinking are drawn under their message's id, or the
// frame's own uuid where it names none; a file-changing call's result row carries its patch with
// the lines it added and removed, read from Claude Code's own `gitDiff` or counted off its hunks,
// for each of the four tools that change a file.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it } from "vitest";

import {
  readClaudeAssistantRows,
  readClaudeUserRows,
  type ClaudeOpenToolCall,
} from "../messages.js";

const RUN = { sessionId: "session-1" as SessionId, runId: "run-1" as RunId };
const TOOL_CALL_ID = "toolu_patch";

// The body of the lone result row of `toolName`'s call answered with `toolUseResult`.
function readResultBody(toolName: string, toolUseResult: unknown): unknown {
  const openToolCalls = new Map<string, ClaudeOpenToolCall>();
  readClaudeAssistantRows(
    { message: { content: [{ type: "tool_use", id: TOOL_CALL_ID, name: toolName, input: {} }] } },
    RUN,
    openToolCalls,
    0,
  );
  const reading = readClaudeUserRows(
    {
      message: { content: [{ type: "tool_result", tool_use_id: TOOL_CALL_ID, content: "done" }] },
      tool_use_result: toolUseResult,
    },
    RUN,
    openToolCalls,
    0,
  );
  const [row] = reading.rows;
  return row === undefined ? undefined : JSON.parse(row.body);
}

const TWO_HUNKS = [
  { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "-b", "+c", "+d"] },
  { oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, lines: ["-x", "+y"] },
];

describe("readClaudeUserRows patch counts", () => {
  it.each([
    {
      toolName: "Edit",
      result: { filePath: "/w/a.ts", structuredPatch: TWO_HUNKS.slice(0, 1) },
      file: {
        path: "/w/a.ts",
        patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d",
        additions: 2,
        deletions: 1,
      },
    },
    {
      toolName: "MultiEdit",
      result: { filePath: "/w/a.ts", structuredPatch: TWO_HUNKS },
      file: {
        path: "/w/a.ts",
        patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n@@ -9,1 +10,1 @@\n-x\n+y",
        additions: 3,
        deletions: 2,
      },
    },
    {
      // Claude Code's own counts win over a count of the hunks.
      toolName: "Write",
      result: {
        filePath: "/w/new.ts",
        structuredPatch: TWO_HUNKS,
        gitDiff: { filename: "/w/new.ts", patch: "+one\n+two", additions: 2, deletions: 0 },
      },
      file: { path: "/w/new.ts", patch: "+one\n+two", additions: 2, deletions: 0 },
    },
    {
      toolName: "NotebookEdit",
      result: { notebook_path: "/w/book.ipynb" },
      file: { path: "/w/book.ipynb", unavailable: "absent" },
    },
  ])("reads the patch of a $toolName call", ({ toolName, result, file }) => {
    expect(readResultBody(toolName, result)).toStrictEqual({ files: [file] });
  });

  it("refuses counts off a hunk whose header is malformed", () => {
    const malformed = [{ oldStart: 1, oldLines: "two", newStart: 1, newLines: 1, lines: ["+a"] }];

    expect(
      readResultBody("Edit", { filePath: "/w/a.ts", structuredPatch: malformed }),
    ).toStrictEqual({ files: [{ path: "/w/a.ts", unavailable: "absent" }] });
  });
});

describe("readClaudeAssistantRows message identity", () => {
  it("draws text and thinking whose frame names no message id, under the frame's own uuid", () => {
    const rows = readClaudeAssistantRows(
      {
        uuid: "frame-uuid-1",
        message: {
          content: [
            { type: "thinking", thinking: "checking the test" },
            { type: "text", text: "The test passes now." },
          ],
        },
      },
      RUN,
      new Map(),
      0,
    );

    expect(rows.map((row) => [row.row.type, row.row.payload, row.body])).toStrictEqual([
      [
        "assistant.thinking_update",
        { ...RUN, providerMessageId: "frame-uuid-1" },
        "checking the test",
      ],
      ["assistant.message", { ...RUN, providerMessageId: "frame-uuid-1" }, "The test passes now."],
    ]);
  });
});
