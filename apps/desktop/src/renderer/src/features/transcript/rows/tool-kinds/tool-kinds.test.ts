// The reader over real payload records, fail-closed both ways: a row declaring nothing is every
// row the daemon sends today, and an unknown value is a newer daemon. The suite never restates
// the six names, so it cannot pass while the module reads a seventh.

import { describe, expect, it } from "vitest";

import {
  TOOL_KINDS,
  TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY,
  TOOL_KIND_PAYLOAD_KEY,
  TOOL_SERVER_LABEL_PAYLOAD_KEY,
  readDeclaredToolKind,
} from "./tool-kinds.js";

describe("a tool row's declared tool kind", () => {
  it("reads no tool kind off a payload that declares none", () => {
    // The registered tool payload carries a name, a call id and a duration, and no tool kind.
    expect(
      readDeclaredToolKind({ toolName: "Bash", toolCallId: "call-1", durationMs: 12 }),
    ).toBeUndefined();
  });

  it("reads every member of the declared vocabulary", () => {
    for (const toolKind of TOOL_KINDS) {
      expect(readDeclaredToolKind({ [TOOL_KIND_PAYLOAD_KEY]: toolKind })).toStrictEqual({
        kind: "declared",
        toolKind,
        serverLabel: undefined,
        argumentSummary: [],
      });
    }
  });

  it("names a value this build does not know rather than dropping it", () => {
    expect(readDeclaredToolKind({ [TOOL_KIND_PAYLOAD_KEY]: "notebook-cell" })).toStrictEqual({
      kind: "unrecognized",
      declared: "notebook-cell",
    });
  });

  it("carries the MCP server label the row names", () => {
    expect(
      readDeclaredToolKind({
        [TOOL_KIND_PAYLOAD_KEY]: "mcp",
        [TOOL_SERVER_LABEL_PAYLOAD_KEY]: "sentry",
      }),
    ).toStrictEqual({
      kind: "declared",
      toolKind: "mcp",
      serverLabel: "sentry",
      argumentSummary: [],
    });
  });

  it("carries the argument summary the daemon composed, in order", () => {
    const reading = readDeclaredToolKind({
      [TOOL_KIND_PAYLOAD_KEY]: "mcp",
      [TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY]: ["issueId: PROJ-4", "limit: 20"],
    });
    expect(reading).toStrictEqual({
      kind: "declared",
      toolKind: "mcp",
      serverLabel: undefined,
      argumentSummary: ["issueId: PROJ-4", "limit: 20"],
    });
  });

  it("drops a summary element that is not a string rather than stringifying it", () => {
    // `String({})` is `[object Object]`, which the daemon never sent.
    const reading = readDeclaredToolKind({
      [TOOL_KIND_PAYLOAD_KEY]: "mcp",
      [TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY]: ["issueId: PROJ-4", { limit: 20 }, 7, null],
    });
    expect(reading?.kind === "declared" ? reading.argumentSummary : undefined).toStrictEqual([
      "issueId: PROJ-4",
    ]);
  });

  it("treats a non-array summary as no summary at all", () => {
    const reading = readDeclaredToolKind({
      [TOOL_KIND_PAYLOAD_KEY]: "mcp",
      [TOOL_ARGUMENT_SUMMARY_PAYLOAD_KEY]: "issueId: PROJ-4",
    });
    expect(reading?.kind === "declared" ? reading.argumentSummary : undefined).toStrictEqual([]);
  });

  it("reads no tool kind off a declaration that is not a wire string", () => {
    // A number is not an unknown member; it is not a declaration at all.
    expect(readDeclaredToolKind({ [TOOL_KIND_PAYLOAD_KEY]: 4 })).toBeUndefined();
    expect(readDeclaredToolKind({ [TOOL_KIND_PAYLOAD_KEY]: null })).toBeUndefined();
  });
});
