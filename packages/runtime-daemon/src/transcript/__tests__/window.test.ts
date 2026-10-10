// `transcript.read` windows over a scratch log: the cursors a page is read from and the one it
// names next, the default row limit, the byte cut kept at the cursor's end with one row as its
// floor, every row's body with it but a large one, and a session whose history is damaged before
// its first event read as an empty log.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encodeEventCursor,
  EventCursorUnresolvableError,
  START_OF_LOG_POSITION,
} from "@ai-sidekicks/contracts/session/event-cursor";
import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts/event/declared-variants";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  TRANSCRIPT_READ_LIMIT_MAX,
  TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES,
} from "@ai-sidekicks/contracts/transcript/limits";
import {
  TranscriptReadResponseSchema,
  type TranscriptReadRequest,
  type TranscriptReadResponse,
} from "@ai-sidekicks/contracts/transcript/operations";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import type { DamagedFromSequenceReader } from "../../events/session/read.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { insertStoredEvent } from "../../session/__fixtures__/stored-event.js";
import { TranscriptProjector } from "../projector.js";
import { TranscriptWindowReader } from "../window.js";

const SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9a01" as SessionId;
const UNKNOWN_SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9aff" as SessionId;

// A name long enough that two rows fit the page byte budget and three do not.
const LARGE_NAME_LENGTH = 400_000;

let scratch: ScratchDatabase;

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  await scratch.close();
});

// Appends one rename per name, at sequences 0, 1, 2 and on.
async function seedRenames(names: readonly string[]): Promise<void> {
  // Queued together, so the writer commits them in its batches rather than one commit a row.
  await Promise.all(
    names.map((name, sequence) =>
      insertStoredEvent(scratch.writer, {
        id: `event-${String(sequence)}`,
        sessionId: SESSION_ID,
        sequence,
        occurredAt: "2026-10-09T12:00:00.000Z",
        monotonicNs: BigInt(sequence),
        category: "session_lifecycle",
        type: "session.renamed",
        actor: null,
        payload: { sessionId: SESSION_ID, name, origin: "user" },
        correlationId: null,
        causationId: null,
        version: "1.0",
      }),
    ),
  );
}

function windowReader(
  readDamagedFromSequence: DamagedFromSequenceReader = () => undefined,
): TranscriptWindowReader {
  return new TranscriptWindowReader(
    scratch.reader,
    new TranscriptProjector(scratch.reader, readDamagedFromSequence),
    readDamagedFromSequence,
  );
}

