// Plan-005 T5.1 — the MCP Tasks durable recovery handle's write seam.
//
// T3.13 shipped both drivers' observation halves (`observeMcpTaskAcceptance`)
// bound to a no-op sink, because the column they observe FOR did not exist.
// Migration `0017-command-receipt-mcp-task-handle.ts` lands it; this module is
// the sink that replaces the no-op, and it is the ONLY writer of
// `command_receipts.mcp_task_id` anywhere in the daemon.
//
// Provider-neutral by construction and therefore a `provider/`-level sibling
// rather than a member of `provider/drivers/`: the two drivers differ in how
// they OBSERVE an acceptance and not at all in what a stored handle means. A
// per-driver copy would be two copies of one bound and one SQL statement.
//
// ----------------------------------------------------------------------------
// Why the bound is restated here when the column already CHECKs it
// ----------------------------------------------------------------------------
//
// `MCP_TASK_ID_MAX_LENGTH` is the same 256 the migration's CHECK expresses, and
// the duplication is the point (the T2.1 defense-in-depth convention the
// `runtime_bindings` provider-declared strings follow). The database bound is
// the one no code path can talk its way past; this one exists so a violation
// is REFUSED with a named diagnostic naming the server, the tool, and the
// length, instead of unwinding out of a driver frame as an opaque
// SQLITE_CONSTRAINT with no MCP identity attached to it.
//
// The constant is minted here rather than borrowed from an existing bounded
// wire string. `@ai-sidekicks/contracts` exports several `*_MAX_LEN` values,
// all at other bounds; consuming one would mean this guard and the column's
// CHECK could drift apart the next time that unrelated bound moved, which is
// the exact failure the second bound exists to prevent.
//
// An over-bound handle is REFUSED and never truncated. A truncated handle is
// not a degraded handle — it names a different task or no task, and Spec-015
// recovery would poll `tasks/get` against it and act on the answer. Refusing
// leaves the column NULL, which is the state the recovery path already
// handles: the receipt stays on the `manual_reconcile_only` halt (I-005-3).
// Silent loss is not possible either — every refusal emits a diagnostic.
//
// ----------------------------------------------------------------------------
// Why the UPDATE is conditional on NULL
// ----------------------------------------------------------------------------
//
// `WHERE ... AND mcp_task_id IS NULL` makes the write first-wins rather than
// last-wins. A bare `WHERE command_id = ?` would let a second acceptance
// overwrite a handle already stored, and the handle that gets overwritten is
// the durable poll target for a task that may already be running — losing it
// is exactly the outcome the column exists to prevent. Zero affected rows is
// therefore not a failure but an ambiguity, resolved by one SELECT into three
// distinguishable outcomes: no receipt, the same handle again (an idempotent
// replay, reported as success), or a different handle (refused, diagnosed).

import type { Database, Statement } from "better-sqlite3";

import type { DriverDiagnosticsEmitter, DriverProviderName } from "./driver-diagnostics.js";

/**
 * The maximum stored length of a receiver-generated MCP `taskId`, in Unicode
 * CODE POINTS.
 *
 * The unit is load-bearing and is the database's, not JavaScript's: SQLite's
 * `length()` over TEXT counts characters, while `String.prototype.length`
 * counts UTF-16 code units, and the two disagree by a factor of two on every
 * astral character. Measuring in code units would refuse handles the column
 * accepts — verified: 200 astral characters are `length() = 200` to SQLite and
 * `.length === 400` to JavaScript. {@link countCodePoints} is what closes that.
 *
 * Mirrors migration `0017-command-receipt-mcp-task-handle.ts` verbatim. If one
 * moves, both move.
 */
export const MCP_TASK_ID_MAX_LENGTH: number = 256;

// Written as an escape and named, never as a literal in a string body: a raw
// U+0000 in source is invisible in every editor and diff, so a reader cannot
// tell this guard from one that searches for the empty string — which matches
// everything and would refuse every handle.
const NUL_CODE_UNIT = "\u0000";

/**
 * Why a handle was rejected before it reached the database, or why a well-formed
 * handle could not be stored.
 *
 * The first three mirror the column's CHECK conjuncts one-for-one, so a refusal
 * names which conjunct failed rather than reporting a generic constraint
 * violation. The last two are storage-state outcomes the CHECK cannot express.
 */
export type McpTaskHandleRefusalReason =
  | "handle_empty"
  | "handle_too_long"
  | "handle_contains_nul"
  | "receipt_absent"
  | "handle_conflict";

/**
 * The result of offering one observed handle to the receipt row.
 *
 * `already-recorded` is a SUCCESS arm and not a refusal: an acceptance
 * re-observed with the same handle has nothing to correct, and reporting it as
 * a conflict would make an idempotent replay indistinguishable from a receiver
 * that changed its answer.
 */
export type McpTaskHandleRecordOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "already-recorded" }
  | { readonly status: "refused"; readonly reason: McpTaskHandleRefusalReason };

/**
 * One task-augmented MCP dispatch's acceptance, addressed to the receipt row it
 * belongs to.
 *
 * `commandId` is what makes the observation writable at all — the driver-side
 * `(serverName, toolName)` pair names the MCP identity but no row. It is the
 * client-supplied idempotency key `command_receipts.command_id` holds, carried
 * from the dispatch that opened the receipt.
 */
export interface McpTaskHandleObservationRecord {
  readonly commandId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly mcpTaskId: string;
}

/**
 * Count a string's Unicode code points — the unit SQLite's `length()` reports
 * for TEXT, and therefore the unit {@link MCP_TASK_ID_MAX_LENGTH} is in.
 *
 * Written as an index walk rather than `[...value].length` on purpose: the
 * input is untrusted remote-peer output of unbounded size, and spreading it
 * would allocate one array element per code point before the bound that would
 * have rejected it is ever consulted. This allocates nothing.
 */
