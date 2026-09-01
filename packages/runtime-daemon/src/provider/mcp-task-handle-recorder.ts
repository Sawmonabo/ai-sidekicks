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
// What is live here, and what is not: the dispatch caller is UNOWNED
// ----------------------------------------------------------------------------
//
// Everything in this file is live. The migration ships the column, this class
// is its only writer, and both drivers' `observeMcpTaskAcceptance` seams call
// a real sink rather than the no-op they were born with. What does not exist
// anywhere in the daemon is the CALLER — the code that issues a task-augmented
// MCP call and hands the acceptance response to that seam. This module is
// constructed only by its tests.
//
// That is not an oversight to be fixed by wiring it somewhere. NO PLAN TASK
// OWNS THE DISPATCH CALLER. The three adjacent owners each own something
// deliberately else: Plan-005 T3.13 owns the acceptance-observation seam,
// Plan-005 T5.1 (this task) owns the column and the write, and Plan-015 T15.3
// READS the stored handle to poll `tasks/get` / `tasks/result` in place of the
// halt. Its own task text scopes T5.1 to the migration, the runner
// registration, both `tools.ts` files, and two doc verifications — no wiring
// site appears in it.
//
// There is a live contradiction above this file that a future wiring attempt
// must resolve FIRST rather than paper over: `Spec-028 §Purpose` states that
// the provider CLIs are the MCP clients and "the daemon never joins the MCP
// wire", and its Non-Goals repeat it, while `Spec-005 §Tool Metadata` and
// `Spec-015` require the daemon to see a `CreateTaskResult` at dispatch and
// later poll `tasks/get` — which only a party on that wire can do. The method
// string `tools/call` appears nowhere in the corpus or the code. Wiring a
// caller would be picking a side of that contradiction in code, which is a
// governance decision and not this task's to make.
//
// The state is also not peculiar to this module: RuntimeBindingStore,
// DriverCapabilitiesWriter, CallbackToolHost, and ThreadFrameRouter are every
// other Plan-005 service that takes a `Database`, and not one of them has a
// production construction site either. They are all owed by the same composition
// root `bootstrap/index.ts` says does not exist yet ("no composition root that
// owns one — Phase 2 / Tier 4 bring the listener lifecycle"). That directory is
// additionally single-owner Plan-007, and the dependency map's §2 row enumerates
// the six plans whose wiring calls are sanctioned inside `index.ts`; Plan-005 is
// not among them. Constructing this recorder there would be an unsanctioned edit
// wiring a sink that nothing can call.
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
 * The unit is load-bearing and is the database's, not JavaScript's. SQLite
 * defines it exactly: "For a string value X, the length(X) function returns the
 * number of Unicode code points (not bytes) in input string X prior to the
 * first U+0000 character" (https://www.sqlite.org/lang_corefunc.html#length).
 * `String.prototype.length` counts UTF-16 code units instead, and the two
 * disagree by a factor of two on every astral character — measuring in code
 * units would refuse handles the column accepts (verified: 200 astral
 * characters are `length() = 200` to SQLite and `.length === 400` to
 * JavaScript). {@link scanHandle} is what closes that.
 *
 * Both halves of that sentence are load-bearing here: the "code points" half
 * sets this unit, and the "prior to the first U+0000" half is why the NUL
 * conjunct outranks this bound in {@link classifyMcpTaskIdRefusal} whenever
 * one bounded walk sees both.
 *
 * Mirrors migration `0017-command-receipt-mcp-task-handle.ts` verbatim. If one
 * moves, both move.
 */
export const MCP_TASK_ID_MAX_LENGTH: number = 256;

/**
 * Why a handle was rejected before it reached the database, or why a well-formed
 * handle could not be stored.
 *
 * Three of these mirror the column's CHECK conjuncts one-for-one, so a refusal
 * names which conjunct failed rather than reporting a generic constraint
 * violation. `handle_not_well_formed` has no CHECK counterpart and cannot have
 * one — by the time SQLite sees the value the damage is already done, because
 * the driver encodes it to UTF-8 on the way in and a lone surrogate has no
 * UTF-8 encoding, so it is replaced by one or more U+FFFD (how many is the
 * platform encoder's choice) before any constraint runs. The
 * column would accept the replacement happily; the stored handle would simply
 * no longer be the receiver's, and polling `tasks/get` with it would name a
 * task that does not exist. The last two are storage-state outcomes the CHECK
 * cannot express either.
 */
export type McpTaskHandleRefusalReason =
  | "handle_empty"
  | "handle_too_long"
  | "handle_contains_nul"
  | "handle_not_well_formed"
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
  | { readonly status: "refused"; readonly reason: McpTaskHandleRefusalReason }
  | { readonly status: "storage-failed"; readonly sqliteCode: string | null };

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

