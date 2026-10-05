// The write seam for the MCP Tasks durable recovery handle: the observation half
// (`observeMcpTaskAcceptance` in `./tool-calls.ts`) writes through this sink, the only writer
// of `command_receipts.mcp_task_id`.
//
//   * The 256 bound repeats the column's CHECK so a violation is refused with a diagnostic naming
//     the server, tool and length, not an opaque SQLITE_CONSTRAINT.
//   * An over-bound handle is refused, never truncated (a truncated one names another task).
//     A refusal leaves the column NULL, so after a restart the call stays halted, never run
//     again.
//   * The UPDATE only fires on `mcp_task_id IS NULL` (first wins). Zero rows changed is resolved
//     by one SELECT: no receipt, the same handle (idempotent success), or another (refused).

import type { Database, Statement } from "better-sqlite3";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import type { DriverDiagnosticsEmitter } from "../driver/diagnostics.js";
import type { McpTaskHandleObservation, McpTaskHandleSink } from "./tool-calls.js";

/**
 * The maximum stored length of an MCP `taskId`, in Unicode code points as SQLite's `length()`
 * counts them (up to the first U+0000; JavaScript `.length` counts UTF-16 units and would refuse
 * astral handles the column accepts). Mirrors the CHECK in `session/daemon-schema.ts`.
 */
export const MCP_TASK_ID_MAX_LENGTH: number = 256;

/**
 * Why a handle was refused. The first three mirror the column's CHECK conjuncts;
 * `handle_not_well_formed` has none (a lone surrogate becomes U+FFFD on UTF-8 encoding and would
 * pass); the last two are storage states the CHECK cannot express.
 */
export type McpTaskHandleRefusalReason =
  | "handle_empty"
  | "handle_too_long"
  | "handle_contains_nul"
  | "handle_not_well_formed"
  | "receipt_absent"
  | "handle_conflict";

/** The result of offering one handle to the receipt row; `already-recorded` is a success. */
export type McpTaskHandleRecordOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "already-recorded" }
  | { readonly status: "refused"; readonly reason: McpTaskHandleRefusalReason }
  | { readonly status: "storage-failed"; readonly sqliteCode: string | null };

interface HandleScan {
  /** Code points consumed; the exact length only for a clean scan, else where the walk stopped. */
  readonly scannedCodePoints: number;
  readonly hasNul: boolean;
  readonly hasLoneSurrogate: boolean;
  readonly exceededBound: boolean;
}

// An index walk over untrusted peer output of unbounded size: it stops at the first NUL, lone
// surrogate or code point past the bound, so a huge `taskId` costs at most 257 code points.
// Well-formedness is folded in, in place of a second `isWellFormed()` pass.
function scanHandle(value: string): HandleScan {
  let scannedCodePoints = 0;
  let hasNul = false;
  let hasLoneSurrogate = false;
  let index = 0;
  while (
    index < value.length &&
    !hasNul &&
    !hasLoneSurrogate &&
    scannedCodePoints <= MCP_TASK_ID_MAX_LENGTH
  ) {
    const charCode = value.charCodeAt(index);
    const isHighSurrogate = charCode >= 0xd800 && charCode <= 0xdbff;
    const isLowSurrogate = charCode >= 0xdc00 && charCode <= 0xdfff;
    if (charCode === 0) {
      hasNul = true;
    } else if (isHighSurrogate && index + 1 < value.length) {
      const nextCharCode = value.charCodeAt(index + 1);
      const isPaired = nextCharCode >= 0xdc00 && nextCharCode <= 0xdfff;
      if (isPaired) {
        index += 1;
      } else {
        hasLoneSurrogate = true;
      }
    } else if (isHighSurrogate || isLowSurrogate) {
      hasLoneSurrogate = true;
    }
    index += 1;
    scannedCodePoints += 1;
  }
  return {
    scannedCodePoints,
    hasNul,
    hasLoneSurrogate,
    exceededBound: scannedCodePoints > MCP_TASK_ID_MAX_LENGTH,
  };
}

/**
 * Returns why a handle cannot be stored, or `undefined` when it can. Reports the first defect the
 * bounded walk meets, so a multiply invalid handle may differ from the CHECK's order. Exported so
 * the bound is testable without a database.
 */
export function classifyMcpTaskIdRefusal(
  mcpTaskId: string,
): McpTaskHandleRefusalReason | undefined {
  if (mcpTaskId.length === 0) {
    return "handle_empty";
  }
  const scan = scanHandle(mcpTaskId);
  if (scan.hasNul) {
    return "handle_contains_nul";
  }
  if (scan.hasLoneSurrogate) {
    return "handle_not_well_formed";
  }
  if (scan.exceededBound) {
    return "handle_too_long";
  }
  return undefined;
}