function countCodePoints(value: string): number {
  let codePointCount = 0;
  let index = 0;
  while (index < value.length) {
    const charCode = value.charCodeAt(index);
    const isHighSurrogate = charCode >= 0xd800 && charCode <= 0xdbff;
    if (isHighSurrogate && index + 1 < value.length) {
      const nextCharCode = value.charCodeAt(index + 1);
      const isLowSurrogate = nextCharCode >= 0xdc00 && nextCharCode <= 0xdfff;
      // A well-formed surrogate PAIR is one code point; a lone surrogate is
      // one on its own, which is also how it survives the UTF-8 encoding
      // SQLite measures (as a single replacement character).
      index += isLowSurrogate ? 2 : 1;
    } else {
      index += 1;
    }
    codePointCount += 1;
  }
  return codePointCount;
}

/**
 * Check a handle against the column's CHECK conjuncts. Returns `undefined` when
 * the handle is storable.
 *
 * The NUL conjunct is evaluated SECOND rather than in the CHECK's own order.
 * That divergence changes only which refusal a doubly-invalid handle reports,
 * never whether it is refused, and it buys a more truthful reason: SQLite's
 * `length()` STOPS at an embedded NUL, so a 300-code-point handle carrying a
 * NUL at index 5 measures 5, and classifying it by length first would call it
 * well-sized when the real defect is the NUL. `instr(..., char(0))` is what
 * actually sees it — in the column and here alike, which is also why the two
 * conjuncts are not redundant with each other.
 *
 * Exported so the bound is testable without a database, and so a caller that
 * wants to classify before dispatching can, but the recorder always re-runs it:
 * this is a guard, never an optional pre-flight.
 */
export function classifyMcpTaskIdRefusal(
  mcpTaskId: string,
): McpTaskHandleRefusalReason | undefined {
  if (mcpTaskId.length === 0) {
    return "handle_empty";
  }
  if (mcpTaskId.includes(NUL_CODE_UNIT)) {
    return "handle_contains_nul";
  }
  if (countCodePoints(mcpTaskId) > MCP_TASK_ID_MAX_LENGTH) {
    return "handle_too_long";
  }
  return undefined;
}

interface StoredHandleRow {
  readonly mcp_task_id: string | null;
}

/**
 * The sole writer of `command_receipts.mcp_task_id`.
 *
 * One instance per driver binding, because the diagnostics it emits are
 * provider-attributed; the SQL and the bound are provider-neutral.
 */
export class McpTaskHandleRecorder {
  readonly #provider: DriverProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #claimHandleStatement: Statement<[string, string]>;
  readonly #readStoredHandleStatement: Statement<[string]>;

  constructor(
    database: Database,
    options: {
      readonly provider: DriverProviderName;
      readonly diagnostics: DriverDiagnosticsEmitter;
    },
  ) {
    this.#provider = options.provider;
    // The emitter is a REQUIRED dependency, not an optional one. An optional
    // diagnostic channel can be absent, and a refusal nobody is told about is
    // indistinguishable from the handle never having been offered.
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
   * Offer one observed handle to its receipt row.
   *
   * Never throws for a rejected handle or an unwritable row — both are typed
   * outcomes, because the caller is a driver dispatch path whose turn must not
   * fail over a recovery optimization that did not take. A refusal leaves the
   * column NULL and the receipt on the `manual_reconcile_only` halt, which is
   * the same state the seam had before this task activated it.
   */
  record(observation: McpTaskHandleObservationRecord): McpTaskHandleRecordOutcome {
    const boundsRefusal = classifyMcpTaskIdRefusal(observation.mcpTaskId);
    if (boundsRefusal !== undefined) {
      return this.#refuse(observation, boundsRefusal);
    }

    const claimResult = this.#claimHandleStatement.run(
      observation.mcpTaskId,
      observation.commandId,
    );
    if (claimResult.changes > 0) {
      return { status: "recorded" };
    }

    // Zero rows changed means the row is absent, or it already carries a
    // handle. Reading it back is what tells those apart — and reading it back
    // is safe under concurrency in the direction that matters: `mcp_task_id`
    // only ever transitions NULL → non-NULL (nothing clears it), so a value
    // observed here cannot later revert and make this answer wrong.
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
  }

  /**
   * The recorder as the drivers' `McpTaskHandleSink` — the one-line
   * substitution that activates each observation seam.
   *
   * The outcome is deliberately dropped here rather than thrown: every refusal
   * has already been diagnosed by {@link record}, and the seam's contract is
   * that observing a handle cannot fail a turn.
   */
  asSink(): (observation: McpTaskHandleObservationRecord) => void {
    return (observation: McpTaskHandleObservationRecord): void => {
      this.record(observation);
    };
  }

  #refuse(
    observation: McpTaskHandleObservationRecord,
    reason: McpTaskHandleRefusalReason,
  ): McpTaskHandleRecordOutcome {
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "mcp_task_handle_write_refused",
      // Not caused by a single normalized wire frame: the acceptance is a
      // JSON-RPC response to a call this daemon made, and carries no wire-type
      // discriminant to name.
      rawWireType: null,
      dispositionReason: reason,
      details: {
        commandId: observation.commandId,
        serverName: observation.serverName,
        toolName: observation.toolName,
        // The length and not the handle. An over-bound handle is unbounded
        // remote-peer output, and the whole point of refusing it is to keep it
        // out of durable surfaces — a log line is one. Reported in the same
        // code-point unit the bound is stated in, so an operator comparing it
        // against 256 is comparing like with like.
        handleLength: countCodePoints(observation.mcpTaskId),
      },
    });
    return { status: "refused", reason };
  }
}
