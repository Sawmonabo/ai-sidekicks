// The write seam for an MCP task handle. A task-augmented MCP call's receiver-generated `taskId`
// is recorded on its `command_receipts` row so recovery can poll `tasks/get` and `tasks/result`.
// Every path that fails to record a handle leaves the column NULL (the receipt stays on the
// `manual_reconcile_only` halt), never truncates a handle, and never fails a turn.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_DIAGNOSTIC_COUNTER_NAMES,
  DriverDiagnosticsEmitter,
  InMemoryDriverDiagnosticCounterSink,
  type DriverDiagnosticRecord,
} from "../driver-diagnostics.js";
import {
  observeMcpTaskAcceptance as observeClaudeMcpTaskAcceptance,
  type McpTaskHandleObservation as ClaudeMcpTaskHandleObservation,
  type McpTaskHandleSink as ClaudeMcpTaskHandleSink,
} from "../drivers/claude/tools.js";
import {
  observeMcpTaskAcceptance as observeCodexMcpTaskAcceptance,
  type McpTaskHandleObservation as CodexMcpTaskHandleObservation,
  type McpTaskHandleSink as CodexMcpTaskHandleSink,
} from "../drivers/codex/tools.js";
import {
  classifyMcpTaskIdRefusal,
  MCP_TASK_ID_MAX_LENGTH,
  McpTaskHandleRecorder,
  type McpTaskHandleObservationRecord,
} from "../mcp-task-handle-recorder.js";
import { applyMigrations, applyPragmas } from "../../session/migration-runner.js";

// Built rather than typed: a raw U+0000 in source is invisible in editors and diffs.
const NUL_CODE_UNIT = String.fromCharCode(0);

const COMMAND_ID = "command-7";