interface StoredHandleRow {
  readonly mcp_task_id: string | null;
}

/** The sole writer of `command_receipts.mcp_task_id`; one per driver binding (attribution). */
export class McpTaskHandleRecorder {
  readonly #provider: ProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #claimHandleStatement: Statement<[string, string]>;
  readonly #readStoredHandleStatement: Statement<[string]>;

  constructor(
    database: Database,
    options: {
      readonly provider: ProviderName;
      readonly diagnostics: DriverDiagnosticsEmitter;
    },
  ) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#claimHandleStatement = database.prepare(
      `UPDATE command_receipts
          SET mcp_task_id = ?
        WHERE command_id = ?
          AND mcp_task_id IS NULL`,
    );
    this.#readStoredHandleStatement = database.prepare(
      `SELECT mcp_task_id FROM command_receipts WHERE command_id = ?`,
    );
  }

  /**
   * Offers one observed handle to its receipt row. Never throws (a driver turn must not fail over
   * a recovery optimization): every failure is a typed outcome that leaves the column NULL.
   */
  record(observation: McpTaskHandleObservation): McpTaskHandleRecordOutcome {
    const boundsRefusal = classifyMcpTaskIdRefusal(observation.mcpTaskId);
    if (boundsRefusal !== undefined) {
      return this.#refuse(observation, boundsRefusal);
    }

    try {
      const claimResult = this.#claimHandleStatement.run(
        observation.mcpTaskId,
        observation.commandId,
      );
      if (claimResult.changes > 0) {
        return { status: "recorded" };
      }

      // Zero rows changed: the row is absent or already has a handle. Reading it back tells which;
      // `mcp_task_id` only goes from NULL to non-NULL, so the read-back cannot go stale.
      const storedRow = this.#readStoredHandleStatement.get(observation.commandId) as
        | StoredHandleRow
        | undefined;
      if (storedRow === undefined) {
        return this.#refuse(observation, "receipt_absent");
      }
      if (storedRow.mcp_task_id === observation.mcpTaskId) {
        return { status: "already-recorded" };
      }
      return this.#refuse(observation, "handle_conflict");
    } catch (thrown) {
      return this.#reportStorageFailure(observation, thrown);
    }
  }

  /** The recorder as the `McpTaskHandleSink`; {@link record} diagnoses failures. */
  asSink(): McpTaskHandleSink {
    return (observation: McpTaskHandleObservation): void => {
      this.record(observation);
    };
  }

  #refuse(
    observation: McpTaskHandleObservation,
    reason: McpTaskHandleRefusalReason,
  ): McpTaskHandleRecordOutcome {
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "mcp_task_handle_write_refused",
      rawWireType: null,
      dispositionReason: reason,
      details: {
        commandId: observation.commandId,
        serverName: observation.serverName,
        toolName: observation.toolName,
        // A bounded measurement, never the handle (unbounded peer output): exact for a clean scan,
        // the stop position for a defect, `MCP_TASK_ID_MAX_LENGTH + 1` (at least) if over-bound.
        // Re-scanned because three of the six reasons never ran a scan.
        handleCodePointsScanned: scanHandle(observation.mcpTaskId).scannedCodePoints,
      },
    });
    return { status: "refused", reason };
  }

  // A separate kind from a refusal: a refusal is the peer's malformed handle, a storage failure is
  // a local fault (lock past `busy_timeout`, read-only or full disk, schema drift).
  #reportStorageFailure(
    observation: McpTaskHandleObservation,
    thrown: unknown,
  ): McpTaskHandleRecordOutcome {
    // The `SqliteError` code (`SQLITE_BUSY`, ...) is the diagnosis; `message` is not carried
    // because it interpolates the offending SQL.
    const sqliteCode =
      typeof thrown === "object" &&
      thrown !== null &&
      "code" in thrown &&
      typeof (thrown as { code: unknown }).code === "string"
        ? (thrown as { code: string }).code
        : null;
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "mcp_task_handle_write_failed",
      rawWireType: null,
      dispositionReason: sqliteCode ?? "unknown_storage_error",
      details: {
        commandId: observation.commandId,
        serverName: observation.serverName,
        toolName: observation.toolName,
        // Lets a thrown value that is not a `SqliteError` (a defect here) read as anomalous.
        errorName: thrown instanceof Error ? thrown.constructor.name : typeof thrown,
      },
    });
    return { status: "storage-failed", sqliteCode };
  }
}