/** What one BOUNDED pass of {@link scanHandle} learned about a candidate handle. */
interface HandleScan {
  /**
   * How many Unicode code points the walk consumed before it settled — the
   * unit SQLite's `length()` reports for TEXT, and therefore the unit
   * {@link MCP_TASK_ID_MAX_LENGTH} is in. This is the handle's exact length
   * only when the scan settled clean; a scan that stopped on a defect or at
   * the bound reports where it stopped, never the true size, because
   * measuring the rest of an already-refused untrusted string is exactly the
   * work the bound exists to avoid.
   */
  readonly scannedCodePoints: number;
  /** Whether the walk hit U+0000 — the conjunct SQLite's `length()` cannot see past. */
  readonly hasNul: boolean;
  /**
   * Whether the walk hit a UTF-16 surrogate without its partner. Such a string
   * is not well-formed Unicode and has no UTF-8 encoding, so encoding it on
   * the way to SQLite silently substitutes one or more U+FFFD.
   */
  readonly hasLoneSurrogate: boolean;
  /** Whether the walk consumed more code points than the bound admits. */
  readonly exceededBound: boolean;
}

/**
 * Measure and validate a candidate handle in ONE BOUNDED pass.
 *
 * Written as an index walk rather than `[...value].length` on purpose: the
 * input is untrusted remote-peer output of unbounded size, and spreading it
 * would allocate one array element per code point before the bound that would
 * have rejected it is ever consulted. This allocates nothing.
 *
 * The walk stops at the FIRST terminal fact — a NUL, a lone surrogate, or the
 * code point past {@link MCP_TASK_ID_MAX_LENGTH} — because each of those makes
 * refusal inevitable on its own, and every code unit walked after that point is
 * free work performed on behalf of a peer that has already disqualified
 * itself. A buggy or hostile MCP server returning a multi-megabyte `taskId`
 * therefore costs this daemon at most `MCP_TASK_ID_MAX_LENGTH + 1` code
 * points of scanning, once, and never a full traversal.
 *
 * The well-formedness half is computed HERE rather than by the standard
 * `String.prototype.isWellFormed()`, and that is a toolchain constraint rather
 * than a preference. The method exists on every Node this package supports
 * (`engines.node >= 22.12.0`; the method shipped in Node 20), but this repo
 * pins `"lib": ["es2023"]` in `tsconfig.node22.json` and the method is ES2024 —
 * calling it fails to compile with `TS2550: Property 'isWellFormed' does not
 * exist ... Try changing the 'lib' compiler option to 'es2024' or later`.
 * Widening the repo-wide lib to reach one method would admit every other ES2024
 * surface unreviewed alongside it. Folding the check into a walk that was
 * already happening costs nothing and is strictly better than the standard
 * method would have been here anyway: it is one pass over untrusted input
 * instead of two.
 */
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
      // Compared as a code unit and never via a string literal: a raw U+0000
      // in source is invisible in every editor and diff, and an accidental
      // empty-string search would match everything.
      hasNul = true;
    } else if (isHighSurrogate && index + 1 < value.length) {
      const nextCharCode = value.charCodeAt(index + 1);
      const isPaired = nextCharCode >= 0xdc00 && nextCharCode <= 0xdfff;
      // A well-formed surrogate PAIR is one code point spanning two code
      // units; an unpaired high surrogate is one code point on its own.
      if (isPaired) {
        index += 1;
      } else {
        hasLoneSurrogate = true;
      }
    } else if (isHighSurrogate || isLowSurrogate) {
      // An unpaired trailing high surrogate, or a low surrogate that no high
      // surrogate introduced.
      hasLoneSurrogate = true;
    }
    index += 1;
    scannedCodePoints += 1;
  }
  return {
    scannedCodePoints,
    hasNul,
    hasLoneSurrogate,
    // Strictly-greater is exact: a 256-code-point handle exits the loop by
    // index with the count AT the bound, while a longer one consumes the
    // 257th code point before the loop guard sees the count and stops it.
    exceededBound: scannedCodePoints > MCP_TASK_ID_MAX_LENGTH,
  };
}

