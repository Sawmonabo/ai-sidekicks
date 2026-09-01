// MCP Tasks durable recovery handle — write seam (Plan-005 T5.1).
//
// Spec coverage under test:
//   • `Spec-005 §Tool Metadata` / `Spec-015 §Idempotency Classes and Recovery Behavior` — a task-augmented MCP
//     call's receiver-generated `taskId` is durably recorded on its
//     `command_receipts` row, so recovery polls `tasks/get` + `tasks/result`
//     instead of halting. Asserted end-to-end from each driver's observation
//     seam through the recorder to the column.
//   • The T2.1 defense-in-depth convention — the untrusted handle is bounded at
//     the write seam as well as by the column's CHECK, and the two bounds are
//     asserted to agree, including on the unit they measure in.
//
// Verifies invariant I-005-3 (the conservative floor): every path that fails to
// record a handle leaves the column NULL, which is the state that keeps the
// receipt on the `manual_reconcile_only` halt. No path truncates a handle, and
// no path fails a turn.

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

// Built rather than typed: a raw U+0000 in source is invisible in every editor
// and diff, and this is the conjunct a reader can least verify by eye.
const NUL_CODE_UNIT = String.fromCharCode(0);

const COMMAND_ID = "command-7";

describe("McpTaskHandleRecorder (Plan-005 T5.1)", () => {
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

  // The FIVE-column shell version 15 actually ships. Deliberately not copied
  // from the canonical doc block, whose NOT NULL `idempotency_class` belongs to
  // an EXTEND that has not landed and would name a column that does not exist.
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
      // A success emits nothing: the diagnostic band is for consequence, and a
      // recorded handle has none.
      expect(loggedRecords).toEqual([]);
    });

    it("leaves NULL when the acceptance never arrived — the crash case", () => {
      // A crash before the receiver's acceptance is durably stored reaches the
      // observation seam with no `CreateTaskResult` to parse. Nothing is
      // offered to the recorder, so the column stays NULL and the receipt stays
      // on the manual_reconcile_only halt (I-005-3).
      observeCodexMcpTaskAcceptance(
        recorder.asSink(),
        { commandId: COMMAND_ID, serverName: "filesystem", toolName: "read_file" },
        undefined,
      );

      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(loggedRecords).toEqual([]);
    });

    it("carries a handle from each driver's observation seam through to the column", () => {
      // The recorder is provider-neutral and both drivers' seams are separate
      // modules, so the wiring is asserted for each rather than for one and
      // assumed for the other.
      insertReceipt("command-claude");

      // Bound at each driver's OWN exported sink type rather than passed
      // anonymously. The recorder's sink shape and the drivers' coincide today
      // and nothing but these two annotations says they have to.
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
      // An idempotent replay is not a refusal and must not be counted as one —
      // otherwise a retried dispatch reads as a receiver that changed its mind.
      expect(refusalCount()).toBe(0);
    });

    it("refuses a DIFFERENT handle and keeps the first, never overwriting", () => {
      recorder.record(observation("task-first"));

      expect(recorder.record(observation("task-second"))).toEqual({
        status: "refused",
        reason: "handle_conflict",
      });

      // The stored handle is the durable poll target for a task that may
      // already be running; losing it is exactly what the column exists to
      // prevent, so last-writer-wins is the wrong rule here.
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

      // Refused, never truncated. A truncated handle names a different task or
      // no task, and recovery would poll `tasks/get` against it and act on the
      // answer — NULL is the only safe degradation.
      expect(storedHandle(COMMAND_ID)).toBeNull();
      expect(refusalCount()).toBe(1);
      expect(loggedRecords[0]?.provider).toBe("codex");
      expect(loggedRecords[0]?.kind).toBe("mcp_task_handle_write_refused");
    });

    it("admits a handle exactly at the bound — the positive control for the three refusals", () => {
      // Without this the three assertions above would pass against a guard that
      // rejects everything.
      const boundLengthHandle = "a".repeat(MCP_TASK_ID_MAX_LENGTH);
      expect(recorder.record(observation(boundLengthHandle))).toEqual({ status: "recorded" });
      expect(storedHandle(COMMAND_ID)).toBe(boundLengthHandle);
    });

    it("measures the bound in code points, exactly as the column's length() does", () => {
      // 256 astral characters: 256 to SQLite, 512 to `String.prototype.length`.
      // The column admits it (asserted in the migration-shape suite), so a guard
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

    it("never carries the refused handle into the diagnostic, only its length", () => {
      const overlongHandle = "a".repeat(MCP_TASK_ID_MAX_LENGTH + 44);
      recorder.record(observation(overlongHandle));

      const details = loggedRecords[0]?.details ?? {};
      expect(details["handleLength"]).toBe(MCP_TASK_ID_MAX_LENGTH + 44);
      expect(details["commandId"]).toBe(COMMAND_ID);
      expect(details["serverName"]).toBe("filesystem");
      expect(details["toolName"]).toBe("read_file");
      // Refusing an unbounded handle and then logging it verbatim would defeat
      // the refusal — the whole point is to keep it out of durable surfaces.
      expect(Object.values(details)).not.toContain(overlongHandle);
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

  it("reports a long NUL-bearing handle by its NUL, which SQLite's length() cannot see", () => {
    // `length()` STOPS at an embedded NUL, so this 300-code-point value measures
    // 5 in the database. Classifying by length first would call it well-sized
    // when the real defect is the NUL — and the column would still refuse it,
    // on a conjunct the diagnostic had not named.
    const longNulBearingHandle = `task-${NUL_CODE_UNIT}${"b".repeat(294)}`;
    expect(longNulBearingHandle.length).toBeGreaterThan(MCP_TASK_ID_MAX_LENGTH);
    expect(classifyMcpTaskIdRefusal(longNulBearingHandle)).toBe("handle_contains_nul");
  });
});

describe("the observation shapes the recorder and the two drivers each declare", () => {
  it("stays structurally interchangeable in BOTH directions", () => {
    // A compile-time pin: the annotated assignments below ARE the assertion and
    // the expectations only keep the bindings live. Three modules declare this
    // shape independently — each driver its own, the recorder a third — and
    // nothing else holds them equivalent.
    //
    // Both directions are asserted because either one alone is satisfied by a
    // shape that GREW a required member: assigning a driver observation into the
    // recorder's record still compiles when the driver adds a field, and that is
    // exactly the divergence that would leave the new field silently unread.
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
