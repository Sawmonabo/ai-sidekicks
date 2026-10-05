// The backward window's decode, asserted against the contract's own types rather than a
// hand-written record, so a row the daemon may send and this boundary drops fails here.

import { describe, expect, it } from "vitest";

import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session";
import type { TranscriptReadResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { TranscriptReadResponseSchema } from "@ai-sidekicks/contracts/transcript/operations";

import { readEarlierTranscriptPage } from "./transcript-page.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5" as SessionId;

function rowAt(sequence: number, overrides: Partial<TranscriptEventRow> = {}): TranscriptEventRow {
  return {
    kind: "general",
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    cursor: `cursor-at-${String(sequence)}` as EventCursor,
    category: "session_lifecycle",
    type: "session.created",
    summary: `row ${String(sequence)}`,
    timestamp: "2026-01-01T11:00:00.000Z",
    payload: { note: sequence },
    ...overrides,
  } as TranscriptEventRow;
}

describe("readEarlierTranscriptPage — one window, read as the store's own log", () => {
  it("carries every member the log holds, renaming exactly two", () => {
    const response = TranscriptReadResponseSchema.parse({
      entries: [rowAt(7, { actor: "user-a" })],
      hasMore: false,
    } satisfies TranscriptReadResponse);

    const page = readEarlierTranscriptPage(response);

    expect(page.events).toStrictEqual([
      {
        id: "event-7",
        sessionId: SESSION_ID,
        sequence: 7,
        cursor: "cursor-at-7",
        kind: "session.created",
        occurredAt: "2026-01-01T11:00:00.000Z",
        actorId: "user-a",
        payload: { note: 7 },
      },
    ]);
  });

  it("takes the producer's own `hasMore` as the verdict, never the cursor's presence", () => {
    const continuing = TranscriptReadResponseSchema.parse({
      entries: [rowAt(7)],
      hasMore: true,
      nextCursor: "cursor-6" as EventCursor,
    } satisfies TranscriptReadResponse);

    const continuingPage = readEarlierTranscriptPage(continuing);

    expect(continuingPage.hasEarlierRows).toBe(true);
    expect(continuingPage.nextBeforeCursor).toBe("cursor-6");

    // `nextCursor` is permitted on the terminal arm, so a boundary reading its presence would
    // report earlier rows behind every final page.
    const terminal = TranscriptReadResponseSchema.parse({
      entries: [rowAt(7)],
      hasMore: false,
      nextCursor: "cursor-6" as EventCursor,
    } satisfies TranscriptReadResponse);

    const terminalPage = readEarlierTranscriptPage(terminal);

    expect(terminalPage.hasEarlierRows).toBe(false);
    expect(terminalPage.nextBeforeCursor).toBe("cursor-6");
  });
});