describe("McpTaskHandleRecorder", () => {
  let db: DatabaseType;
  let loggedRecords: DriverDiagnosticRecord[];
  let counterSink: InMemoryDriverDiagnosticCounterSink;
  let recorder: McpTaskHandleRecorder;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
    insertReceipt(COMMAND_ID);
    loggedRecords = [];
    counterSink = new InMemoryDriverDiagnosticCounterSink();
    recorder = new McpTaskHandleRecorder(db, {
      provider: "codex",
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: (record) => loggedRecords.push(record) },
        counterSink,
      }),
    });
  });

  afterEach(() => {
    db.close();
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
    it("records the handle on acceptance", () => {
      expect(storedHandle(COMMAND_ID)).toBeNull();

      expect(recorder.record(observation("task-9"))).toEqual({ status: "recorded" });

      expect(storedHandle(COMMAND_ID)).toBe("task-9");
      // A success emits no diagnostic.
      expect(loggedRecords).toEqual([]);
    });

    it("leaves NULL when the acceptance never arrived — the crash case", () => {
      // A crash before the acceptance is stored leaves no `CreateTaskResult` to parse, so nothing
      // reaches the recorder and the receipt stays on the `manual_reconcile_only` halt.
      observeCodexMcpTaskAcceptance(
        recorder.asSink(),
        { commandId: COMMAND_ID, serverName: "filesystem", toolName: "read_file" },
        undefined,
      );

      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(loggedRecords).toEqual([]);
    });

    it("carries a handle from each driver's observation seam through to the column", () => {
      // The recorder is provider-neutral and each driver has its own seam module, so both are
      // exercised.
      insertReceipt("command-claude");

      // Typed as each driver's own exported sink type; these annotations are what keep the
      // recorder's sink shape and the drivers' equal.
      const codexSink: CodexMcpTaskHandleSink = recorder.asSink();
      const claudeSink: ClaudeMcpTaskHandleSink = recorder.asSink();

      observeCodexMcpTaskAcceptance(
        codexSink,
        { commandId: COMMAND_ID, serverName: "filesystem", toolName: "read_file" },
        { task: { taskId: "task-codex" } },
      );
      observeClaudeMcpTaskAcceptance(
        claudeSink,
        { commandId: "command-claude", serverName: "filesystem", toolName: "read_file" },
        { task: { taskId: "task-claude" } },
      );

      expect(storedHandle(COMMAND_ID)).toBe("task-codex");
      expect(storedHandle("command-claude")).toBe("task-claude");
    });
  });

  describe("re-observation and conflict", () => {
    it("reports an identical re-observation as already recorded, not as a conflict", () => {
      recorder.record(observation("task-9"));

      expect(recorder.record(observation("task-9"))).toEqual({ status: "already-recorded" });

      expect(storedHandle(COMMAND_ID)).toBe("task-9");
      // A replay is not a refusal; counting it as one would make a retried dispatch look like a
      // receiver that changed its mind.
      expect(refusalCount()).toBe(0);
    });

    it("refuses a DIFFERENT handle and keeps the first, never overwriting", () => {
      recorder.record(observation("task-first"));

      expect(recorder.record(observation("task-second"))).toEqual({
        status: "refused",
        reason: "handle_conflict",
      });

      // The stored handle is the poll target for a task that may already be running, so
      // last-writer-wins would lose it.
      expect(storedHandle(COMMAND_ID)).toBe("task-first");
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.dispositionReason).toBe("handle_conflict");
    });

    it("refuses when no receipt row carries the command id", () => {
      expect(recorder.record(observation("task-9", "command-absent"))).toEqual({
        status: "refused",
        reason: "receipt_absent",
      });

      expect(storedHandle("command-absent")).toBeUndefined();
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.dispositionReason).toBe("receipt_absent");
    });
  });

  describe("the bound, mirrored from the column", () => {
    it.each([
      ["an empty handle", "", "handle_empty"],
      ["a handle one past the bound", "a".repeat(MCP_TASK_ID_MAX_LENGTH + 1), "handle_too_long"],
      ["a NUL-bearing handle", `task-${NUL_CODE_UNIT}9`, "handle_contains_nul"],
    ])("refuses %s and leaves the column NULL", (_label, handle, expectedReason) => {
      expect(recorder.record(observation(handle))).toEqual({
        status: "refused",
        reason: expectedReason,
      });

      // Refused, never truncated: recovery would poll a truncated handle and act on the answer.
      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.provider).toBe("codex");
      expect(loggedRecords[0]?.kind).toBe("mcp_task_handle_write_refused");
    });

    it("admits a handle exactly at the bound — the positive control for the three refusals", () => {
      // Guards against the refusals above passing because everything is rejected.
      const boundLengthHandle = "a".repeat(MCP_TASK_ID_MAX_LENGTH);
      expect(recorder.record(observation(boundLengthHandle))).toEqual({ status: "recorded" });
      expect(storedHandle(COMMAND_ID)).toBe(boundLengthHandle);
    });

    it("measures the bound in code points, exactly as the column's length() does", () => {
      // 256 astral characters are 256 to SQLite but 512 to `String.prototype.length`; a guard
      // counting UTF-16 code units would refuse a handle the database accepts.
      const astralHandle = "\u{1F600}".repeat(MCP_TASK_ID_MAX_LENGTH);
      expect(astralHandle.length).toBe(MCP_TASK_ID_MAX_LENGTH * 2);

      expect(recorder.record(observation(astralHandle))).toEqual({ status: "recorded" });
      expect(storedHandle(COMMAND_ID)).toBe(astralHandle);
    });

    it("refuses one code point past the bound, so the astral accept is a bound and not its absence", () => {
      expect(recorder.record(observation("\u{1F600}".repeat(MCP_TASK_ID_MAX_LENGTH + 1)))).toEqual({
        status: "refused",
        reason: "handle_too_long",
      });
      expect(storedHandle(COMMAND_ID)).toBeNull();
    });

    it("never carries the refused handle into the diagnostic, only a bounded measurement", () => {
      const overlongHandle = "a".repeat(MCP_TASK_ID_MAX_LENGTH + 44);
      recorder.record(observation(overlongHandle));

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
    ])("refuses %s and leaves the column NULL", (_label, handle) => {
      expect(recorder.record(observation(handle))).toEqual({
        status: "refused",
        reason: "handle_not_well_formed",
      });
      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.dispositionReason).toBe("handle_not_well_formed");
    });

    it("accepts a WELL-FORMED surrogate pair — the positive control", () => {
      // Guards against refusing every string that contains a surrogate code unit, which would
      // reject emoji a receiver may put in a handle.
      const astralHandle = "task-\u{1F600}-9";
      expect(recorder.record(observation(astralHandle))).toEqual({ status: "recorded" });
      expect(storedHandle(COMMAND_ID)).toBe(astralHandle);
    });
  });
});