// One page read as its row sequences, whether more remain and the cursor it names next.
function pageOf(
  reader: TranscriptWindowReader,
  window: Omit<TranscriptReadRequest, "sessionId">,
): { sequences: number[]; hasMore: boolean; nextCursor: string | undefined } {
  const page: TranscriptReadResponse = reader.read({ sessionId: SESSION_ID, ...window });
  return {
    sequences: page.entries.map((row) => row.sequence),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

describe("TranscriptWindowReader — one transcript.read window", () => {
  it("walks the log back from a cursor and forward after one, each page naming where the next reads", async () => {
    await seedRenames(Array.from({ length: 7 }, (_, sequence) => `name ${String(sequence)}`));
    const reader = windowReader();

    // Backward: the rows at or below the cursor nearest it, the next page before the oldest.
    expect(pageOf(reader, { beforeCursor: encodeEventCursor(6), limit: 3 })).toStrictEqual({
      sequences: [4, 5, 6],
      hasMore: true,
      nextCursor: encodeEventCursor(3),
    });
    expect(pageOf(reader, { beforeCursor: encodeEventCursor(3), limit: 3 })).toStrictEqual({
      sequences: [1, 2, 3],
      hasMore: true,
      nextCursor: encodeEventCursor(0),
    });
    // The page that reaches the start of the log names no earlier one.
    expect(pageOf(reader, { beforeCursor: encodeEventCursor(0), limit: 3 })).toStrictEqual({
      sequences: [0],
      hasMore: false,
      nextCursor: undefined,
    });
    // Forward: the rows after the cursor, the next page after the newest.
    expect(pageOf(reader, { afterCursor: encodeEventCursor(1), limit: 2 })).toStrictEqual({
      sequences: [2, 3],
      hasMore: true,
      nextCursor: encodeEventCursor(3),
    });
    // Both: the rows between them, read forward, the bound included.
    expect(
      pageOf(reader, {
        afterCursor: encodeEventCursor(1),
        beforeCursor: encodeEventCursor(4),
        limit: 10,
      }),
    ).toStrictEqual({ sequences: [2, 3, 4], hasMore: false, nextCursor: encodeEventCursor(4) });
    // A position past the newest event names nothing this log holds.
    expect(() =>
      reader.read({ sessionId: SESSION_ID, beforeCursor: encodeEventCursor(7) }),
    ).toThrow(EventCursorUnresolvableError);
  });

  it("reads at most the row limit when a request names none", async () => {
    await seedRenames(
      Array.from({ length: TRANSCRIPT_READ_LIMIT_MAX + 1 }, (_, sequence) => String(sequence)),
    );

    const page = pageOf(windowReader(), {});

    expect(page.sequences).toHaveLength(TRANSCRIPT_READ_LIMIT_MAX);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(encodeEventCursor(TRANSCRIPT_READ_LIMIT_MAX - 1));
  });

  it("cuts a page at the byte budget at the end farthest from its cursor, never below one row", async () => {
    await seedRenames([
      "a".repeat(LARGE_NAME_LENGTH),
      "b".repeat(LARGE_NAME_LENGTH),
      "c".repeat(LARGE_NAME_LENGTH),
      "d".repeat(LARGE_NAME_LENGTH * 3),
    ]);
    const reader = windowReader();

    // Backward keeps the rows nearest the cursor, the newest.
    expect(pageOf(reader, { beforeCursor: encodeEventCursor(2), limit: 3 })).toStrictEqual({
      sequences: [1, 2],
      hasMore: true,
      nextCursor: encodeEventCursor(0),
    });
    // Forward keeps the rows nearest the cursor, the oldest.
    expect(
      pageOf(reader, { afterCursor: encodeEventCursor(START_OF_LOG_POSITION), limit: 3 }),
    ).toStrictEqual({ sequences: [0, 1], hasMore: true, nextCursor: encodeEventCursor(1) });
    // A row over the budget alone is still a page, so the cursor moves past it.
    expect(pageOf(reader, { afterCursor: encodeEventCursor(2), limit: 3 }).sequences).toStrictEqual(
      [3],
    );
  });

  it("reads a session damaged before its first event as an empty log, and refuses one it lacks", async () => {
    await seedRenames(["first"]);
    const damagedFromFirst = windowReader(() => 0);

    expect(
      pageOf(damagedFromFirst, { beforeCursor: encodeEventCursor(START_OF_LOG_POSITION) }),
    ).toStrictEqual({ sequences: [], hasMore: false, nextCursor: undefined });
    expect(() => windowReader().read({ sessionId: UNKNOWN_SESSION_ID })).toThrow(
      SessionNotFoundError,
    );
  });

  it("carries each row's body, and keeps a page of outputs over the frame whole as their sizes", async () => {
    // Twenty outputs of 200,000 bytes each are four times a frame: carried whole, a page would hold
    // four of them. Each comes back as its size instead, beside a reply that travels with its row
    // and a row with no body. The first is over the most a body read may hold, and still costs its
    // page nothing.
    const largeLength = 200_000;
    const overReadLength = 300_000;
    const bodies: (string | null)[] = [
      "x".repeat(overReadLength),
      ...Array.from({ length: 19 }, () => "x".repeat(largeLength)),
      "y".repeat(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES - 2),
      null,
    ];
    for (const [sequence, body] of bodies.entries()) {
      await insertStoredEvent(
        scratch.writer,
        {
          id: `event-${String(sequence)}`,
          sessionId: SESSION_ID,
          sequence,
          occurredAt: "2026-10-09T12:00:00.000Z",
          monotonicNs: BigInt(sequence),
          category: "assistant_output",
          type: "assistant.message",
          actor: null,
          payload: body === null ? {} : { contentType: "text/plain", contentLength: body.length },
          correlationId: null,
          causationId: null,
          version: "1.0",
        },
        body,
      );
    }

    const page = windowReader().read({ sessionId: SESSION_ID });

    // Parsed as the reply's own schema, so a body the contract refuses would fail the page here.
    expect(TranscriptReadResponseSchema.parse(page).entries).toHaveLength(bodies.length);
    expect(page.hasMore).toBe(false);
    expect(overReadLength).toBeGreaterThan(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    expect(page.entries[0]?.content).toStrictEqual({
      status: "large",
      contentLength: overReadLength,
    });
    expect(page.entries[1]?.content).toStrictEqual({ status: "large", contentLength: largeLength });
    expect(page.entries[20]?.content).toStrictEqual({
      status: "available",
      body: bodies[20],
      contentLength: TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES - 2,
    });
    expect(page.entries[21]?.content).toStrictEqual({ status: "unavailable", reason: "absent" });
  });
});
