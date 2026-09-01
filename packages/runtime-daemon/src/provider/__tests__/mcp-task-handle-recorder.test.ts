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
import { INITIAL_MIGRATION_SQL } from "../../migrations/0001-initial.js";
import { QUEUE_AND_INTERVENTIONS_MIGRATION_SQL } from "../../migrations/0015-queue-and-interventions.js";
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

  describe("well-formedness, which the column's CHECK cannot see", () => {
    // A lone surrogate is the one defect that reaches the column looking valid.
    // Escaped rather than typed: an unpaired surrogate renders as a replacement
    // glyph in most editors, indistinguishable from the U+FFFD it would become.
    const LONE_HIGH_SURROGATE = "task-\uD800-9";
    const LONE_LOW_SURROGATE = "task-\uDC00-9";

    it("proves the hazard is real before asserting the guard against it", () => {
      // The negative control for this whole describe. Written STRAIGHT to the
      // column, bypassing the recorder: if the round trip were lossless the
      // refusals below would be guarding against nothing.
      db.prepare("UPDATE command_receipts SET mcp_task_id = ? WHERE command_id = ?").run(
        LONE_HIGH_SURROGATE,
        COMMAND_ID,
      );

      const readBack = storedHandle(COMMAND_ID);
      expect(readBack).not.toBe(LONE_HIGH_SURROGATE);
      // U+FFFD REPLACEMENT CHARACTER — the lone surrogate has no UTF-8
      // encoding, so the row now holds a handle the receiver never issued and
      // the CHECK passed it without complaint.
      expect(readBack).toBe("task-\uFFFD-9");
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
      // Without this, the refusals above would pass against a guard that
      // rejects every string containing any surrogate code unit at all, which
      // would reject every emoji a receiver is entitled to put in a handle.
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
    // The representation-before-size ordering, asserted rather than assumed.
    // Both defects are present; naming the length would send an operator
    // hunting for an over-long handle when the real fault is a handle whose
    // stored bytes would not be the receiver's.
    expect(classifyMcpTaskIdRefusal("\uD800".repeat(MCP_TASK_ID_MAX_LENGTH + 1))).toBe(
      "handle_not_well_formed",
    );
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

describe("storage-failure containment", () => {
  // The seam's contract is that observing a handle cannot fail a turn, and a
  // malformed handle is only half of what could go wrong. These cover the other
  // half: the handle was storable and the DATABASE refused it. Every arm asserts
  // the same two things — nothing propagates, and the failure is diagnosed
  // rather than swallowed — because a silently dropped handle and a successfully
  // written one leave the caller looking at the identical `void`.

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
    // Constructed against the read-only handle deliberately: `prepare` succeeds
    // on a readable schema, so the failure lands where it must — at the write,
    // inside a turn — and not at wiring time.
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
    // The SQLite result code, which is the diagnosis. Asserted by prefix rather
    // than equality because SQLite reports extended codes here
    // (`SQLITE_READONLY_DBMOVED` and friends) and pinning one of them would
    // make this a test of the platform's error taxonomy, not of containment.
    expect(loggedRecords[0]?.dispositionReason).toMatch(/^SQLITE_READONLY/);
    expect(failureCount()).toBe(1);

    readOnlyDatabase.close();

    // The conservative floor (I-005-3): the receipt stayed NULL, so the call
    // stays on the `manual_reconcile_only` halt rather than pointing recovery
    // at a handle that was never durably stored.
    const verifier = new Database(join(temporaryDirectory, "daemon.sqlite"), { readonly: true });
    expect(
      verifier
        .prepare("SELECT mcp_task_id FROM command_receipts WHERE command_id = ?")
        .get(COMMAND_ID),
    ).toEqual({ mcp_task_id: null });
    verifier.close();
  });

  it("contains a NON-SqliteError too, and names it rather than hiding it", () => {
    // A closed handle raises a plain `TypeError` from better-sqlite3, which
    // stands in for the wider class this catch deliberately covers: a defect in
    // this module must not fail a provider turn either. What keeps it from
    // being indistinguishable from a sick database is `errorName`.
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
    // The arms are separate so a caller — and an operator reading the counter —
    // can tell "the peer sent us garbage" from "our database is read-only".
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

describe("the pre-migration state", () => {
  it("cannot even CONSTRUCT the write seam before the migration lands", () => {
    // The obligation "assert the dormant pre-state — the Phase-3 seam writes no
    // handle before this migration" (Plan-005 T5.1), in the only form that is
    // still honest once the seam is live. Before this task there was a sink
    // that discarded; asserting THAT today would assert a contract the corpus
    // no longer has. What remains true, and is stronger, is that the write is
    // not merely inert without the column but unreachable: the recorder
    // prepares its statements in the CONSTRUCTOR, so a handle cannot be written
    // to a database that never ran 0017 — it fails at wiring time, at the
    // composition root, rather than once per turn inside a diagnostic nobody
    // is watching. This is the `wireTurnSnapshotRetentionSweep` posture, and it
    // is why the storage-failure containment above deliberately does not extend
    // to construction.
    const preMigrationDatabase = new Database(":memory:");
    applyPragmas(preMigrationDatabase);
    preMigrationDatabase.exec(INITIAL_MIGRATION_SQL);
    preMigrationDatabase.exec(QUEUE_AND_INTERVENTIONS_MIGRATION_SQL);

    // `command_receipts` exists at this point — the shell is version 15's — so
    // the throw below is about the COLUMN and not about a missing table.
    expect(
      preMigrationDatabase
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("command_receipts"),
    ).toEqual({ name: "command_receipts" });

    expect(
      () =>
        new McpTaskHandleRecorder(preMigrationDatabase, {
          provider: "codex",
          diagnostics: new DriverDiagnosticsEmitter({
            logSink: { record: () => undefined },
            counterSink: new InMemoryDriverDiagnosticCounterSink(),
          }),
        }),
    ).toThrow(/no such column: mcp_task_id/);

    preMigrationDatabase.close();
  });
});