describe("classifyMcpTaskIdRefusal", () => {
  it("admits a storable handle", () => {
    expect(classifyMcpTaskIdRefusal("task-9")).toBeUndefined();
    expect(classifyMcpTaskIdRefusal("a".repeat(MCP_TASK_ID_MAX_LENGTH))).toBeUndefined();
  });

  it("names which conjunct failed rather than reporting a generic violation", () => {
    expect(classifyMcpTaskIdRefusal("")).toBe("handle_empty");
    expect(classifyMcpTaskIdRefusal("a".repeat(MCP_TASK_ID_MAX_LENGTH + 1))).toBe(
      "handle_too_long",
    );
    expect(classifyMcpTaskIdRefusal(`a${NUL_CODE_UNIT}b`)).toBe("handle_contains_nul");
  });

  it("reports a long NOT-WELL-FORMED handle by its surrogate, not by its length", () => {
    // Both defects are present; the well-formedness check comes first so an operator is not sent
    // hunting for an over-long handle when the stored bytes would not be the receiver's.
    expect(classifyMcpTaskIdRefusal("\uD800".repeat(MCP_TASK_ID_MAX_LENGTH + 1))).toBe(
      "handle_not_well_formed",
    );
  });

  it("reports a long NUL-bearing handle by its NUL, which SQLite's length() cannot see", () => {
    // SQLite's `length()` stops at an embedded NUL, so this 300-code-point value measures 5
    // there; classifying by length first would miss the NUL.
    const longNulBearingHandle = `task-${NUL_CODE_UNIT}${"b".repeat(294)}`;
    expect(longNulBearingHandle.length).toBeGreaterThan(MCP_TASK_ID_MAX_LENGTH);
    expect(classifyMcpTaskIdRefusal(longNulBearingHandle)).toBe("handle_contains_nul");
  });

  it("stops scanning once refusal is inevitable, so a hostile taskId cannot buy a full traversal", () => {
    // A multi-megabyte handle from a hostile MCP server. The NUL sits past the size bound, so
    // only a scan that stops at the bound reports handle_too_long; one that walked two million
    // code units would find the NUL and report handle_contains_nul.
    const hostileHandle = `${"a".repeat(2_000_000)}${NUL_CODE_UNIT}tail`;
    expect(classifyMcpTaskIdRefusal(hostileHandle)).toBe("handle_too_long");
  });
});

describe("the observation shapes the recorder and the two drivers each declare", () => {
  it("stays structurally interchangeable in BOTH directions", () => {
    // A compile-time pin: the annotated assignments are the assertion. Three modules declare
    // this shape independently (each driver, and the recorder). Both directions are needed
    // because assigning a driver observation into the recorder's record still compiles when the
    // driver adds a field, which would leave that field unread.
    const recorderRecord: McpTaskHandleObservationRecord = {
      commandId: COMMAND_ID,
      serverName: "filesystem",
      toolName: "read_file",
      mcpTaskId: "task-9",
    };

    const codexObservation: CodexMcpTaskHandleObservation = recorderRecord;
    const claudeObservation: ClaudeMcpTaskHandleObservation = recorderRecord;
    const recordFromCodex: McpTaskHandleObservationRecord = codexObservation;
    const recordFromClaude: McpTaskHandleObservationRecord = claudeObservation;

    expect(recordFromCodex).toEqual(recorderRecord);
    expect(recordFromClaude).toEqual(recorderRecord);
  });
});

