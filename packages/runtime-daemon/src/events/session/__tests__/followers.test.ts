// Following a session's log: a follower that catches up while appends land gets every event once
// and in order, hands its receiver a change only while it has room, and a resume from a delivered
// cursor gets exactly the rest; a session or cursor the log cannot serve is refused before any
// change; a page that cannot be read or a follower that throws ends that follower alone; and
// receipts that arrive out of order still publish in sequence order.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventCursorUnresolvableError } from "@ai-sidekicks/contracts/error";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import {
  EventCursorSchema,
  SessionIdSchema,
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { SessionNotFoundError } from "../../../ipc/session-errors.js";
import { drainMicrotasks } from "../../../provider/__fixtures__/drain-microtasks.js";
import {
  EventLogService,
  type EventLogServiceDeps,
  type UnsequencedEventEnvelope,
} from "../../log-service.js";
import { breakStoredEvent, holdReceiptOfAppend } from "../__fixtures__/log-faults.js";
import type { SessionEventListener } from "../followers.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

let scratch: ScratchDatabase;
let serviceLogLines: string[];

beforeEach(async () => {
  scratch = await openScratchDatabase();
  serviceLogLines = [];
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
    writeServiceLog: (line) => {
      serviceLogLines.push(line);
    },
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

interface RecordedFollow {
  readonly sequences: number[];
  readonly failures: unknown[];
  readonly listener: SessionEventListener;
  /** Makes the receiver full, so the catch-up waits for a drain. */
  fill(): void;
  /** Gives the receiver room and calls the drain listeners. */
  drain(): void;
}

// Records each delivered sequence, checking the change's cursor resumes right after it, and each
// failure; the receiver has room until filled.
function recordChanges(): RecordedFollow {
  const sequences: number[] = [];
  const failures: unknown[] = [];
  let isFull = false;
  const drainListeners = new Set<() => void>();
  return {
    sequences,
    failures,
    listener: {
      onChange: (change) => {
        expect(change.cursor).toBe(encodeEventCursor(change.event.sequence));
        sequences.push(change.event.sequence);
      },
      onCaughtUp: () => undefined,
      onFailure: (error) => {
        failures.push(error);
      },
      isFull: () => isFull,
      onceDrained: (listener) => {
        drainListeners.add(listener);
        return () => {
          drainListeners.delete(listener);
        };
      },
    },
    fill: () => {
      isFull = true;
    },
    drain: () => {
      isFull = false;
      const listeners = [...drainListeners];
      drainListeners.clear();
      for (const listener of listeners) listener();
    },
  };
}

describe("EventLogService.follow — catch-up to follow", () => {
  it("delivers the log exactly once, in order, while appends land across catch-up pages", async () => {
    // Only the yield between pages is held, so each append commits mid-catch-up: its receipt passes
    // the follower by, and the next page reads it from the log.
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const service = buildService();
    await appendEvents(service, 5);
    const follower = recordChanges();

    service.follow(SESSION, undefined, follower.listener);
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
    let lastCursor = encodeEventCursor(START_OF_LOG_POSITION);
    const detachFirst = service.follow(SESSION, undefined, {
      ...first.listener,
      onChange: (change) => {
        first.listener.onChange(change);
        lastCursor = change.cursor;
        if (change.event.sequence === 2) {
          detachFirst();
        }
      },
    });
    await vi.waitFor(() => {
      expect(first.sequences).toHaveLength(3);
    });
    await appendEvents(service, 2);
    await drainMicrotasks();
    expect(first.sequences).toEqual([0, 1, 2]);

    const resumed = recordChanges();
    service.follow(SESSION, lastCursor, resumed.listener);
    await vi.waitFor(() => {
      expect(resumed.sequences).toHaveLength(5);
    });
    expect(resumed.sequences).toEqual([3, 4, 5, 6, 7]);
  });

  it("refuses an unknown session and a cursor it cannot read before any change", async () => {
    const service = buildService();
    const follower = recordChanges();
    expect(() => service.follow(SESSION, undefined, follower.listener)).toThrow(
      SessionNotFoundError,
    );

    await appendEvents(service, 3);
    for (const cursor of ["007", "-2", "abc", "3"]) {
      expect(() =>
        service.follow(SESSION, EventCursorSchema.parse(cursor), follower.listener),
      ).toThrow(EventCursorUnresolvableError);
    }
    expect(follower.sequences).toEqual([]);
  });

  it("hands a full receiver nothing, and the rest once it drains", async () => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const service = buildService();
    await appendEvents(service, 6);
    const follower = recordChanges();

    follower.fill();
    service.follow(SESSION, undefined, follower.listener);
    vi.runAllTimers();
    expect(follower.sequences).toEqual([]);

    follower.drain();
    expect(follower.sequences).toEqual([0, 1]);
    vi.runAllTimers();
    expect(follower.sequences).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("EventLogService.follow — one follower's failure is its own", () => {
  it("ends only the follower whose later catch-up page cannot be read", async () => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const service = buildService();
    await appendEvents(service, 4);
    await breakStoredEvent(scratch.writer, SESSION, 3);
    const live = recordChanges();
    service.follow(SESSION, encodeEventCursor(3), live.listener);
    const catchingUp = recordChanges();

    service.follow(SESSION, undefined, catchingUp.listener);
    vi.runAllTimers();
    await appendEvents(service, 1);
    await drainMicrotasks();

    expect(catchingUp.sequences).toEqual([0, 1]);
    expect(catchingUp.failures).toHaveLength(1);
    expect(String(catchingUp.failures[0])).toContain("is not JSON");
    expect(live.failures).toEqual([]);
    expect(live.sequences).toEqual([4]);
  });

  it("delivers each event to every other follower when one of them throws", async () => {
    const service = buildService();
    await appendEvents(service, 1);
    const thrown = new Error("the receiver broke");
    const throwing = recordChanges();
    service.follow(SESSION, encodeEventCursor(0), {
      ...throwing.listener,
      onChange: () => {
        throw thrown;
      },
    });
    const next = recordChanges();
    service.follow(SESSION, encodeEventCursor(0), next.listener);
    service.followAll(() => {
      throw thrown;
    });
    const allSessions: number[] = [];
    service.followAll((event) => {
      allSessions.push(event.sequence);
    });

    await appendEvents(service, 2);
    await drainMicrotasks();

    expect(throwing.failures).toEqual([thrown]);
    expect(next.sequences).toEqual([1, 2]);
    expect(allSessions).toEqual([1, 2]);
    // The follower of every session stays attached, so it fails on each event.
    expect(serviceLogLines).toEqual([
      expect.stringContaining("on sequence 1 of session"),
      expect.stringContaining("on sequence 2 of session"),
    ]);
    expect(serviceLogLines[0]).toContain("the receiver broke");
  });
});

describe("EventLogService.follow — publication order", () => {
  it("publishes in sequence order when a later receipt arrives before an earlier one", async () => {
    // The second append's receipt is held, so the third's arrives first.
    const holding = holdReceiptOfAppend(scratch.writer, 2);
    const service = buildService({ writer: holding.writer });
    await appendEvents(service, 1);
    const follower = recordChanges();
    const allSessions: number[] = [];
    service.follow(SESSION, undefined, follower.listener);
    service.followAll((event) => {
      allSessions.push(event.sequence);
    });

    const heldAppend = service.append(makeEnvelope());
    await service.append(makeEnvelope());
    await drainMicrotasks();
    expect(follower.sequences).toEqual([0, 1, 2]);
    expect(allSessions).toEqual([1, 2]);

    holding.release();
    await expect(heldAppend).resolves.toMatchObject({ sequence: 1 });
    await drainMicrotasks();
    expect(follower.sequences).toEqual([0, 1, 2]);
    expect(allSessions).toEqual([1, 2]);
  });

  it("ends a live follower at a gap it cannot read, and tells the others of the gap", async () => {
    // The second append's receipt is held, so the third's arrives first.
    const holding = holdReceiptOfAppend(scratch.writer, 2);
    const service = buildService({ writer: holding.writer });
    await appendEvents(service, 1);
    const live = recordChanges();
    service.follow(SESSION, encodeEventCursor(0), live.listener);
    const allSessions: (number | string)[] = [];
    service.followAll(
      (event) => {
        allSessions.push(event.sequence);
      },
      (sessionId) => {
        allSessions.push(`gap in ${sessionId}`);
      },
    );

    const heldAppend = service.append(makeEnvelope());
    await vi.waitFor(() => {
      expect(storedSequences()).toEqual([0, 1]);
    });
    await breakStoredEvent(scratch.writer, SESSION, 1);
    await service.append(makeEnvelope());
    await drainMicrotasks();
    holding.release();
    await heldAppend;
    await drainMicrotasks();

    expect(live.sequences).toEqual([]);
    expect(live.failures).toHaveLength(1);
    expect(allSessions).toEqual([`gap in ${SESSION}`, 2]);
    expect(serviceLogLines).toEqual([
      expect.stringContaining(`reading session ${SESSION}'s events before sequence 2 failed`),
    ]);
  });

  it("keeps a session no one follows in order for the followers of every session", async () => {
    // Nothing follows the session itself, so only the appends in flight keep its order.
    // The second append's receipt is held, so the third's arrives first.
    const holding = holdReceiptOfAppend(scratch.writer, 2);
    const service = buildService({ writer: holding.writer });
    const allSessions: number[] = [];
    service.followAll((event) => {
      allSessions.push(event.sequence);
    });

    await appendEvents(service, 1);
    const heldAppend = service.append(makeEnvelope());
    await service.append(makeEnvelope());
    await drainMicrotasks();
    holding.release();
    await heldAppend;
    await appendEvents(service, 1);
    await drainMicrotasks();

    expect(allSessions).toEqual([0, 1, 2, 3]);
  });
});
