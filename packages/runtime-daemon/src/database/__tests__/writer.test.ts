// The database writer: the writes of one batch commit together or not at all, a write's events
// never split, a write that cannot reach the worker fails alone, a close commits what it took or
// fails what its bound cut off, and at the queue's cap a canonical event waits while an
// assistant's thinking update is dropped, with the depth warning and the drop count on the log.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { SessionEventRow } from "../../events/session/insert.js";
import { openScratchDatabase, type ScratchDatabase } from "../__fixtures__/scratch.js";
import { WRITE_QUEUE_CAPACITY } from "../writer.js";

const SESSION = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const OTHER_SESSION = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const THINKING_UPDATE = "assistant.thinking_update";

let scratch: ScratchDatabase;
const serviceLog: string[] = [];

beforeEach(async () => {
  serviceLog.length = 0;
  scratch = await openScratchDatabase((line) => {
    serviceLog.push(line);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await scratch.close();
});

let eventCount = 0;

function eventRow(sessionId: string, type = "session.updated"): SessionEventRow {
  eventCount += 1;
  return {
    id: `evt-${String(eventCount)}`,
    session_id: sessionId,
    occurred_at: "2026-10-06T12:00:00.000Z",
    monotonic_ns: BigInt(eventCount),
    category: type === "session.updated" ? "session_lifecycle" : "assistant_output",
    type,
    actor: null,
    payload: "{}",
    correlation_id: null,
    causation_id: null,
    version: "1.0",
    content_payload: null,
  };
}

function eventRows(sessionId: string, count: number): SessionEventRow[] {
  return Array.from({ length: count }, () => eventRow(sessionId));
}

function storedEventCount(type?: string): number {
  const row =
    type === undefined
      ? scratch.reader.prepare("SELECT COUNT(*) AS count FROM session_events").get()
      : scratch.reader
          .prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = ?")
          .get(type);
  return (row as { count: number }).count;
}

// Whether `work` has settled once every pending callback of this turn has run.
async function isSettled(work: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const observe = (): void => {
    settled = true;
  };
  void work.then(observe, observe);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return settled;
}

describe("a batch", () => {
  it("commits its writes together or not at all", async () => {
    // Offered in one turn, the three writes share a batch. The snapshot's dangling key is checked
    // at commit, so the commit fails after both appends were written.
    const first = scratch.writer.appendEvents([eventRow(SESSION)]);
    const second = scratch.writer.appendEvents([eventRow(OTHER_SESSION)]);
    const dangling = scratch.writer.write([
      { sql: "PRAGMA defer_foreign_keys = ON" },
      {
        sql: `INSERT INTO session_snapshots (id, session_id, as_of_sequence, state_blob, created_at)
              VALUES ('snapshot-1', 'no-such-session', 0, x'00', '2026-10-06T12:00:00.000Z')`,
      },
    ]);

    await expect(first).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    await expect(second).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    await expect(dangling).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    expect(storedEventCount()).toBe(0);

    const appended = await Promise.all([
      scratch.writer.appendEvents([eventRow(SESSION)]),
      scratch.writer.appendEvents([eventRow(SESSION)]),
      scratch.writer.appendEvents([eventRow(OTHER_SESSION)]),
    ]);
    expect(appended).toStrictEqual([[0], [1], [0]]);
    expect(storedEventCount()).toBe(3);
  });

  it("keeps every statement of a refused write out and the rest of its batch in", async () => {
    const before = scratch.writer.appendEvents([eventRow(SESSION)]);
    const refused = scratch.writer.appendEvents(
      [eventRow(SESSION)],
      [
        {
          sql: "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, 'draft', ?)",
          bindings: [SESSION, "2026-10-06T12:00:00.000Z"],
        },
        {
          sql: "UPDATE session_drafts SET text = 'changed' WHERE session_id = ?",
          bindings: [SESSION],
          expectedRowCount: 2,
        },
      ],
    );
    const after = scratch.writer.appendEvents([eventRow(SESSION)]);

    await expect(refused).rejects.toMatchObject({ statementIndex: 1, rowCount: 1 });
    expect(await before).toStrictEqual([0]);
    expect(await after).toStrictEqual([1]);
    expect(storedEventCount()).toBe(2);
    expect(scratch.reader.prepare("SELECT * FROM session_drafts").all()).toStrictEqual([]);
  });

  it("fails whole when SQLite ends its transaction under one write", async () => {
    // A full database ends the transaction; the writes after it would otherwise commit one by one
    // while their callers were told the batch failed.
    const before = scratch.writer.appendEvents([eventRow(SESSION)]);
    const full = scratch.writer.write([
      { sql: "PRAGMA max_page_count = 1" },
      {
        sql: "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?)",
        bindings: [SESSION, "x".repeat(1_000_000), "2026-10-06T12:00:00.000Z"],
      },
    ]);
    const after = scratch.writer.appendEvents([eventRow(OTHER_SESSION)]);

    await expect(full).rejects.toMatchObject({ code: "SQLITE_FULL" });
    await expect(before).rejects.toMatchObject({ code: "SQLITE_FULL" });
    await expect(after).rejects.toMatchObject({ code: "SQLITE_FULL" });
    expect(storedEventCount()).toBe(0);
  });
});

describe("a write of many events", () => {
  it("commits a tick's events together past the batch limit, or none of them", async () => {
    const tick = eventRows(SESSION, 60);
    expect(await scratch.writer.appendEvents(tick)).toStrictEqual(
      Array.from({ length: 60 }, (_unused, index) => index),
    );

    // The last event repeats the first one's id, so its insert fails after 59 were written.
    const failingTick = eventRows(OTHER_SESSION, 59);
    const firstOfTick = failingTick[0];
    if (firstOfTick === undefined) {
      throw new Error("The tick holds no event");
    }
    failingTick.push({ ...eventRow(OTHER_SESSION), id: firstOfTick.id });
    await expect(scratch.writer.appendEvents(failingTick)).rejects.toMatchObject({
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
    });
    expect(storedEventCount()).toBe(60);
  });

  it("is refused when it holds more events than the queue", async () => {
    await expect(
      scratch.writer.appendEvents(eventRows(SESSION, WRITE_QUEUE_CAPACITY + 1)),
    ).rejects.toThrow(/larger than the write queue/);
    await scratch.writer.flush();
    expect(storedEventCount()).toBe(0);
  });
});

describe("a write the worker cannot be sent", () => {
  it("fails alone, and the writer goes on taking, flushing and closing", async () => {
    // A function cannot cross the thread boundary, so the send throws before the worker sees it.
    const uncloneable = scratch.writer.write([{ sql: "SELECT ?", bindings: [() => 1] }]);
    await expect(uncloneable).rejects.toThrow(/could not be cloned/);

    await expect(scratch.writer.appendEvents([eventRow(SESSION)])).resolves.toStrictEqual([0]);
    await scratch.writer.flush();
    await expect(scratch.writer.close()).resolves.toBe(0);
    expect(storedEventCount()).toBe(1);
  });
});

describe("closing", () => {
  it("commits the writes queued but not yet sent before it answers", async () => {
    // Two small writes wait out the batch delay; the close starts inside it.
    const queued = [
      scratch.writer.appendEvents([eventRow(SESSION)]),
      scratch.writer.appendEvents([eventRow(OTHER_SESSION)]),
    ];
    const closing = scratch.writer.close();

    expect(await Promise.all(queued)).toStrictEqual([[0], [0]]);
    await expect(closing).resolves.toBe(0);
    expect(storedEventCount()).toBe(2);
  });

  it("fails the writes still unfinished at its drain bound and commits none of them", async () => {
    // Another connection holds the write lock, so the batch the flush sends waits at the worker.
    const lockHolder = new Database(scratch.databasePath);
    onTestFinished(() => {
      lockHolder.close();
    });
    lockHolder.exec("BEGIN IMMEDIATE");
    const sent = scratch.writer.appendEvents([eventRow(SESSION)]);
    void scratch.writer.flush();
    const behind = scratch.writer.appendEvents([eventRow(OTHER_SESSION)]);
    const outcomes = Promise.allSettled([sent, behind]);

    const closing = scratch.writer.close(0);
    // The lock goes only after the bound has passed, so the worker is ended before it can commit.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    lockHolder.exec("ROLLBACK");

    await expect(closing).resolves.toBe(2);
    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { message: expect.stringMatching(/drain bound/) as unknown },
      });
    }
    expect(storedEventCount()).toBe(0);
  });

  it("refuses a checkpoint once closed", async () => {
    await scratch.writer.close();
    await expect(scratch.writer.checkpoint("PASSIVE")).rejects.toThrow(/closed/);
  });
});

