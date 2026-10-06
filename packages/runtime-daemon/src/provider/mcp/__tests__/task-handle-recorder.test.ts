// Records an MCP task's receiver-generated `taskId` on its `command_receipts` row so recovery can
// poll it. A handle that cannot be stored exactly as issued leaves the column NULL (the call
// stays halted after a restart, never run again), and no failure here ever fails a turn.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch-file.js";

import {
  DRIVER_DIAGNOSTIC_COUNTER_NAMES,
  DriverDiagnosticsEmitter,
  InMemoryDriverDiagnosticCounterSink,
  type DriverDiagnosticRecord,
} from "../../driver/diagnostics.js";
import { observeMcpTaskAcceptance } from "../tool-calls.js";
import {
  classifyMcpTaskIdRefusal,
  MCP_TASK_ID_MAX_LENGTH,
  McpTaskHandleRecorder,
} from "../task-handle-recorder.js";

// Built rather than typed: a raw U+0000 in source is invisible in editors and diffs.
const NUL_CODE_UNIT = String.fromCharCode(0);

const COMMAND_ID = "command-7";

describe("McpTaskHandleRecorder", () => {
  let scratch: ScratchDatabase;
  // The test's own connection, for seeding and for writing past the recorder.
  let db: DatabaseType;
  let loggedRecords: DriverDiagnosticRecord[];
  let counterSink: InMemoryDriverDiagnosticCounterSink;
  let recorder: McpTaskHandleRecorder;

  beforeEach(async () => {
    scratch = await openScratchDatabase();
    db = new Database(scratch.databasePath);
    insertReceipt(COMMAND_ID);
    loggedRecords = [];
    counterSink = new InMemoryDriverDiagnosticCounterSink();
    recorder = new McpTaskHandleRecorder(scratch.writer, {
      provider: "codex",
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: (record) => loggedRecords.push(record) },
        counterSink,
      }),
    });
  });

  afterEach(async () => {
    db.close();
    await scratch.close();
  });

  // Names only the columns the schema requires; `mcp_task_id` starts NULL.
  function insertReceipt(commandId: string): void {
    db.prepare(
      `INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`receipt-${commandId}`, commandId, "run-1", "accepted", "2026-08-31T00:00:00.000Z");
  }

  function storedHandle(commandId: string): string | null | undefined {
    const row = db
      .prepare("SELECT mcp_task_id FROM command_receipts WHERE command_id = ?")
      .get(commandId) as { mcp_task_id: string | null } | undefined;
    return row?.mcp_task_id;
  }

  function observation(mcpTaskId: string, commandId: string = COMMAND_ID) {
    return { commandId, serverName: "filesystem", toolName: "read_file", mcpTaskId };
  }

  function refusalCount(): number {
    return counterSink.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.mcp_task_handle_write_refused);
  }

  describe("the active state", () => {
    it("leaves NULL when the acceptance never arrived — the crash case", async () => {
      // A crash before the acceptance is stored leaves no `CreateTaskResult` to parse, so nothing
      // reaches the recorder and the call stays halted, never run again.
      await observeMcpTaskAcceptance(
        recorder.asSink(),
        { commandId: COMMAND_ID, serverName: "filesystem", toolName: "read_file" },
        undefined,
      );

      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(loggedRecords).toEqual([]);
    });

    it("carries a handle from the observation seam through to the column", async () => {
      await observeMcpTaskAcceptance(
        recorder.asSink(),
        { commandId: COMMAND_ID, serverName: "filesystem", toolName: "read_file" },
        { task: { taskId: "task-observed" } },
      );

      expect(storedHandle(COMMAND_ID)).toBe("task-observed");
    });
  });

  describe("re-observation and conflict", () => {
    it("refuses a DIFFERENT handle and keeps the first, never overwriting", async () => {
      await recorder.record(observation("task-first"));

      expect(await recorder.record(observation("task-second"))).toEqual({
        status: "refused",
        reason: "handle_conflict",
      });

      // The stored handle is the poll target for a task that may already be running, so
      // last-writer-wins would lose it.
      expect(storedHandle(COMMAND_ID)).toBe("task-first");
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.dispositionReason).toBe("handle_conflict");
    });
  });

  describe("the bound, mirrored from the column", () => {
    it("never carries the refused handle into the diagnostic, only a bounded measurement", async () => {
      const overlongHandle = "a".repeat(MCP_TASK_ID_MAX_LENGTH + 44);
      await recorder.record(observation(overlongHandle));

      const details = loggedRecords[0]?.details ?? {};
      // The scan stops at the cap, so the diagnostic reports MCP_TASK_ID_MAX_LENGTH + 1 ("at
      // least 257"), not the true length.
      expect(details["handleCodePointsScanned"]).toBe(MCP_TASK_ID_MAX_LENGTH + 1);
      expect(details["commandId"]).toBe(COMMAND_ID);
      expect(details["serverName"]).toBe("filesystem");
      expect(details["toolName"]).toBe("read_file");
      // The refused handle must stay out of durable surfaces.
      expect(Object.values(details)).not.toContain(overlongHandle);
    });
  });

  describe("well-formedness, which the column's CHECK cannot see", () => {
    // A lone surrogate is the one defect that passes the column's CHECK. Escaped rather than
    // typed: editors render it as a replacement glyph.
    const LONE_HIGH_SURROGATE = "task-\uD800-9";
    const LONE_LOW_SURROGATE = "task-\uDC00-9";

    it("proves the hazard is real before asserting the guard against it", () => {
      // Written straight to the column, bypassing the recorder: if the round trip were lossless
      // the refusals below would guard nothing.
      db.prepare("UPDATE command_receipts SET mcp_task_id = ? WHERE command_id = ?").run(
        LONE_HIGH_SURROGATE,
        COMMAND_ID,
      );

      const readBack = storedHandle(COMMAND_ID);
      expect(readBack).not.toBe(LONE_HIGH_SURROGATE);
      // A lone surrogate has no UTF-8 encoding, so the row holds U+FFFD replacement characters
      // in place of a handle the receiver never issued. How many depends on the platform (one per
      // surrogate on macOS, one per WTF-8 byte on the Linux CI runners), so the width is not
      // pinned.
      expect(readBack).toMatch(/^task-\uFFFD+-9$/);
    });

    it.each([
      ["a lone HIGH surrogate", LONE_HIGH_SURROGATE],
      ["a lone LOW surrogate", LONE_LOW_SURROGATE],
      ["a trailing unpaired high surrogate", "task-9\uD83D"],
    ])("refuses %s and leaves the column NULL", async (_label, handle) => {
      expect(await recorder.record(observation(handle))).toEqual({
        status: "refused",
        reason: "handle_not_well_formed",
      });
      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.dispositionReason).toBe("handle_not_well_formed");
    });
  });
});

describe("classifyMcpTaskIdRefusal", () => {
  it(
    "stops scanning once refusal is inevitable, so " +
      "a hostile taskId cannot buy a full traversal",
    () => {
      // A multi-megabyte handle from a hostile MCP server. The NUL sits past the size bound, so
      // only a scan that stops at the bound reports handle_too_long; one that walked two million
      // code units would find the NUL and report handle_contains_nul.
      const hostileHandle = `${"a".repeat(2_000_000)}${NUL_CODE_UNIT}tail`;
      expect(classifyMcpTaskIdRefusal(hostileHandle)).toBe("handle_too_long");
    },
  );
});

describe("storage-failure containment", () => {
  // The handle was storable but the database failed: nothing propagates and the failure is
  // diagnosed, because the caller sees the same `void` either way.

  let scratch: ScratchDatabase;
  let loggedRecords: DriverDiagnosticRecord[];
  let counterSink: InMemoryDriverDiagnosticCounterSink;

  beforeEach(async () => {
    scratch = await openScratchDatabase();
    loggedRecords = [];
    counterSink = new InMemoryDriverDiagnosticCounterSink();
  });

  afterEach(async () => {
    await scratch.close();
  });

  function failureCount(): number {
    return counterSink.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.mcp_task_handle_write_failed);
  }

  it("does not reject through asSink() when the database is READ-ONLY, and diagnoses it", async () => {
    await scratch.writer.write([
      {
        sql: `INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        bindings: ["receipt-ro", COMMAND_ID, "run-1", "accepted", "2026-08-31T00:00:00.000Z"],
      },
      // From here the writer's connection refuses every write, so the failure lands at the claim.
      { sql: "PRAGMA query_only = ON" },
    ]);
    const sink = new McpTaskHandleRecorder(scratch.writer, {
      provider: "claude",
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: (record) => loggedRecords.push(record) },
        counterSink,
      }),
    }).asSink();

    await expect(
      sink({
        commandId: COMMAND_ID,
        serverName: "filesystem",
        toolName: "read_file",
        mcpTaskId: "task-42",
      }),
    ).resolves.toBeUndefined();

    expect(loggedRecords).toHaveLength(1);
    expect(loggedRecords[0]?.kind).toBe("mcp_task_handle_write_failed");
    expect(loggedRecords[0]?.provider).toBe("claude");
    // Matched by prefix because SQLite reports extended codes such as `SQLITE_READONLY_DBMOVED`.
    expect(loggedRecords[0]?.dispositionReason).toMatch(/^SQLITE_READONLY/);
    expect(failureCount()).toBe(1);

    // The receipt stayed NULL, so recovery is not pointed at a handle that was never stored.
    expect(
      scratch.reader
        .prepare("SELECT mcp_task_id FROM command_receipts WHERE command_id = ?")
        .get(COMMAND_ID),
    ).toEqual({ mcp_task_id: null });
  });
});