describe("storage-failure containment", () => {
  // The handle was storable but the database failed. Each case asserts that nothing propagates
  // and the failure is diagnosed, because the caller sees the same `void` either way.

  let temporaryDirectory: string;
  let loggedRecords: DriverDiagnosticRecord[];
  let counterSink: InMemoryDriverDiagnosticCounterSink;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mcp-task-handle-"));
    loggedRecords = [];
    counterSink = new InMemoryDriverDiagnosticCounterSink();
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function buildRecorder(database: DatabaseType): McpTaskHandleRecorder {
    return new McpTaskHandleRecorder(database, {
      provider: "claude",
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: (record) => loggedRecords.push(record) },
        counterSink,
      }),
    });
  }

  function migratedFileDatabase(): string {
    const databasePath = join(temporaryDirectory, "daemon.sqlite");
    const writable = new Database(databasePath);
    applyPragmas(writable);
    applyMigrations(writable);
    writable
      .prepare(
        `INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("receipt-ro", COMMAND_ID, "run-1", "accepted", "2026-08-31T00:00:00.000Z");
    writable.close();
    return databasePath;
  }

  function failureCount(): number {
    return counterSink.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.mcp_task_handle_write_failed);
  }

  it("does not throw through asSink() when the database is READ-ONLY, and diagnoses it", () => {
    const readOnlyDatabase = new Database(migratedFileDatabase(), { readonly: true });
    // `prepare` succeeds on a read-only handle, so the failure lands at the write, inside a turn.
    const sink = buildRecorder(readOnlyDatabase).asSink();

    expect(() => {
      sink({
        commandId: COMMAND_ID,
        serverName: "filesystem",
        toolName: "read_file",
        mcpTaskId: "task-42",
      });
    }).not.toThrow();

    expect(loggedRecords).toHaveLength(1);
    expect(loggedRecords[0]?.kind).toBe("mcp_task_handle_write_failed");
    expect(loggedRecords[0]?.provider).toBe("claude");
    // Matched by prefix because SQLite reports extended codes such as `SQLITE_READONLY_DBMOVED`.
    expect(loggedRecords[0]?.dispositionReason).toMatch(/^SQLITE_READONLY/);
    expect(failureCount()).toBe(1);

    readOnlyDatabase.close();

    // The receipt stayed NULL, so recovery is not pointed at a handle that was never stored.
    const verifier = new Database(join(temporaryDirectory, "daemon.sqlite"), { readonly: true });
    expect(
      verifier
        .prepare("SELECT mcp_task_id FROM command_receipts WHERE command_id = ?")
        .get(COMMAND_ID),
    ).toEqual({ mcp_task_id: null });
    verifier.close();
  });

  it("contains a NON-SqliteError too, and names it rather than hiding it", () => {
    // A closed handle raises a plain `TypeError`, standing in for any defect in this module,
    // which must not fail a turn either; `errorName` tells it apart from a sick database.
    const database = new Database(":memory:");
    applyPragmas(database);
    applyMigrations(database);
    const sink = buildRecorder(database).asSink();
    database.close();

    expect(() => {
      sink({
        commandId: COMMAND_ID,
        serverName: "filesystem",
        toolName: "read_file",
        mcpTaskId: "task-42",
      });
    }).not.toThrow();

    expect(loggedRecords[0]?.kind).toBe("mcp_task_handle_write_failed");
    // No SQLite result code on a thrown value that never reached SQLite.
    expect(loggedRecords[0]?.dispositionReason).toBe("unknown_storage_error");
    expect(loggedRecords[0]?.details?.["errorName"]).toBe("TypeError");
    expect(failureCount()).toBe(1);
  });

  it("reports the failure as a distinct outcome arm, never as a refusal", () => {
    // Keeps "the peer sent garbage" apart from "our database is read-only".
    const readOnlyDatabase = new Database(migratedFileDatabase(), { readonly: true });
    const outcome = buildRecorder(readOnlyDatabase).record({
      commandId: COMMAND_ID,
      serverName: "filesystem",
      toolName: "read_file",
      mcpTaskId: "task-42",
    });
    readOnlyDatabase.close();

    expect(outcome.status).toBe("storage-failed");
    expect(failureCount()).toBe(1);
    expect(
      counterSink.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.mcp_task_handle_write_refused),
    ).toBe(0);
  });
});
