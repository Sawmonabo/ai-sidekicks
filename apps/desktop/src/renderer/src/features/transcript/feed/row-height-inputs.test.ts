// The height kind a call's row is estimated as, over a window derived from a real log: what the
// tool card draws for it, folded, open with its output cut, or open with its output whole.

import { describe, expect, it } from "vitest";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { deriveTranscriptWindow } from "../window/transcript-window.js";
import { rowHeightKindOf, type RowDrawing } from "./row-height-inputs.js";

/** A call whose result carries a body, so its row folds and its output can be cut. */
const CALL: ProjectedSessionEvent = {
  id: "call-1",
  sessionId: "session-1",
  sequence: 1,
  cursor: "cursor-at-1",
  kind: "tool.result",
  occurredAt: "2026-10-10T19:00:00.000Z",
  payload: { toolName: "read", toolCallId: "tool-call-1", [CONTENT_LENGTH_PAYLOAD_KEY]: 4_096 },
};

const NONE: ReadonlySet<string> = new Set();

function drawing(overrides: Partial<RowDrawing>): RowDrawing {
  return {
    foldedCallRowIds: NONE,
    openedOutputRowIds: NONE,
    isRevealing: () => false,
    ...overrides,
  };
}

describe("a call's height kind", () => {
  it("is an opened output's only while the call is open and its output was opened whole", () => {
    // An opened output draws whole, past the cut an open call's estimate stops at.
    const transcriptWindow = deriveTranscriptWindow([CALL]);
    const opened = new Set([CALL.id]);
    const kindWith = (overrides: Partial<RowDrawing>) =>
      rowHeightKindOf(transcriptWindow, drawing(overrides), CALL.id);

    expect(kindWith({})).toBe("tool-call-expanded");
    expect(kindWith({ openedOutputRowIds: opened })).toBe("tool-call-output-opened");
    // Folded, it draws its header alone, opened or not.
    expect(kindWith({ openedOutputRowIds: opened, foldedCallRowIds: opened })).toBe(
      "tool-call-collapsed",
    );
  });
});
