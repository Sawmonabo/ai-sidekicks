// The database writer's batches and its full queue: the writes of one batch commit together or not
// at all, a write SQLite ends the transaction under fails its whole batch, and at the queue's cap a
// canonical event waits for the next batch while an assistant's thinking update is dropped.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionEventRow } from "../../events/session/insert.js";
import { openScratchDatabase, type ScratchDatabase } from "../__fixtures__/scratch-file.js";
import { WRITE_QUEUE_CAPACITY, type EventWriteOutcome } from "../writer.js";

const SESSION = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const OTHER_SESSION = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";

let scratch: ScratchDatabase;

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
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
    const first = scratch.writer.appendEvent(eventRow(SESSION));
    const second = scratch.writer.appendEvent(eventRow(OTHER_SESSION));
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
      scratch.writer.appendEvent(eventRow(SESSION)),
      scratch.writer.appendEvent(eventRow(SESSION)),
      scratch.writer.appendEvent(eventRow(OTHER_SESSION)),
    ]);
    expect(appended).toStrictEqual([
      { isStored: true, sequence: 0 },
      { isStored: true, sequence: 1 },
      { isStored: true, sequence: 0 },
    ]);
    expect(storedEventCount()).toBe(3);
  });

  it("keeps every statement of a refused write out and the rest of its batch in", async () => {
    const before = scratch.writer.appendEvent(eventRow(SESSION));
    const refused = scratch.writer.appendEvent(eventRow(SESSION), [
      {
        sql: "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, 'draft', ?)",
        bindings: [SESSION, "2026-10-06T12:00:00.000Z"],
      },
      {
        sql: "UPDATE session_drafts SET text = 'changed' WHERE session_id = ?",
        bindings: [SESSION],
        expectedRowCount: 2,
      },
    ]);
    const after = scratch.writer.appendEvent(eventRow(SESSION));

    await expect(refused).rejects.toMatchObject({ statementIndex: 1, rowCount: 1 });
    expect(await before).toStrictEqual({ isStored: true, sequence: 0 });
    expect(await after).toStrictEqual({ isStored: true, sequence: 1 });
    expect(storedEventCount()).toBe(2);
    expect(scratch.reader.prepare("SELECT * FROM session_drafts").all()).toStrictEqual([]);
  });

  it("fails whole when SQLite ends its transaction under one write", async () => {
    // A full database ends the transaction; the writes after it would otherwise commit one by one
    // while their callers were told the batch failed.
    const before = scratch.writer.appendEvent(eventRow(SESSION));
    const full = scratch.writer.write([
      { sql: "PRAGMA max_page_count = 1" },
      {
        sql: "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?)",
        bindings: [SESSION, "x".repeat(1_000_000), "2026-10-06T12:00:00.000Z"],
      },
    ]);
    const after = scratch.writer.appendEvent(eventRow(OTHER_SESSION));

    await expect(full).rejects.toMatchObject({ code: "SQLITE_FULL" });
    await expect(before).rejects.toMatchObject({ code: "SQLITE_FULL" });
    await expect(after).rejects.toMatchObject({ code: "SQLITE_FULL" });
    expect(storedEventCount()).toBe(0);
  });
});

describe("the queue at its cap", () => {
  it("holds a canonical event for the next batch and drops a thinking update", async () => {
    // Offered in one turn, the first writes fill the queue before any batch can commit.
    const filling: Promise<EventWriteOutcome>[] = [];
    for (let index = 0; index < WRITE_QUEUE_CAPACITY; index += 1) {
      filling.push(scratch.writer.appendEvent(eventRow(SESSION)));
    }
    const canonical = scratch.writer.appendEvent(eventRow(OTHER_SESSION));
    const thinking = scratch.writer.appendEvent(
      eventRow(OTHER_SESSION, "assistant.thinking_update"),
    );

    expect(await thinking).toStrictEqual({ isStored: false });
    expect(await isSettled(canonical)).toBe(false);
    expect(await canonical).toStrictEqual({ isStored: true, sequence: 0 });
    await Promise.all(filling);
    expect(storedEventCount("session.updated")).toBe(WRITE_QUEUE_CAPACITY + 1);
    expect(storedEventCount("assistant.thinking_update")).toBe(0);
  });
});
