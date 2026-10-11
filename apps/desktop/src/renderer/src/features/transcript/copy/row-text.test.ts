import { describe, expect, it } from "vitest";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import { TEXT_PIECE_LENGTH } from "#renderer/lib/text-pieces.js";
import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import { sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
import { publishedTextOf } from "../reveal/published-text.js";
import { UNAVAILABLE_BODY_TITLE } from "../rows/bodies/UnavailableBody.js";
import { type RowRevealContextValue } from "../reveal/components/RowRevealProvider.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { readRowText } from "./row-text.js";

/**
 * The sources a row the window let go is read from: a log holding it, no lane streaming it, nothing
 * it drew kept, and its fold as `density` says.
 */
function sourcesHolding(
  row: ReturnType<typeof sampleRunRow>,
  density: "collapsed" | "expanded" = "collapsed",
  liveOutput?: string,
): Parameters<typeof readRowText>[1] {
  const transcriptWindow: Pick<
    TranscriptWindowModel,
    "runGroupByHeaderKey" | "rowsByKey" | "supersededRowIds" | "systemMessageByRowId"
  > = {
    runGroupByHeaderKey: new Map(),
    rowsByKey: new Map([[row.id, row]]),
    supersededRowIds: new Set(),
    systemMessageByRowId: new Map(),
  };
  const reveal: Pick<RowRevealContextValue, "publishedTextFor" | "drawnReplyText"> = {
    publishedTextFor: () => (liveOutput === undefined ? undefined : publishedTextOf(liveOutput)),
    drawnReplyText: {
      drawnTextOf: () => undefined,
    } as unknown as RowRevealContextValue["drawnReplyText"],
  };
  return {
    transcriptWindow: transcriptWindow as TranscriptWindowModel,
    reveal: reveal as RowRevealContextValue,
    densityOf: () => density,
    fullBodyOf: () => undefined,
    clockLocale: "en-US",
    view: TASKS_AT_ONCE,
  };
}

describe("a whole row's copied text", () => {
  it("copies nothing for a reasoning row that draws no text, as the screen shows none", () => {
    const row = sampleRunRow({ id: "event-01", type: "assistant.thinking_update" });
    expect(readRowText(row.id, sourcesHolding(row))).toBeUndefined();
  });

  it("copies the body the log stores for a row, or the sentence it draws for none", async () => {
    const reply = {
      ...sampleRunRow({ id: "event-02", type: "assistant.message" }),
      content: { status: "available", body: "The **stored** reply." },
    } as const;
    expect(readRowText(reply.id, sourcesHolding(reply))).toStrictEqual({
      flavor: "markdown",
      text: "The **stored** reply.",
    });
    const toolRow = {
      ...sampleRunRow({
        id: "event-03",
        type: "tool.result",
        payload: { toolName: "read_file", [CONTENT_LENGTH_PAYLOAD_KEY]: 12 },
      }),
      content: { status: "available", body: "stored lines", contentTruncated: true },
    } as const;
    // The heading reads its result from the stored body, as the card's does.
    expect((await readRowText(toolRow.id, sourcesHolding(toolRow, "expanded")))?.text).toMatch(
      /\nread_file Truncated\nstored lines$/,
    );
    const emptyReply = {
      ...sampleRunRow({ id: "event-04", type: "assistant.message" }),
      content: { status: "unavailable", reason: "absent" },
    } as const;
    expect((await readRowText(emptyReply.id, sourcesHolding(emptyReply)))?.text).toBe(
      UNAVAILABLE_BODY_TITLE,
    );
  });

  it("copies a long colored output stripped of its escapes, in pieces", async () => {
    const toolRow = sampleRunRow({
      id: "event-05",
      type: "tool.invoked",
      payload: { toolName: "run_tests" },
    });
    // Sequences of several kinds, so some straddle the cuts between the output's pieces.
    const lines = Array.from({ length: 12_000 }, (_, index) => `test ${String(index)} passed`);
    const coloredOutput = lines
      .map((line, index) =>
        index % 3 === 0
          ? `\u001b[1;32m${line}\u001b[0m`
          : index % 3 === 1
            ? `\u001b]8;;file:///suite\u0007${line}\u001b]8;;\u001b\\`
            : `\u001b(B${line}\u001b[K`,
      )
      .join("\n");
    const part = await readRowText(toolRow.id, sourcesHolding(toolRow, "expanded", coloredOutput));
    const pieces = part?.pieces ?? [];
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((piece) => piece.length <= TEXT_PIECE_LENGTH)).toBe(true);
    expect(pieces.join("")).toBe(part?.text);
    const text = part?.text ?? "";
    const output = lines.join("\n");
    expect(text.slice(-output.length - 1)).toBe(`\n${output}`);
    expect(text.slice(0, -output.length - 1)).toMatch(/\nrun_tests[^\n]*$/u);
  });
});
