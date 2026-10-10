import { describe, expect, it } from "vitest";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import { sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
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
    publishedTextFor: () => undefined,
    drawnReplyText: {
      drawnTextOf: () => undefined,
    } as unknown as RowRevealContextValue["drawnReplyText"],
  };
  return {
    transcriptWindow: transcriptWindow as TranscriptWindowModel,
    reveal: reveal as RowRevealContextValue,
    densityOf: () => density,
    clockLocale: "en-US",
  };
}

describe("a whole row's copied text", () => {
  it("copies nothing for a reasoning row that draws no text, as the screen shows none", () => {
    const row = sampleRunRow({ id: "event-01", type: "assistant.thinking_update" });
    expect(readRowText(row.id, sourcesHolding(row))).toBeUndefined();
  });

  it("copies the body the log stores for a row, or the sentence the row draws for none", () => {
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
    expect(readRowText(toolRow.id, sourcesHolding(toolRow, "expanded"))?.text).toMatch(
      /\nread_file Truncated\nstored lines$/,
    );
    const emptyReply = {
      ...sampleRunRow({ id: "event-04", type: "assistant.message" }),
      content: { status: "unavailable", reason: "absent" },
    } as const;
    expect(readRowText(emptyReply.id, sourcesHolding(emptyReply))?.text).toBe(
      UNAVAILABLE_BODY_TITLE,
    );
  });
});
