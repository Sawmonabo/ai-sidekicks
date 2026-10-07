// Following a session's log: a follower that catches up while appends land gets every event once
// and in order, a resume from a delivered cursor gets exactly the rest, a session or cursor the log
// cannot serve is refused before any change, and receipts that arrive out of order still publish
// in sequence order.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventCursorUnresolvableError } from "@ai-sidekicks/contracts/error";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import {
  EventCursorSchema,
  SessionIdSchema,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import type { DatabaseWriter } from "../../../database/writer.js";
import { SessionNotFoundError } from "../../../ipc/session-errors.js";
import { drainMicrotasks } from "../../../provider/__fixtures__/drain-microtasks.js";
import {
  EventLogService,
  type EventLogServiceDeps,
  type UnsequencedEventEnvelope,
} from "../../log-service.js";
import type { SessionEventChange } from "../followers.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

let scratch: ScratchDatabase;

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  vi.useRealTimers();
  await scratch.close();
});

let envelopeCounter = 0;

function makeEnvelope(): UnsequencedEventEnvelope {
  envelopeCounter += 1;
  return {
    id: `follow-${String(envelopeCounter).padStart(4, "0")}`,
    sessionId: SESSION,
    occurredAt: "2026-08-04T12:00:00.000Z",
    category: "session_lifecycle",
    type: "session.updated",
    actor: null,
    payload: { note: `append ${String(envelopeCounter)}` },
    version: ENVELOPE_VERSION,
  };
}

function buildService(overrides?: Partial<EventLogServiceDeps>): EventLogService {
  return new EventLogService({
    writer: scratch.writer,
    reader: scratch.reader,
    catchUpPageSize: 2,
    ...overrides,
  });
}

async function appendEvents(service: EventLogService, count: number): Promise<void> {
  for (let appended = 0; appended < count; appended += 1) {
    await service.append(makeEnvelope());
  }
}

function storedSequences(): number[] {
  return (
    scratch.reader
      .prepare("SELECT sequence FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
      .all(SESSION) as { sequence: number }[]
  ).map((row) => row.sequence);
}

// Records each delivered sequence and checks the change's cursor resumes right after it.
function recordChanges(): { sequences: number[]; onChange: (change: SessionEventChange) => void } {
  const sequences: number[] = [];
  return {
    sequences,
    onChange: (change) => {
      expect(change.cursor).toBe(encodeEventCursor(change.event.sequence));
      sequences.push(change.event.sequence);
    },
  };
}

describe("EventLogService.follow — catch-up to follow", () => {
  it("delivers the log exactly once, in order, while appends land across catch-up pages", async () => {
    // Only the yield between pages is held, so each append commits mid-catch-up and reaches the
    // follower both from the log and as a published receipt.
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const service = buildService();
    await appendEvents(service, 5);
    const follower = recordChanges();

    service.follow(SESSION, undefined, follower.onChange);
    expect(follower.sequences).toEqual([0, 1]);

    await appendEvents(service, 1);
    vi.runOnlyPendingTimers();
    expect(follower.sequences).toEqual([0, 1, 2, 3]);

    await appendEvents(service, 1);
    vi.runOnlyPendingTimers();
    vi.runOnlyPendingTimers();
    expect(follower.sequences).toEqual([0, 1, 2, 3, 4, 5, 6]);

    await appendEvents(service, 1);
    await drainMicrotasks();
    expect(follower.sequences).toEqual(storedSequences());
    expect(follower.sequences).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("stops at a detach from inside a change, and a resume from its cursor gets exactly the rest", async () => {
    const service = buildService();
    await appendEvents(service, 6);
    const first = recordChanges();
    let lastCursor = encodeEventCursor(-1);
    const detachFirst = service.follow(SESSION, undefined, (change) => {
      first.onChange(change);
      lastCursor = change.cursor;
      if (change.event.sequence === 2) {
        detachFirst();
      }
    });
    await vi.waitFor(() => {
      expect(first.sequences).toHaveLength(3);
    });
    await appendEvents(service, 2);
    await drainMicrotasks();
    expect(first.sequences).toEqual([0, 1, 2]);

    const resumed = recordChanges();
    service.follow(SESSION, lastCursor, resumed.onChange);
    await vi.waitFor(() => {
      expect(resumed.sequences).toHaveLength(5);
    });
    expect(resumed.sequences).toEqual([3, 4, 5, 6, 7]);
  });

  it("refuses an unknown session and a cursor it cannot read before any change", async () => {
    const service = buildService();
    const onChange = vi.fn();
    expect(() => service.follow(SESSION, undefined, onChange)).toThrow(SessionNotFoundError);

    await appendEvents(service, 3);
    for (const cursor of ["007", "-2", "abc", "3"]) {
      expect(() => service.follow(SESSION, EventCursorSchema.parse(cursor), onChange)).toThrow(
        EventCursorUnresolvableError,
      );
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("EventLogService.follow — publication order", () => {
  it("publishes in sequence order when a later receipt arrives before an earlier one", async () => {
    // The second append's receipt is held after its commit, so the third's arrives first.
    let releaseHeldReceipt: () => void = () => {};
    let appendCount = 0;
    const holdingWriter: Pick<DatabaseWriter, "appendEvents" | "appendThinkingUpdate"> = {
      appendEvents: async (events, statements) => {
        appendCount += 1;
        const isHeld = appendCount === 2;
        const sequences = await scratch.writer.appendEvents(events, statements);
        if (isHeld) {
          await new Promise<void>((resolve) => {
            releaseHeldReceipt = resolve;
          });
        }
        return sequences;
      },
      appendThinkingUpdate: (event) => scratch.writer.appendThinkingUpdate(event),
    };
    const service = buildService({ writer: holdingWriter });
    await appendEvents(service, 1);
    const follower = recordChanges();
    const allSessions: number[] = [];
    service.follow(SESSION, undefined, follower.onChange);
    service.followAll((event) => {
      allSessions.push(event.sequence);
    });

    const heldAppend = service.append(makeEnvelope());
    await service.append(makeEnvelope());
    await drainMicrotasks();
    expect(follower.sequences).toEqual([0, 1, 2]);
    expect(allSessions).toEqual([1, 2]);

    releaseHeldReceipt();
    await expect(heldAppend).resolves.toMatchObject({ sequence: 1 });
    await drainMicrotasks();
    expect(follower.sequences).toEqual([0, 1, 2]);
    expect(allSessions).toEqual([1, 2]);
  });
});