describe("the queue at its cap", () => {
  it("holds a canonical event for the next batch and drops a thinking update", async () => {
    // Offered in one turn, the first writes fill the queue before any batch can commit.
    const filling = eventRows(SESSION, WRITE_QUEUE_CAPACITY).map((row) =>
      scratch.writer.appendEvents([row]),
    );
    const canonical = scratch.writer.appendEvents([eventRow(OTHER_SESSION)]);
    const thinking = scratch.writer.appendThinkingUpdate(eventRow(OTHER_SESSION, THINKING_UPDATE));

    expect(await thinking).toStrictEqual({ isStored: false });
    expect(await isSettled(canonical)).toBe(false);
    expect(await canonical).toStrictEqual([0]);
    await Promise.all(filling);
    expect(storedEventCount("session.updated")).toBe(WRITE_QUEUE_CAPACITY + 1);
    expect(storedEventCount(THINKING_UPDATE)).toBe(0);
  });
});

describe("the queue's alerts", () => {
  it("warns at 8,000 queued entries, naming the latest event's session and category", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // Offered in one turn and sampled before any batch commits, so the depth is exact.
    const queued = eventRows(SESSION, 7_998).map((row) => scratch.writer.appendEvents([row]));
    queued.push(scratch.writer.appendEvents([eventRow(OTHER_SESSION, "assistant.message")]));
    vi.advanceTimersByTime(1_000);
    expect(serviceLog.filter((line) => line.startsWith("persistence_backpressure"))).toEqual([]);

    queued.push(scratch.writer.appendEvents([eventRow(OTHER_SESSION, "assistant.message")]));
    vi.advanceTimersByTime(1_000);
    expect(serviceLog).toEqual([
      `persistence_backpressure: the write queue holds 8000 of ${String(WRITE_QUEUE_CAPACITY)} ` +
        `entries; session_id=${OTHER_SESSION} event_category=assistant_output.`,
    ]);

    vi.useRealTimers();
    await Promise.all(queued);
  });

  it("counts each session's dropped thinking updates once a second", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const filling = eventRows(SESSION, WRITE_QUEUE_CAPACITY).map((row) =>
      scratch.writer.appendEvents([row]),
    );
    const dropped = [
      ...Array.from({ length: 3 }, () => eventRow(SESSION, THINKING_UPDATE)),
      eventRow(OTHER_SESSION, THINKING_UPDATE),
    ].map((row) => scratch.writer.appendThinkingUpdate(row));
    vi.advanceTimersByTime(1_000);
    // A second with no drop reports none.
    vi.advanceTimersByTime(1_000);

    const dropCounts = serviceLog.filter((line) => line.startsWith("event_dropped"));
    expect(dropCounts).toEqual([
      `event_dropped: 3 ${THINKING_UPDATE} events were dropped at the full write queue in the ` +
        `last second; session_id=${SESSION} event_type=${THINKING_UPDATE}.`,
      `event_dropped: 1 ${THINKING_UPDATE} events were dropped at the full write queue in the ` +
        `last second; session_id=${OTHER_SESSION} event_type=${THINKING_UPDATE}.`,
    ]);

    vi.useRealTimers();
    expect(await Promise.all(dropped)).toStrictEqual(Array(4).fill({ isStored: false }));
    await Promise.all(filling);
  });
});