/**
 * Check a handle against the column's CHECK conjuncts. Returns `undefined` when
 * the handle is storable.
 *
 * The ordering is deliberate and diverges from the CHECK's own: the refusal
 * names the FIRST terminal fact the bounded walk encountered — a NUL, a lone
 * surrogate, or the bound itself, whichever the walk reached first. That is
 * one rule rather than three ad-hoc ones, it changes only which refusal a
 * multiply-invalid handle reports and never whether it is refused, and it is
 * what lets the walk stop the moment refusal becomes inevitable instead of
 * traversing the rest of an untrusted string to rank its defects.
 *
 * The rule still surfaces the defects the CHECK cannot. SQLite's `length()`
 * stops at the first U+0000, so a 300-code-point handle carrying a NUL at
 * index 5 measures 5 there — the walk reaches that NUL long before the size
 * bound and names it; `instr(..., char(0))` is what sees it in the column,
 * which is also why those two CHECK conjuncts are not redundant. A lone
 * surrogate is worse still, because nothing downstream reports it: the UTF-8
 * encoding substitutes one or more U+FFFD, the CHECK passes, and the row
 * stores a handle the receiver never issued.
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
   * NEVER THROWS. Not for a rejected handle, not for an absent row, and not
   * for a database that refused the write — every one of those is a typed
   * outcome, because the caller is a driver dispatch path whose turn must not
   * fail over a recovery optimization that did not take. Each failure leaves
   * the column NULL and the receipt on the `manual_reconcile_only` halt, which
   * is exactly the state the seam had before this task activated it: the worst
   * case of activation is the status quo ante, never a broken turn.
   *
   * The containment is total by intent, covering a `TypeError` from a defect in
   * this module as readily as a `SqliteError` from a locked or read-only
   * database. Letting a bug here escape would fail a provider turn, which is
   * the one thing the contract forbids; what keeps the bug visible instead is
   * the emitted diagnostic naming the thrown error's constructor, so anything
   * that is not a `SqliteError` reads as anomalous at a glance.
   */
  record(observation: McpTaskHandleObservationRecord): McpTaskHandleRecordOutcome {
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
    } catch (thrown) {
      return this.#reportStorageFailure(observation, thrown);
    }
  }

  /**
   * The recorder as the drivers' `McpTaskHandleSink` — the one-line
   * substitution that activates each observation seam.
   *
   * The outcome is deliberately dropped here rather than thrown: every
   * non-success arm — refusal and storage failure alike — has already been
   * diagnosed by {@link record}, which itself never throws, and the seam's
   * contract is that observing a handle cannot fail a turn.
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
        // A bounded measurement and not the handle. An over-bound handle is
        // unbounded remote-peer output, and the whole point of refusing it is
        // to keep it out of durable surfaces — a log line is one — while
        // re-measuring it exactly would hand the refused peer the full
        // traversal the bounded scan just declined. Reported in the same
        // code-point unit the bound is stated in: the exact length for a
        // clean-scanned handle (`receipt_absent` / `handle_conflict`), the
        // stop position for a representation defect, and the cap
        // `MCP_TASK_ID_MAX_LENGTH + 1` — read it as "at least 257" — for an
        // over-bound one. Re-scanned rather than threaded down from the
        // classifier: this is the rare path, the walk allocates nothing, and
        // three of the six reasons never ran one.
        handleCodePointsScanned: scanHandle(observation.mcpTaskId).scannedCodePoints,
      },
    });
    return { status: "refused", reason };
  }

  /**
   * Diagnose a handle that was storable but could not be stored.
   *
   * A SEPARATE diagnostic kind from a refusal, deliberately. The two differ in
   * the only way that matters to whoever is watching the counter: a refusal is
   * a decision this daemon made about a malformed handle — deterministic, the
   * remote peer's doing, unfixable locally, and re-offering the same handle
   * refuses again. A storage failure is a local fault (a lock held past
   * `busy_timeout`, a read-only or full filesystem, an I/O error, schema drift)
   * that is almost certainly failing writes far beyond this one. Fusing them
   * into one counter would leave an operator unable to tell "a peer sent us
   * garbage" from "our database is read-only" — the difference between ignoring
   * the signal and paging on it.
   *
   * Note what is NOT contained anywhere: the constructor's `database.prepare`
   * calls. Schema drift there throws at wiring time, at the composition root,
   * which is the better failure and matches the `wireTurnSnapshotRetentionSweep`
   * precedent in `bootstrap/index.ts`. Only the per-observation path is
   * contained, because only it runs inside a turn.
   */
  #reportStorageFailure(
    observation: McpTaskHandleObservationRecord,
    thrown: unknown,
  ): McpTaskHandleRecordOutcome {
    // better-sqlite3 raises `SqliteError` carrying a `code` such as
    // `SQLITE_BUSY` / `SQLITE_READONLY` / `SQLITE_IOERR`. That code is the
    // whole diagnosis and is a closed vocabulary; `message` is not carried,
    // because it interpolates the offending SQL and this module cannot promise
    // what a future statement will put there.
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
        // The constructor name, so a thrown value that is NOT a `SqliteError`
        // — which would mean a defect in this module rather than a sick
        // database — is legible instead of being flattened into the same
        // storage-fault bucket.
        errorName: thrown instanceof Error ? thrown.constructor.name : typeof thrown,
      },
    });
    return { status: "storage-failed", sqliteCode };
  }
}
