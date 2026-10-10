// A read window's decode, asserted against the contract's own types rather than a
// hand-written record, so a row the daemon may send and this boundary drops fails here.

import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { TranscriptReadResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
import type { TranscriptReadRow } from "@ai-sidekicks/contracts/transcript/row";
import { TranscriptReadResponseSchema } from "@ai-sidekicks/contracts/transcript/operations";

import { readTranscriptPage } from "./page.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5" as SessionId;

function rowAt(
  sequence: number,
  overrides: { readonly actor?: string; readonly content?: TranscriptRowContent } = {},
): TranscriptReadRow {
  return {
    kind: "general",
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    cursor: `cursor-at-${String(sequence)}` as EventCursor,
    category: "session_lifecycle",
    type: "session.created",
    timestamp: "2026-01-01T11:00:00.000Z",
    payload: { note: sequence },
    content: { status: "unavailable", reason: "absent" },
    ...overrides,
  };
}

describe("readTranscriptPage — one window, read as the store's own log", () => {
  it("carries every member the log holds, renaming exactly two", () => {
    const response = TranscriptReadResponseSchema.parse({
      entries: [
        rowAt(7, {
          actor: "user-a",
          content: { status: "available", body: "Done.", contentLength: 5 },
        }),
      ],
      runs: [],
      hasMore: false,
    } satisfies TranscriptReadResponse);

    const page = readTranscriptPage(response);

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
        content: { status: "available", body: "Done.", contentLength: 5 },
      },
    ]);
  });

  it("takes the producer's own `hasMore` as the verdict, never the cursor's presence", () => {
    const continuing = TranscriptReadResponseSchema.parse({
      entries: [rowAt(7)],
      runs: [],
      hasMore: true,
      nextCursor: "cursor-6" as EventCursor,
    } satisfies TranscriptReadResponse);

    const continuingPage = readTranscriptPage(continuing);

    expect(continuingPage.edge).toStrictEqual({ cursor: "cursor-6", hasMore: true });

    // `nextCursor` is permitted on the terminal arm, so a boundary reading its presence would
    // report more rows beyond every final page.
    const terminal = TranscriptReadResponseSchema.parse({
      entries: [rowAt(7)],
      runs: [],
      hasMore: false,
      nextCursor: "cursor-6" as EventCursor,
    } satisfies TranscriptReadResponse);

    const terminalPage = readTranscriptPage(terminal);

    expect(terminalPage.edge).toStrictEqual({ cursor: "cursor-6", hasMore: false });
  });
});
