// The backward window's decode, over the registered response shape.
//
// Asserted against the CONTRACT's own types rather than against a hand-written record,
// so a row the daemon may send and this boundary drops fails here rather than at the
// first surface that looks for it.

import { describe, expect, it } from "vitest";

import type {
  EventCursor,
  SessionId,
  TimelineReadResponse,
  TimelineRow,
} from "@ai-sidekicks/contracts";
import { TimelineReadResponseSchema } from "@ai-sidekicks/contracts";

import { readEarlierTimelinePage } from "./timeline-page.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5" as SessionId;

function rowAt(sequence: number, overrides: Partial<TimelineRow> = {}): TimelineRow {
  return {
    kind: "general",
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    category: "membership_change",
    type: "participant.joined",
    summary: `row ${String(sequence)}`,
    timestamp: "2026-01-01T11:00:00.000Z",
    payload: { note: sequence },
    ...overrides,
  } as TimelineRow;
}

describe("readEarlierTimelinePage — one window, read as the store's own log", () => {
  it("carries every member the log holds, renaming exactly two", () => {
    const response = TimelineReadResponseSchema.parse({
      entries: [rowAt(7, { actor: "participant-a" })],
      hasMore: false,
    } satisfies TimelineReadResponse);

    const page = readEarlierTimelinePage(response);

    expect(page.events).toStrictEqual([
      {
        id: "event-7",
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "participant.joined",
        occurredAt: "2026-01-01T11:00:00.000Z",
        actorId: "participant-a",
        payload: { note: 7 },
      },
    ]);
  });

  it("leaves an absent actor absent rather than spelling it as a present undefined", () => {
    const response = TimelineReadResponseSchema.parse({
      entries: [rowAt(7)],
      hasMore: false,
    } satisfies TimelineReadResponse);

    expect(Object.hasOwn(readEarlierTimelinePage(response).events[0] ?? {}, "actorId")).toBe(false);
  });

  it("copies the payload rather than aliasing the parsed row's", () => {
    const response = TimelineReadResponseSchema.parse({
      entries: [rowAt(7)],
      hasMore: false,
    } satisfies TimelineReadResponse);

    const page = readEarlierTimelinePage(response);

    expect(page.events[0]?.payload).not.toBe(response.entries[0]?.payload);
    expect(page.events[0]?.payload).toStrictEqual({ note: 7 });
  });

  it("takes the producer's own `hasMore` as the verdict on what remains", () => {
    const continuing = TimelineReadResponseSchema.parse({
      entries: [rowAt(7)],
      hasMore: true,
      nextCursor: "cursor-6" as EventCursor,
    } satisfies TimelineReadResponse);

    const page = readEarlierTimelinePage(continuing);

    expect(page.hasEarlierRows).toBe(true);
    expect(page.nextBeforeCursor).toBe("cursor-6");
  });

  it("does not read a terminal page's cursor as more rows", () => {
    // The negative control for the discriminant. `nextCursor` is PERMITTED on the
    // terminal arm — it is where the window ended, which a resuming subscriber needs —
    // so a boundary reading its presence would report earlier rows behind every final
    // page and the control would never retire.
    const terminal = TimelineReadResponseSchema.parse({
      entries: [rowAt(7)],
      hasMore: false,
      nextCursor: "cursor-6" as EventCursor,
    } satisfies TimelineReadResponse);

    const page = readEarlierTimelinePage(terminal);

    expect(page.hasEarlierRows).toBe(false);
    expect(page.nextBeforeCursor).toBe("cursor-6");
  });

  it("reads an empty terminal window as a window with nothing before it", () => {
    const page = readEarlierTimelinePage(
      TimelineReadResponseSchema.parse({
        entries: [],
        hasMore: false,
      } satisfies TimelineReadResponse),
    );

    expect(page.events).toStrictEqual([]);
    expect(page.hasEarlierRows).toBe(false);
    expect(page.nextBeforeCursor).toBeUndefined();
  });
});
