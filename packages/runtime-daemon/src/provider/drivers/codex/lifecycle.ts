// Codex driver — app-server transport + the five lifecycle operations (Plan-005
// Phase 3, T3.1).
//
// This module owns TWO layers that deliberately live in one file:
//   1. `CodexAppServerConnection` — the JSONL/JSON-RPC transport over a single
//      `PtyHost` session (framing, request correlation, deadlines, teardown).
//   2. `CodexLifecycleManager` — the five lifecycle operations expressed in
//      Codex `app-server` method calls (`createSession`, `resumeSession`,
//      `startRun`, `interruptRun`, `closeSession`).
//
// They are NOT split behind a transport port. The transport is not swappable at
// this task (T3.15 leg 6 introduces `DriverTransportConfig` selection), and the
// unit tests drive the REAL framing code through a fake `PtyHost` — a port would
// let the framing go untested behind a stub, which is the failure mode that
// matters here (see the MAX_CANON note below for why framing is load-bearing).
//
// ---------------------------------------------------------------------------
// The termios prelude — why the spawn command is `/bin/sh -c`, not the binary
// ---------------------------------------------------------------------------
//
// The substrate this driver is required to consume is `PtyHost` (Plan-024), and
// a PTY slave starts in CANONICAL mode with ECHO on. `codex app-server` is not a
// TUI and never calls `tcsetattr`, so nothing turns them off. Both defaults are
// fatal to a line-delimited protocol:
//
//   * MAX_CANON — in canonical mode the line discipline caps a single input line
//     (Darwin: 1024 bytes). A longer line is DISCARDED SILENTLY: no error, no
//     short read, no response, ever. Measured against `codex-cli 0.149.1` on
//     Darwin 25.6.0: a 1015-byte frame is answered, a 1045-byte frame is not, and
//     nothing above it ever is. Splitting one frame across several small writes
//     does NOT evade the cap (the limit is per line, not per write) and in
//     practice performs strictly worse. Any real `turn/start` exceeds 1024 bytes,
//     so an unconfigured PTY cannot carry this protocol at all.
//   * ECHO — written frames are echoed back on the read side, so the reader sees
//     its own requests interleaved with server output.
//
// Both are removed by configuring the tty before the server starts. The prelude
// runs `stty` on the pty slave (its own stdin), announces readiness, and then
// `exec`s the provider binary so the shell is REPLACED — the child that `PtyHost`
// signals and reaps is the provider itself, with no shell left in the tree.
//
// Three properties of the command string are load-bearing:
//   * `&&`, not `;` — if `stty` fails, the prelude aborts and the sentinel never
//     arrives, so the caller gets a typed startup failure. With `;` the server
//     would start in canonical mode and silently swallow every large frame,
//     which is a far worse failure than refusing to start.
//   * the sentinel — writing before the prelude has run would race it, and those
//     early writes ARE echoed (verified). Waiting for the sentinel closes the
//     race deterministically rather than tolerating it. The echo filter below is
//     retained anyway as defense in depth, not as the primary mechanism.
//   * the binary path travels in the ENV ARRAY (`CODEX_APP_SERVER_BIN`), never
//     interpolated into the shell string — so a path can never become shell
//     syntax, and the "env is exactly what the caller supplied" property holds.
//
// POSIX-only. ADR-019 puts Windows on a Rust PTY sidecar; that platform needs an
// equivalent termios step (or a non-PTY transport) before this driver runs there.
// That is a T3.15 leg-6 concern, not a silent assumption of this module.
//
// ---------------------------------------------------------------------------
// I-005-5 — resume failure NEVER becomes a new session
// ---------------------------------------------------------------------------
//
// `resumeSession` catches every failure of the resume path and converts it into
// the typed `{ status: 'failed', recoveryCondition: 'recovery-needed', ... }`
// result. It contains NO call to `createSession`, no `thread/start` write, and no
// fallback that could manufacture a fresh thread. Escalation is the daemon's
// decision, made on an explicit condition — never the driver's, made silently.
//
// The typed result is produced through `DriverResumeResultSchema.parse`, so the
// shape is mechanically enforced rather than asserted. That parse is preceded by
// `normalizeProviderFailureDetail`, because the schema's `wireFreeFormString`
// REJECTS empty, whitespace-only, NUL-bearing, and overlength strings — a
// provider error with a blank message would otherwise turn the typed failure back
// into a thrown exception, which is exactly the loss this invariant forbids.
//
// ---------------------------------------------------------------------------
// The session slot — one process per session, held across every transition
// ---------------------------------------------------------------------------
//
// Every operation that can spawn or dispose a provider process runs inside a
// claimed SLOT for its session id. A slot is EMPTY, or held as `establishing`,
// `live`, or `closing`, and it is held from the first synchronous instant of a
// transition until that transition has fully settled — never merely across the
// step that mutates the record.
//
// That last clause is the whole design, and it is stated in the negative because
// every failure in this class has had the same shape: a guard that was correct
// about the MAP and silent about the WINDOW. Three of them shipped and were
// caught in review:
//
//   * a create that tested only `#sessions`, so two overlapping creates both
//     passed the guard, both spawned, and the later install orphaned the earlier
//     process;
//   * a claim that waited for the slot to go ABSENT and then took it, so two
//     waiters released by the same settlement both found it free;
//   * a close that deleted the record and THEN awaited an unsubscribe and a
//     process close, so for the length of that teardown the slot read as empty
//     while the child was still exiting, and a create could spawn beside it.
//
// The invariant that rules out the whole class, rather than these three
// instances: NO PROCESS THIS MANAGER OWNS EXISTS WITHOUT A HELD SLOT. Applied to
// each site — a create holds `establishing` across spawn, handshake, and install;
// a resume holds it across those plus the predecessor release; a close holds
// `closing` across the unsubscribe, the process close, and the record delete; and
// `startRun` disposing an ambiguous session claims `closing` for the kill. A
// `startRun` that merely INSTALLS a route holds no slot, so it re-reads the slot
// after its await and refuses if the record it started under is no longer the
// settled holder.
//
// `#claimSessionSlot` is the only way a slot is ever taken, in either direction.
// A second mechanism would be a second definition of "taken", and the two would
// disagree exactly once.
//
// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------
//
// Only codes already registered in `docs/architecture/contracts/error-contracts.md §Driver` are used:
// `driver.unavailable` (503) for transport/process failures and `driver.timeout`
// (504) for a deadline. Provider-reported request errors and malformed driver
// config carry NO dotted code by design — classifying provider failures beyond
// transport errors is T3.14/T3.22's leg, and minting a code here would add an
// unregistered row to that census.
//
// Spec coverage: `Spec-005 §Required Behavior` (the normalized driver contract's
// lifecycle surface); `Spec-005 §Fallback Behavior` (a failed resume handle
// surfaces a recovery-needed condition — AC3).
//
// Refs: Plan-005 §Phase 3 / T3.1, `Spec-005 §Required Behavior`,
// `Spec-005 §Fallback Behavior`, invariant I-005-5, ADR-011, ADR-019,
// `docs/reference/provider-wire/codex.md` (pinned `codex-cli 0.149.1`),
// `docs/architecture/contracts/error-contracts.md §Driver`.

import { randomUUID } from "node:crypto";

import {
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DriverResumeResultSchema,
  SessionIdSchema,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverResumeResult,
  type InterruptRunParams,
  type ProviderSessionHandle,
  type PtyHost,
  type ResumeSessionParams,
  type RunId,
  type SessionId,
  type SpawnRequest,
  type StartRunParams,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Transport constants
// --------------------------------------------------------------------------

/** Env var carrying the provider binary path into the prelude (never interpolated). */
export const CODEX_APP_SERVER_BIN_ENV_VAR: string = "CODEX_APP_SERVER_BIN";

/** Line the prelude emits once the tty is configured and before `exec`. */
export const CODEX_APP_SERVER_READY_SENTINEL: string = "__codex_app_server_ready__";

/** See the termios-prelude note in this file's header for every clause's rationale. */
export const CODEX_APP_SERVER_SHELL_PRELUDE: string =
  `stty -icanon -echo` +
  ` && printf '%s\\n' ${CODEX_APP_SERVER_READY_SENTINEL}` +
  ` && exec "$${CODEX_APP_SERVER_BIN_ENV_VAR}" app-server`;

/** Default provider binary; overridable so a node-pinned path can be supplied. */
export const CODEX_DEFAULT_EXECUTABLE_PATH: string = "codex";

/**
 * Hard ceiling on a single unterminated inbound line, in UTF-16 code units.
 *
 * The read buffer is fed from a sink the PROVIDER controls, and a newline is the
 * only thing that ever drains it. Without a ceiling, any peer that never emits
 * one grows the buffer until the daemon dies — and the least-guarded window is
 * before the prelude sentinel, where a refused `stty` leaves shell diagnostics
 * accumulating against a tty nobody configured. That is a liveness hazard for
 * the whole node, not merely for one session (`Spec-005 §Pitfalls To Avoid`).
 *
 * The unit is code units rather than bytes ON PURPOSE. Measuring UTF-8 bytes of
 * the retained tail means re-scanning the whole tail on every chunk, which is
 * quadratic in exactly the case the ceiling exists to survive. A code unit costs
 * a fixed two bytes of retained memory whatever it encodes, so this bound is a
 * direct bound on the hazard; and since a UTF-8 encoding is never SHORTER than
 * the code-unit count, a line that trips this ceiling has always exceeded the
 * same figure in bytes too.
 */
export const CODEX_MAX_LINE_LENGTH: number = 32 * 1024 * 1024;

/**
 * The ten server-initiated REQUEST methods of the pinned protocol, read from the
 * generated `ServerRequest` union at `codex-cli 0.149.1` (regenerate, never
 * transcribe — `docs/reference/provider-wire/codex.md`; re-verified against the
 * installed binary's own generation on 2026-08-27).
 *
 * An OBSERVABILITY ANNOTATION, deliberately NOT a routing filter. Routing keys on
 * correlation instead (`#isEchoOfOurOwnRequest`), because a census is a snapshot
 * of one pinned release and the wire is additive across releases: gating the
 * fail-closed answer on membership here would leave a request method added by a
 * newer admitted build unanswered, hanging that turn forever. Membership rides
 * the `unhandled-server-request` diagnostic as `censused` instead, so an
 * uncensused method is loud without being treated as unanswerable.
 *
 * Module-private: a shared export of this set belongs with the event normalizer
 * (T3.5), not with the transport.
 */
const CODEX_SERVER_REQUEST_METHODS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
]);

/** JSON-RPC "method not found" — the fail-closed answer to an unhandled server request. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The provider's ONLY terminal-turn notification.
 *
 * Read from the generated `ServerNotification` union at `codex-cli 0.149.1`
 * (regenerated 2026-08-27): the `turn/*` family is exactly `turn/started`,
 * `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, and
 * `turn/moderationMetadata`. There is no `turn/failed` and no `turn/interrupted`
 * — a failed or interrupted turn arrives on THIS method and is discriminated by
 * `turn.status`, so a terminal set keyed on method strings would be wrong.
 */
const CODEX_TURN_COMPLETED_NOTIFICATION = "turn/completed";

/**
 * The `TurnStatus` values that end a turn.
 *
 * The generated enum is `completed | interrupted | failed | inProgress`.
 * `inProgress` is excluded ON PURPOSE rather than by oversight: the notification
 * carries the whole `Turn`, and treating a non-terminal status as terminal would
 * retire a route while the provider is still running the turn — a steer or
 * interrupt would then be refused as "no active turn" mid-flight. Fail closed by
 * keeping the route.
 */
const CODEX_TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
]);

/**
 * How many unmatched terminal turn ids one session remembers (see `startRun`).
 *
 * Small and fixed: the memory exists to survive a same-chunk response/completion
 * interleave, whose window is one microtask, plus the ordinary post-interrupt
 * duplicate. Anything that accumulates beyond a handful is a provider emitting
 * terminals for turns this driver never started, which is exactly the case an
 * unbounded set must not turn into a leak.
 */
const CODEX_TERMINATED_TURN_MEMORY = 64;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * `turn/start` gets its own knob. It is believed to return as soon as the turn is
 * ACCEPTED (`TurnStatus` includes `inProgress`, and `turn/steer` requires an
 * already-active turn), so the default matches the ordinary request deadline. It
 * is separate so that if that reading is ever wrong the fix is a configuration
 * change rather than a code change.
 */
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/**
 * Deadline for the courtesy `thread/unsubscribe` that precedes teardown.
 *
 * Deliberately NOT the ordinary request deadline. The process is going away
 * regardless, so this call buys tidiness, not correctness -- and inheriting the
 * 60s default means a wedged provider holds `closeSession` (and any shutdown
 * drain waiting on it) for a minute to no purpose. Seconds are enough for a
 * responsive peer; an unresponsive one is exactly the peer not worth waiting on.
 */
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

const DEFAULT_PTY_ROWS = 24;
const DEFAULT_PTY_COLS = 120;

/** Substituted when a provider failure carries no usable message (see I-005-5 note). */
const UNSPECIFIED_PROVIDER_FAILURE_DETAIL =
  "Codex app-server reported a failure with no diagnostic message.";

// --------------------------------------------------------------------------
// Typed errors
// --------------------------------------------------------------------------

/**
 * Transport or process-level failure. Mirrors the house convention (a stable
 * `code` literal plus leak-safe structured `fields`) used by
 * `provider-registry.ts` and `provider-output-validation.ts`.
 */
export class CodexTransportError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexTransportError";
    this.fields = fields;
  }
}

/**
 * A single inbound line exceeded `CODEX_MAX_LINE_LENGTH` before terminating.
 *
 * A SUBCLASS rather than a peer: the condition is a transport death, so it
 * inherits the already-registered `driver.unavailable` code and mints no new
 * error-contract row, while staying independently catchable by the diagnostics
 * and classification legs that come later.
 *
 * Framing is unrecoverable once this fires. The retained tail is a fragment of a
 * frame whose remainder is now unbounded, so it can never complete validly, and
 * every subsequent byte on the connection is offset against a boundary the
 * driver can no longer locate. The connection is torn down rather than resynced.
 */
export class CodexLineTooLongError extends CodexTransportError {
  constructor(retainedLength: number, limit: number) {
    super(
      `The Codex app-server sent ${retainedLength} characters with no line terminator, ` +
        `exceeding the ${limit}-character framing limit.`,
      { retainedLength: String(retainedLength), limit: String(limit) },
    );
    this.name = "CodexLineTooLongError";
  }
}

/** A request outlived its deadline. Registered as `driver.timeout` (504). */
export class CodexRequestTimeoutError extends Error {
  readonly code = "driver.timeout" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexRequestTimeoutError";
    this.fields = fields;
  }
}

/**
 * The provider answered a request with a JSON-RPC error.
 *
 * Deliberately carries NO dotted `code`: mapping provider-reported failures onto
 * the daemon's typed vocabulary is T3.14/T3.22's classification leg, and this
 * task must not mint an unregistered error-contract row. The provider's own
 * numeric code, message, and `data` member are preserved so that leg has
 * something to classify.
 *
 * `providerErrorData` is carried VERBATIM and is deliberately typed `unknown`:
 * the JSON-RPC `error.data` member is where the pinned provider puts its
 * structured refusal detail (steer, revert, and thread-usage refusals all
 * answer with it), and dropping it here is irreversible — no later task can
 * recover a member the transport never kept. Parsing or narrowing it is the
 * classification leg's decision, not this one's, so nothing is read off it.
 * This restores the symmetry the notification path already has, which hands
 * `params` on whole.
 */
export class CodexProviderRequestError extends Error {
  readonly providerErrorCode: number;
  readonly method: string;
  readonly providerErrorData: unknown;

  constructor(
    method: string,
    providerErrorCode: number,
    providerMessage: string,
    providerErrorData: unknown = undefined,
  ) {
    super(`Codex app-server rejected "${method}": ${providerMessage}`);
    this.name = "CodexProviderRequestError";
    this.providerErrorCode = providerErrorCode;
    this.method = method;
    this.providerErrorData = providerErrorData;
  }
}

/**
 * What holds a session slot.
 *
 * A slot is EMPTY (absent from every view) or held in exactly one of these
 * states, and it stays held across every async step of the transition that owns
 * it — spawn, handshake, supersede, and teardown alike. `establishing` and
 * `closing` are TRANSITION states, published synchronously by the manager's slot
 * claim; `live` is the settled state of an installed record.
 *
 * The distinction is what a refusal can SAY, not how the slot behaves: a create
 * is refused identically in all three, because in all three a second spawn would
 * orphan a process this manager still owns.
 */
export type CodexSessionSlotState = "live" | "establishing" | "closing";

function describeSlotRefusal(sessionId: string, holderState: CodexSessionSlotState): string {
  switch (holderState) {
    case "live":
      return `A live Codex session is already bound to "${sessionId}"; create would orphan it.`;
    case "establishing":
      return `A create or resume for Codex session "${sessionId}" is already in flight; create would orphan whichever process loses.`;
    case "closing":
      return `Codex session "${sessionId}" is still being torn down; create would spawn a replacement beside a process that is still exiting.`;
  }
}

/**
 * `createSession` was called for a session that already has a live process.
 *
 * Codeless, like the config error below: this is a caller-sequencing defect, not
 * a provider condition, and this task must not mint an error-contract row.
 *
 * Mirrors the Claude leg's `session_already_live` refusal. The alternative --
 * replacing the record -- has no legitimate caller: the superseded child would
 * keep running with nothing routing to it, and `closeSession` would then dispose
 * only the replacement, so the orphan would outlive the session that spawned it.
 * Resume is where a session legitimately re-spawns, and `resumeSession` releases
 * the superseded leg explicitly.
 */
export class CodexSessionAlreadyLiveError extends Error {
  readonly sessionId: string;
  /**
   * Which holder refused the create. Discriminated by CLASS-LOCAL state rather
   * than by a second dotted code: the error-contract registry is closed, and
   * all three arms are the same refusal — a create that would orphan a process —
   * differing only in where that process is in its lifecycle.
   */
  readonly holderState: CodexSessionSlotState;

  constructor(sessionId: string, holderState: CodexSessionSlotState) {
    super(describeSlotRefusal(sessionId, holderState));
    this.name = "CodexSessionAlreadyLiveError";
    this.sessionId = sessionId;
    this.holderState = holderState;
  }
}

/**
 * The daemon-supplied config bag did not carry the shape this driver requires.
 *
 * Codeless for the same reason as above, and because this is a caller/wiring
 * defect rather than a provider condition.
 */
export class CodexDriverConfigError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "CodexDriverConfigError";
    this.field = field;
  }
}

// --------------------------------------------------------------------------
// Injected ports
// --------------------------------------------------------------------------

/** Per-session view of the two process-wide `PtyHost` sinks. */
export interface CodexPtySessionListeners {
  onData(chunk: Uint8Array): void;
  onExit(exitCode: number, signalCode?: number): void;
}

/**
 * Subscribes to ONE pty session's data/exit stream; returns an unsubscribe.
 *
 * `PtyHost.onData` / `PtyHost.onExit` are PROCESS-WIDE sinks on the host object,
 * so a driver that installed its own would evict every other consumer of the same
 * host. Demultiplexing by session id is therefore the composition root's job, and
 * this port is how the driver consumes it.
 */
export type CodexPtySessionSubscriber = (
  ptySessionId: string,
  listeners: CodexPtySessionListeners,
) => () => void;

/** Cancellable timeout scheduler. Injected so tests never wait on real time. */
export type CodexScheduleTimeout = (callback: () => void, delayMs: number) => () => void;

/**
 * Everything the transport observed but could not route.
 *
 * A closed union rather than a log line, so nothing is silently dropped and a
 * consumer can branch on cause. `unconsumed-server-notification` is the seam the
 * event normalizer (T3.5) mounts on: supply `onServerNotification` and the
 * provider event stream stops arriving here.
 */
export type CodexTransportDiagnostic =
  | { kind: "unparsable-line"; line: string }
  | { kind: "line-too-long"; retainedLength: number; limit: number }
  | { kind: "unknown-response-id"; responseId: string }
  | { kind: "echoed-client-frame"; method: string }
  | { kind: "unhandled-server-request"; method: string; censused: boolean }
  | { kind: "notification-write-failed"; method: string }
  | { kind: "unconsumed-server-notification"; method: string }
  | { kind: "process-exited"; exitCode: number; signalCode: number | null };

/** Required — a no-op default would reintroduce silent drops. */
export type CodexDiagnosticSink = (diagnostic: CodexTransportDiagnostic) => void;

/** Server-initiated notification sink (the provider event stream). */
export type CodexServerNotificationSink = (method: string, params: unknown) => void;

// --------------------------------------------------------------------------
// Driver-declared config read-shapes
// --------------------------------------------------------------------------

/**
 * What this driver requires inside `CreateSessionParams.config`.
 *
 * The contract types that bag as `Record<string, unknown>` and no corpus document
 * fixes its members, so the driver declares the shape it needs and parses it
 * fail-closed rather than guessing at call time. `env` is the COMPLETE child
 * environment: this module never reads `process.env`, so a variable absent here
 * is absent from the child.
 */
export interface CodexSessionConfig {
  cwd: string;
  env: ReadonlyArray<readonly [string, string]>;
}

/**
 * What this driver requires inside `StartRunParams.agentConfig`.
 *
 * `StartRunParams` carries no session key and no turn text, so both travel here.
 * `conversationHistory` is NOT read as the turn input — it is prior-transcript
 * material for the ADR-029 replay leg (T3.19-T3.22), not the new message.
 */
export interface CodexRunConfig {
  sessionId: SessionId;
  input: string;
  model?: string | undefined;
  clientUserMessageId?: string | undefined;
}

/**
 * The one place this module decides what "an object" means on a parse path.
 *
 * A value that passes indexes directly, so no use site re-states with a cast
 * what the guard has already proved (the `runtime-binding-store.ts` idiom).
 * Arrays are excluded: `typeof [] === "object"`, and every caller here means a
 * keyed record, so admitting an array would let `[]["thread"]` read `undefined`
 * and turn a malformed frame into a merely-absent field.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new CodexDriverConfigError(`${label} must be an object.`, label);
  }
  return value;
}

function readRequiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string.`, label);
  }
  return value;
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string when present.`, label);
  }
  return value;
}

/** Fail-closed parse of `CreateSessionParams.config`. */
export function parseCodexSessionConfig(config: unknown): CodexSessionConfig {
  const source = readRecord(config, "CreateSessionParams.config");
  const cwd = readRequiredString(source, "cwd", "CreateSessionParams.config.cwd");
  const rawEnv = source["env"];
  if (!Array.isArray(rawEnv)) {
    throw new CodexDriverConfigError(
      "CreateSessionParams.config.env must be an array of [name, value] pairs.",
      "CreateSessionParams.config.env",
    );
  }
  const env = rawEnv.map((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entry[0].length === 0
    ) {
      throw new CodexDriverConfigError(
        `CreateSessionParams.config.env[${index}] must be a [name, value] string pair.`,
        "CreateSessionParams.config.env",
      );
    }
    return [entry[0], entry[1]] as const;
  });
  return { cwd, env };
}

/** Fail-closed parse of `StartRunParams.agentConfig`. */
export function parseCodexRunConfig(agentConfig: unknown): CodexRunConfig {
  const source = readRecord(agentConfig, "StartRunParams.agentConfig");
  // Earned, not asserted. `SessionId` is a branded UUID, and a cast here would
  // have let any non-empty string wear the brand into the session map, where the
  // mismatch surfaces as a puzzling "no live session" instead of a parse
  // refusal. The Zod failure is re-thrown as this module's typed config error so
  // the caller still sees one failure class from this function.
  const rawSessionId = readRequiredString(
    source,
    "sessionId",
    "StartRunParams.agentConfig.sessionId",
  );
  let sessionId: SessionId;
  try {
    sessionId = SessionIdSchema.parse(rawSessionId);
  } catch {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.sessionId must be a session id.",
      "StartRunParams.agentConfig.sessionId",
    );
  }
  const input = readRequiredString(source, "input", "StartRunParams.agentConfig.input");
  const model = readOptionalString(source, "model", "StartRunParams.agentConfig.model");
  const clientUserMessageId = readOptionalString(
    source,
    "clientUserMessageId",
    "StartRunParams.agentConfig.clientUserMessageId",
  );
  return {
    sessionId,
    input,
    ...(model === undefined ? {} : { model }),
    ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
  };
}

/**
 * Makes any caught value safe for `DriverResumeResult.providerFailureDetail`.
 *
 * The schema's `wireFreeFormString` rejects empty, whitespace-only, NUL-bearing,
 * and overlength strings. Without this the typed `recovery-needed` result would
 * THROW on a provider error whose message is blank or enormous — converting the
 * invariant's typed failure back into an exception. Exported for direct test.
 */
export function normalizeProviderFailureDetail(cause: unknown): string {
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : cause === undefined || cause === null
          ? ""
          : String(cause);
  const withoutNul = raw.replaceAll("\0", "");
  const trimmed = withoutNul.trim();
  if (trimmed.length === 0) {
    return UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
  }
  return trimmed.length > DRIVER_FAILURE_DETAIL_MAX_LEN
    ? trimmed.slice(0, DRIVER_FAILURE_DETAIL_MAX_LEN)
    : trimmed;
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

const defaultScheduleTimeout: CodexScheduleTimeout = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancelDeadline: () => void;
}

/** Construction inputs shared by the connection and the manager. */
export interface CodexConnectionOptions {
  readonly ptyHost: PtyHost;
  readonly subscribeToPtySession: CodexPtySessionSubscriber;
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly executablePath?: string | undefined;
  readonly scheduleTimeout?: CodexScheduleTimeout | undefined;
  readonly onServerNotification?: CodexServerNotificationSink | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly turnStartTimeoutMs?: number | undefined;
  readonly rows?: number | undefined;
  readonly cols?: number | undefined;
}

/**
 * One `codex app-server` process reached over one `PtyHost` session.
 *
 * Owns framing (newline-delimited JSON, CR-tolerant), request correlation with
 * per-request deadlines, the fail-closed answer to unhandled server requests, and
 * teardown that leaves no promise pending.
 */
export class CodexAppServerConnection {
  readonly #ptyHost: PtyHost;
  readonly #subscribeToPtySession: CodexPtySessionSubscriber;
  readonly #reportDiagnostic: CodexDiagnosticSink;
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #onServerNotification: CodexServerNotificationSink | undefined;
  readonly #executablePath: string;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #rows: number;
  readonly #cols: number;

  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder = new TextDecoder("utf-8");
  readonly #encoder = new TextEncoder();

  #ptySessionId: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #readBuffer = "";
  #nextRequestId = 1;
  #sawReadySentinel = false;
  #onReady: (() => void) | null = null;
  #onReadyFailed: ((error: Error) => void) | null = null;
  #closed = false;
  #ptyClosed = false;
  #exitDescription: string | null = null;

  constructor(options: CodexConnectionOptions) {
    this.#ptyHost = options.ptyHost;
    this.#subscribeToPtySession = options.subscribeToPtySession;
    this.#reportDiagnostic = options.reportDiagnostic;
    this.#scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    this.#onServerNotification = options.onServerNotification;
    this.#executablePath = options.executablePath ?? CODEX_DEFAULT_EXECUTABLE_PATH;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#rows = options.rows ?? DEFAULT_PTY_ROWS;
    this.#cols = options.cols ?? DEFAULT_PTY_COLS;
  }

  /** The pty session id, once spawned. Exposed for teardown bookkeeping and tests. */
  get ptySessionId(): string | null {
    return this.#ptySessionId;
  }

  /** True once `close()` ran or the child exited. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Spawns the process, waits for the termios prelude's sentinel, then performs
   * the `initialize` / `initialized` handshake.
   *
   * Any failure after a successful spawn tears the process down before
   * rethrowing, so a half-open connection never leaks a child process.
   */
  async open(config: CodexSessionConfig): Promise<void> {
    const spawnRequest: SpawnRequest = {
      kind: "spawn_request",
      command: "/bin/sh",
      args: ["-c", CODEX_APP_SERVER_SHELL_PRELUDE],
      // Exactly the caller-supplied pairs plus the binary path the prelude reads.
      // `process.env` is never consulted (asserted by test).
      env: [
        ...config.env.map((pair) => [pair[0], pair[1]] as [string, string]),
        [CODEX_APP_SERVER_BIN_ENV_VAR, this.#executablePath] as [string, string],
      ],
      cwd: config.cwd,
      rows: this.#rows,
      cols: this.#cols,
    };

    const response = await this.#ptyHost.spawn(spawnRequest);
    if (response.error !== undefined && response.error.length > 0) {
      throw new CodexTransportError("Failed to spawn the Codex app-server process.", {
        ptyError: response.error,
      });
    }
    if (response.session_id.length === 0) {
      throw new CodexTransportError(
        "PtyHost returned an empty session id for the Codex app-server spawn.",
      );
    }
    this.#ptySessionId = response.session_id;

    try {
      // Inside the guard, not before it. The subscriber is caller-supplied code
      // and can throw; outside, a throw would leave a spawned child running with
      // nothing reading it and nothing owning its teardown, which is exactly the
      // leak this method's contract says never happens.
      this.#unsubscribe = this.#subscribeToPtySession(response.session_id, {
        onData: (chunk) => {
          this.#ingest(chunk);
        },
        onExit: (exitCode, signalCode) => {
          this.#handleExit(exitCode, signalCode ?? null);
        },
      });
      await this.#awaitReadySentinel();
      await this.request(
        "initialize",
        {
          clientInfo: { name: "codex-driver", title: "AI Sidekicks", version: "1" },
          // Defense in depth, mirroring the wire reference: experimental surfaces
          // are opt-in and attestation requests are declined outright.
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        this.#startupTimeoutMs,
      );
      this.notify("initialized", {});
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  /** Sends a request and resolves with its `result`, or rejects with a typed error. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.#assertWritable(method);
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = String(requestId);
    const deadlineMs = timeoutMs ?? this.#requestTimeoutMs;

    const settled = new Promise<unknown>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#pending.delete(key);
        reject(
          new CodexRequestTimeoutError(
            `Codex app-server did not answer "${method}" within ${deadlineMs}ms.`,
            { method, timeoutMs: String(deadlineMs) },
          ),
        );
      }, deadlineMs);
      this.#pending.set(key, { method, resolve, reject, cancelDeadline });
    });
    // `reject` is reachable from `#pending` the moment the executor returns, but
    // this function then SUSPENDS on the write below before `return settled`
    // gives the caller a handler. A child exit during that window rejects a
    // promise nobody is attached to, and Node's default
    // `--unhandled-rejections=throw` turns that into a dead daemon. Worse, if
    // the write then rejects too, the catch finds `#pending` already emptied and
    // rethrows, so `return settled` never runs and the rejection is permanently
    // unhandled.
    //
    // Attaching a no-op handler marks `settled` handled without consuming it:
    // the caller still receives the rejection through the returned promise,
    // because `.catch()` observes rather than replaces.
    settled.catch(() => {
      /* the returned promise is the caller's channel; this only marks it handled */
    });

    try {
      await this.#writeFrame({ jsonrpc: "2.0", id: requestId, method, params });
    } catch (cause) {
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        this.#pending.delete(key);
        pending.cancelDeadline();
      }
      throw cause;
    }
    return settled;
  }

  /** Fire-and-forget notification. Failures surface through the diagnostic sink. */
  notify(method: string, params: unknown): void {
    this.#assertWritable(method);
    void this.#writeFrame({ jsonrpc: "2.0", method, params }).catch(() => {
      // A notification has no reply to await, so a failed write would otherwise
      // vanish. Reported rather than thrown: the caller is mid-handshake and the
      // next request's own failure is the actionable signal.
      this.#reportDiagnostic({ kind: "notification-write-failed", method });
    });
  }

  /**
   * Tears the connection down. Idempotent: a second call resolves without
   * throwing and without a second `PtyHost.close`.
   */
  async close(): Promise<void> {
    // Guarded on the PTY release, not on `#closed`: an exited child marks the
    // transport unusable but has not released the host's per-session record, and
    // teardown still owes that release.
    if (this.#ptyClosed) {
      return;
    }
    this.#ptyClosed = true;
    this.#closed = true;
    const closedError = new CodexTransportError("The Codex app-server connection was closed.", {
      reason: this.#exitDescription ?? "closed",
    });
    this.#rejectAllPending(closedError);
    this.#onReadyFailed?.(closedError);
    // Exception-ORDERED, and the ordering is the property. The disposer is
    // caller-supplied code and can throw; when it threw ahead of the release
    // below, `close()` returned before the process was ever handed back to the
    // host — so the child kept running while every layer above treated the
    // session as closed, and a replacement could go live beside it. The fault is
    // held rather than swallowed: it is rethrown once the teardown that must not
    // depend on it has run. Boxed because `undefined` is a throwable value.
    let disposeFault: { readonly cause: unknown } | null = null;
    if (this.#unsubscribe !== null) {
      const dispose = this.#unsubscribe;
      this.#unsubscribe = null;
      try {
        dispose();
      } catch (cause) {
        disposeFault = { cause };
      }
    }
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      try {
        await this.#ptyHost.close(ptySessionId);
      } catch {
        // The child may already have been reaped, in which case the host may not
        // know the session. Teardown must not fail on a resource that is gone.
      }
    }
    if (disposeFault !== null) {
      // Rethrown rather than reported: `close()` could already fail this way, so
      // the caller's contract is unchanged — what changed is that the process is
      // gone by the time it does. The teardown paths that must not be displaced
      // by a host-level fault swallow it at their own call site, deliberately
      // and with a reason.
      throw disposeFault.cause;
    }
  }

  /**
   * Tears the connection down HARD, with no graceful phase.
   *
   * For an outcome that leaves provider-side state AMBIGUOUS — a `turn/start`
   * that may or may not have been accepted — the child cannot be left to wind
   * down on its own, because it may be executing tools for a turn no route
   * addresses. `PtyHost` documents no signal for `close(sessionId)` (only
   * `shutdown()` specifies the SIGTERM-then-SIGKILL drain), so the signal is sent
   * explicitly here rather than assumed from the interface. `close()` still runs
   * afterwards: the per-session resource release is owed however the child died.
   */
  async killAndClose(): Promise<void> {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null && !this.#ptyClosed) {
      try {
        await this.#ptyHost.kill(ptySessionId, "SIGKILL");
      } catch {
        // Already reaped, or a host that no longer knows the session. The close
        // below still owes the resource release either way.
      }
    }
    await this.close();
  }

  #assertWritable(method: string): void {
    if (this.#closed) {
      throw new CodexTransportError(
        `Cannot send "${method}": the Codex app-server connection is closed.`,
        { method, reason: this.#exitDescription ?? "closed" },
      );
    }
  }

  async #writeFrame(frame: Record<string, unknown>): Promise<void> {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId === null) {
      throw new CodexTransportError("The Codex app-server connection is not open.");
    }
    // Single write site: every outbound byte of this protocol passes here, so a
    // transport-level change (framing, neutralization at T3.18) lands once.
    await this.#ptyHost.write(ptySessionId, this.#encoder.encode(`${JSON.stringify(frame)}\n`));
  }

  #awaitReadySentinel(): Promise<void> {
    if (this.#sawReadySentinel) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#clearReadyWait();
        reject(
          new CodexTransportError(
            `The Codex app-server prelude did not report readiness within ${this.#startupTimeoutMs}ms.`,
            { timeoutMs: String(this.#startupTimeoutMs) },
          ),
        );
      }, this.#startupTimeoutMs);
      this.#onReady = () => {
        cancelDeadline();
        this.#clearReadyWait();
        resolve();
      };
      // The readiness wait is NOT a pending request, so process death and close
      // must fail it explicitly. Without this, a provider binary that exits
      // during startup (a missing executable exits 126 before the server ever
      // speaks) leaves `open()` unsettled forever.
      this.#onReadyFailed = (error) => {
        cancelDeadline();
        this.#clearReadyWait();
        reject(error);
      };
    });
  }

  #ingest(chunk: Uint8Array): void {
    // A released transport keeps no buffer. Data can still arrive between the
    // synchronous decision to tear down and the host's acknowledgement of it,
    // and appending it would re-grow the very buffer teardown just abandoned.
    if (this.#ptyClosed) {
      return;
    }
    // `stream: true` so a multi-byte character split across chunks is not mangled.
    this.#readBuffer += this.#decoder.decode(chunk, { stream: true });
    let newlineIndex = this.#readBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      // Measured BEFORE the slice. A line that crosses the ceiling and then
      // terminates inside the same chunk leaves a short tail behind, so the
      // post-loop check below would never see it — and by then it would already
      // have been parsed and dispatched. The ceiling is a property of the LINE,
      // so it is enforced where lines are cut.
      if (newlineIndex > CODEX_MAX_LINE_LENGTH) {
        this.#failFraming(newlineIndex);
        return;
      }
      const line = this.#readBuffer.slice(0, newlineIndex);
      this.#readBuffer = this.#readBuffer.slice(newlineIndex + 1);
      // Output post-processing is left on, so server lines arrive CRLF-terminated.
      this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newlineIndex = this.#readBuffer.indexOf("\n");
    }
    // The other half: an UNTERMINATED tail, which the loop above never sees
    // because it has no line to cut. That tail is the quantity that grows
    // without bound; a stream of ordinary frames larger than the ceiling in
    // aggregate is not a breach, and is not treated as one.
    if (this.#readBuffer.length > CODEX_MAX_LINE_LENGTH) {
      this.#failFraming(this.#readBuffer.length);
    }
  }

  /**
   * Abandons an over-long line and the connection carrying it.
   *
   * The tail is DISCARDED UNPARSED rather than truncated: handing a prefix of a
   * frame to the line handler would either fail to parse (reporting a fabricated
   * `unparsable-line` for a frame the provider never sent) or, worse, parse as a
   * valid but incomplete object and be dispatched as if the provider had meant
   * it. Neither is a thing a caller can be told apart from the truth.
   *
   * In-flight callers are failed with the typed error BEFORE the release path
   * runs, so they learn why the transport died rather than receiving the generic
   * closed-connection error; the startup waiter is failed by the same act, which
   * is what bounds the pre-sentinel window (a prelude that never emits a newline
   * would otherwise hold `open()` until the startup deadline while growing the
   * buffer the whole time).
   */
  #failFraming(retainedLength: number): void {
    const error = new CodexLineTooLongError(retainedLength, CODEX_MAX_LINE_LENGTH);
    this.#readBuffer = "";
    this.#reportDiagnostic({
      kind: "line-too-long",
      retainedLength,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    this.#rejectAllPending(error);
    this.#onReadyFailed?.(error);
    // Signalled explicitly, then released. `PtyHost.close` is specified as
    // "tear down the session and release all per-session resources" and does
    // NOT promise to signal the child -- `shutdown()` documents the graceful
    // per-session kill as a separate dispatch -- so `close()` alone could leave
    // a still-running process writing into a PTY nobody reads.
    //
    // `SIGKILL` rather than `SIGTERM` for this condition specifically: there is
    // no protocol left to negotiate an orderly stop over, and a peer already
    // emitting an unbounded line is the last peer to give a shutdown window to.
    // The graceful path stays where it belongs, on `closeSession`.
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      void this.#ptyHost.kill(ptySessionId, "SIGKILL").catch(() => {
        /* already reaped, or the host lost it; `close()` still owes the release */
      });
    }
    void this.close().catch(() => {
      /* teardown of an already-doomed transport changes nothing here */
    });
  }

  #handleLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    if (!this.#sawReadySentinel && line === CODEX_APP_SERVER_READY_SENTINEL) {
      this.#sawReadySentinel = true;
      this.#onReady?.();
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // Shell diagnostics, provider stderr, or a truncated frame. Reported, not
      // dropped — this is the channel on which a mis-set tty becomes visible.
      this.#reportDiagnostic({ kind: "unparsable-line", line });
      return;
    }
    if (!isPlainObject(frame)) {
      this.#reportDiagnostic({ kind: "unparsable-line", line });
      return;
    }
    const message = frame;
    const method = message["method"];
    if (typeof method === "string") {
      this.#handleInboundMethod(method, message);
      return;
    }
    this.#handleInboundResponse(message, line);
  }

  #handleInboundMethod(method: string, message: Record<string, unknown>): void {
    const id = message["id"];
    const isRequest = id !== undefined && id !== null;
    if (isRequest) {
      if (this.#isEchoOfOurOwnRequest(id, method)) {
        // Our own frame, echoed back by a tty whose ECHO was still on. Never
        // answered: a response to it would corrupt the server's correlation.
        this.#reportDiagnostic({ kind: "echoed-client-frame", method });
        return;
      }
      // Fail closed, for EVERY other method+id frame — censused or not.
      // Approvals and elicitations route through the daemon's own pipeline (T3.5
      // and beyond); answering with an error refuses cleanly and can never be
      // mistaken for consent, while leaving it unanswered would hang the
      // provider's turn. That hang is the whole reason membership in the pinned
      // census does not gate this arm: a newer admitted build may speak a
      // request method this pin never saw.
      this.#reportDiagnostic({
        kind: "unhandled-server-request",
        method,
        censused: CODEX_SERVER_REQUEST_METHODS.has(method),
      });
      void this.#writeFrame({
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `The driver does not handle "${method}" at this lifecycle stage.`,
        },
      }).catch(() => {
        /* connection already gone; the exit path reports it */
      });
      return;
    }
    if (this.#onServerNotification !== undefined) {
      this.#onServerNotification(method, message["params"]);
      return;
    }
    this.#reportDiagnostic({ kind: "unconsumed-server-notification", method });
  }

  /**
   * True only for a frame this connection SENT and is still awaiting a reply to.
   *
   * Correlation, not a name test: an echo is by definition one of our own
   * outbound requests coming back, so it must match a pending entry on BOTH the
   * id and the method. Matching the id alone would be wrong — the two directions
   * mint request ids in independent namespaces, so a server request can carry an
   * id we also used — and matching the method alone would be wrong for the same
   * reason in reverse.
   *
   * The pending entry is deliberately left in place: the real reply is still
   * owed, and consuming the entry here would strand the caller until its
   * deadline. In practice this arm is near-dead — the termios prelude disables
   * ECHO before the sentinel, and no request is sent before the sentinel — which
   * is precisely why the OTHER arm has to be the safe default.
   */
  #isEchoOfOurOwnRequest(id: unknown, method: string): boolean {
    if (typeof id !== "number" && typeof id !== "string") {
      return false;
    }
    return this.#pending.get(String(id))?.method === method;
  }

  #handleInboundResponse(message: Record<string, unknown>, line: string): void {
    const id = message["id"];
    if (typeof id !== "number" && typeof id !== "string") {
      this.#reportDiagnostic({ kind: "unparsable-line", line });
      return;
    }
    const key = String(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#reportDiagnostic({ kind: "unknown-response-id", responseId: key });
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
    const error = message["error"];
    if (error !== undefined && error !== null) {
      const errorRecord = isPlainObject(error) ? error : {};
      const rawCode = errorRecord["code"];
      const rawMessage = errorRecord["message"];
      const providerErrorCode = typeof rawCode === "number" ? rawCode : 0;
      const providerMessage = typeof rawMessage === "string" ? rawMessage : "";
      pending.reject(
        new CodexProviderRequestError(
          pending.method,
          providerErrorCode,
          providerMessage,
          // Read with no shape assumption and no narrowing: absent stays absent.
          errorRecord["data"],
        ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  #handleExit(exitCode: number, signalCode: number | null): void {
    this.#exitDescription = `exit ${exitCode}${signalCode === null ? "" : ` signal ${signalCode}`}`;
    this.#reportDiagnostic({ kind: "process-exited", exitCode, signalCode });
    // Mark closed BEFORE rejecting: a rejection handler that retries must be
    // refused a write rather than hitting the dead fd (a write to an exited pty
    // raises an asynchronous EIO that no caller can catch).
    this.#closed = true;
    if (this.#unsubscribe !== null) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
    const exitError = new CodexTransportError("The Codex app-server process exited.", {
      reason: this.#exitDescription,
    });
    this.#rejectAllPending(exitError);
    this.#onReadyFailed?.(exitError);
  }

  #clearReadyWait(): void {
    this.#onReady = null;
    this.#onReadyFailed = null;
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cancelDeadline();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

// --------------------------------------------------------------------------
// Lifecycle manager
// --------------------------------------------------------------------------

interface CodexSessionRecord {
  readonly sessionId: SessionId;
  readonly connection: CodexAppServerConnection;
  readonly threadId: string;
  readonly spawnConfig: CodexSessionConfig;
  readonly activeTurnIdByRunId: Map<RunId, string>;
  /**
   * Turn ids whose terminal notification arrived while no route pointed at them.
   * Insertion-ordered and capped (`CODEX_TERMINATED_TURN_MEMORY`); consumed by
   * `startRun`. See the note there for the interleave this exists to survive.
   */
  readonly terminatedTurnIds: Set<string>;
}

/**
 * Records a terminal turn id in a session's bounded FIFO memory.
 *
 * Re-inserted rather than skipped on a repeat so a duplicate terminal refreshes
 * its position instead of aging out while still relevant. Eviction is oldest
 * first, which is the right end: the hazard this memory covers is resolved
 * within one microtask of the turn starting, so the oldest entry is always the
 * least likely to still be claimed.
 */
function rememberTerminatedTurn(record: CodexSessionRecord, turnId: string): void {
  const memory = record.terminatedTurnIds;
  memory.delete(turnId);
  memory.add(turnId);
  while (memory.size > CODEX_TERMINATED_TURN_MEMORY) {
    const oldest = memory.values().next();
    if (oldest.done === true) {
      break;
    }
    memory.delete(oldest.value);
  }
}

/** A session slot held for the duration of one in-flight lifecycle transition. */
interface CodexSessionTransition {
  readonly kind: CodexSessionTransitionKind;
  /** Settlement of the transition, rejection-swallowed so a chained waiter cannot inherit its failure. */
  readonly settled: Promise<void>;
}

/**
 * The slot states a TRANSITION can publish.
 *
 * Derived from `CodexSessionSlotState` by exclusion rather than restated, so the
 * two can never drift into disagreeing about what a slot can be: `live` is the
 * one state no transition holds, because it is what a settled record IS.
 */
type CodexSessionTransitionKind = Exclude<CodexSessionSlotState, "live">;

/**
 * True when a `turn/start` outcome leaves provider-side turn state AMBIGUOUS.
 *
 * The asymmetry is the argument, not the enumeration. At this seam the driver
 * cannot distinguish "the provider never saw it" from "the provider accepted it
 * and the answer was lost": over-killing costs one re-establish, while
 * under-killing leaves a turn executing tools with no route to interrupt it, no
 * id to address it by, and a session the daemon will happily reuse — so a retry
 * doubles the work against a turn nobody can see. The class is therefore WIDE and
 * closed from the OTHER end: a clean JSON-RPC error response is the single
 * exemption, because a provider answering "no" is proof it processed the request
 * and started nothing. A deadline, a transport death, and a response carrying an
 * unusable turn id all leave the same question open and are treated the same way.
 *
 * `#assertWritable`'s already-closed refusal lands in the ambiguous class too,
 * deliberately: the teardown it triggers is idempotent, so paying for it twice
 * costs nothing, and exempting it would key the exemption on a call-site proxy
 * rather than on the semantic question the classifier asks.
 *
 * ADR-029 is what makes the wide class affordable: the daemon's canonical
 * transcript is authoritative and every provider session is a replay target, so
 * ambiguity about provider-side turn state is never worth carrying. Teardown and
 * replay is the designed recovery — deliberately NOT a `turn/started`
 * reconciliation, which would keep alive a turn the daemon has just reported as
 * having failed to start, and owe interrupt machinery for it.
 */
function isAmbiguousTurnStartOutcome(cause: unknown): boolean {
  return !(cause instanceof CodexProviderRequestError);
}

/** Construction inputs for the lifecycle manager. */
export interface CodexLifecycleOptions extends CodexConnectionOptions {
  /**
   * Spawn context for a RESUME when this process holds no record of the session
   * (the daemon-restart case, which is the ordinary one).
   *
   * `ResumeSessionParams` carries neither `cwd` nor `env`, yet a spawn needs
   * both — and an empty environment is not a safe default: the provider locates
   * its credential home and its own tooling through environment variables, so a
   * resume launched bare would fail in a way that looks like a bad handle. The
   * resumed THREAD restores its own recorded working directory through
   * `thread/resume`, so `cwd` here is the process's directory rather than the
   * thread's. Required, never defaulted, so nothing is silently inherited from
   * the daemon process (this module reads `process.env` nowhere).
   */
  readonly resumeSpawnConfig: CodexSessionConfig;
  /** Mints `DriverResumeResult.bindingId`; supply the store's minter in the daemon. */
  readonly newBindingId?: (() => string) | undefined;
}

/**
 * The five lifecycle operations of `Spec-005 §Required Behavior`, expressed as
 * Codex `app-server` calls over one connection per session.
 */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #newBindingId: () => string;
  readonly #turnStartTimeoutMs: number;
  readonly #sessions = new Map<SessionId, CodexSessionRecord>();
  readonly #sessionIdByRunId = new Map<RunId, SessionId>();
  /**
   * Session ids with a lifecycle transition in flight, mapped to its kind and a
   * rejection-swallowed view of its settlement.
   *
   * ONE mechanism for both directions, which is the correction. An earlier shape
   * tracked establishments only, and that left teardown unguarded: `closeSession`
   * deleted the record and THEN awaited an unsubscribe and a process close, so
   * for the length of those awaits the slot read as empty while the child was
   * still exiting — and a create could admit a second process beside it. The rule
   * is now symmetric and has no direction in it: a slot is held from the first
   * synchronous instant of a transition until that transition has fully settled.
   */
  readonly #sessionTransitions = new Map<SessionId, CodexSessionTransition>();

  constructor(options: CodexLifecycleOptions) {
    this.#options = options;
    this.#newBindingId = options.newBindingId ?? ((): string => randomUUID());
    this.#turnStartTimeoutMs = options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
  }

  /** Spawns a process and starts a fresh Codex thread. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Refused BEFORE anything is spawned, so a mis-sequenced caller costs no
    // process. See `CodexSessionAlreadyLiveError` for why replacing is wrong.
    //
    // The check reads EVERY view of the slot, and there is no `await` between
    // this read and the claim below. A create that tested only `#sessions` would
    // be a synchronous guard in front of two suspensions: two overlapping creates
    // for one session id would both pass it, both spawn, and the later install
    // would orphan the earlier process with nothing holding a reference to close
    // it. A `closing` holder refuses for the same reason and not a weaker one —
    // the child of a session mid-teardown is still alive, and still this
    // manager's to dispose.
    const holderState = this.#describeSlotHolder(params.sessionId);
    if (holderState !== undefined) {
      throw new CodexSessionAlreadyLiveError(params.sessionId, holderState);
    }
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishCreatedSession(params),
    );
  }

  async #establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    const config = parseCodexSessionConfig(params.config);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Inside the guard: `open()` tears its own process down on the paths it
      // owns, but a caller-supplied subscriber that throws is not one of them,
      // and `close()` is idempotent, so guarding here costs nothing and closes
      // the window.
      await connection.open(config);
      const response = await connection.request("thread/start", {
        cwd: config.cwd,
        // Pinned as defense in depth so no config or profile override can select
        // an auto-review path that bypasses the daemon's approval pipeline.
        // `ThreadStartParams` carries this field (verified against the pinned
        // binary's own generated schema at `codex-cli 0.149.1`, regenerated
        // 2026-08-27 — `docs/reference/provider-wire/codex.md`), so the pin is
        // accepted rather than an unknown-field risk. It is NOT sufficient on its
        // own: see the per-turn pin in `startRun`.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/start");
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        spawnConfig: config,
        activeTurnIdByRunId: new Map(),
        terminatedTurnIds: new Set(),
      });
      // `id` is the resume key; `sessionId` groups a thread tree (fork/subagent
      // threads share it), so the two are NOT interchangeable.
      return { providerSessionId: thread.sessionId, resumeHandle: thread.id };
    } catch (cause) {
      // Contained, not bare. `close()` can throw a caller-supplied disposer's
      // fault, and a bare `await connection.close()` here let that fault escape
      // BEFORE the rethrow — so a spawn or handshake failure was replaced by a
      // teardown artifact and the actionable cause was lost. Same reasoning as
      // the resume path, which has always contained it.
      await this.#releaseAbandonedConnection(connection);
      throw cause;
    }
  }

  /**
   * Resumes an existing Codex thread from its provider-owned handle.
   *
   * I-005-5: every failure path returns the typed `failed` result. This method
   * calls no session-creating operation, and the process it spawns is bound to
   * `thread/resume` alone — a failed resume tears that process down and reports,
   * it never converts into a fresh thread.
   */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Resume CLAIMS the slot rather than refusing a held one, which is a
    // deliberate divergence from the Claude leg (which refuses): this driver
    // supersedes a live leg on resume and releases it explicitly, so serializing
    // behind the holder is what makes that release reachable. A resume that read
    // the slot as empty mid-establishment would find `existing === undefined`,
    // install over the winner, and orphan its process. The same chaining carries
    // it behind a `closing` holder, where the correct behaviour is likewise to
    // wait rather than refuse: once that teardown settles there is simply nothing
    // to supersede, and the resume establishes cleanly.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishResumedSession(params),
    );
  }

  async #establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Read INSIDE the claimed establishment, never at the call site: the claim
    // chains behind any predecessor, so this read must happen after that
    // predecessor has installed its record for the supersede to see it.
    const existing = this.#sessions.get(params.sessionId);
    const spawnConfig = existing?.spawnConfig ?? this.#options.resumeSpawnConfig;
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      await connection.open(spawnConfig);
      const response = await connection.request("thread/resume", {
        threadId: params.resumeHandle,
        // The same defense-in-depth pin as `thread/start`; `ThreadResumeParams`
        // carries the field at the pin (verified 2026-08-27 against the binary's
        // generated schema). A resumed thread must not inherit an auto-review
        // reviewer from whatever config the provider reloads with it.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/resume");
      // I-005-5's identity gate, and it runs BEFORE the position check because it
      // is the stronger one. Codex may answer a resume it cannot honour by
      // handing back a DIFFERENT thread; for a zero-turn session that thread has
      // `turns: []`, which is a perfectly well-formed history, so the position
      // check below cannot tell it from a genuine resume. Only the id can.
      // Adopting it would be the silent replacement this invariant forbids.
      if (thread.id !== params.resumeHandle) {
        throw new CodexTransportError(
          `Resume handle ${params.resumeHandle} was answered by thread ${thread.id}; the provider started a replacement thread rather than resuming.`,
          {
            method: "thread/resume",
            requestedThreadId: params.resumeHandle,
            answeredThreadId: thread.id,
          },
        );
      }
      if (!Array.isArray(thread.turns)) {
        // `Thread.turns` is populated on `thread/resume` by contract. If it is
        // absent we cannot know the position, and fabricating 0 would make a
        // silently-fresh thread indistinguishable from a resumed one — the exact
        // confusion I-005-5 exists to prevent. Refuse instead.
        throw new CodexTransportError(
          "The Codex app-server resume response carried no turn history, so the session position is unknown.",
          { threadId: thread.id },
        );
      }
      // Built and VALIDATED before the swap, never after it. `bindingId` is
      // minted by a caller-supplied function and bounded by the schema's
      // `wireFreeFormString`, so an empty or overlength mint THROWS — and when
      // that throw landed after the record was installed and the predecessor
      // released, the catch below closed the new connection and left the session
      // mapped to it: create refused the session as live, every request on it hit
      // a dead transport, and only another resume could clear it. Minting and
      // parsing first makes the swap all-or-nothing, which is what lets the catch
      // path keep its promise that a failed resume changes nothing.
      const resumedResult = DriverResumeResultSchema.parse({
        status: "resumed",
        bindingId: this.#newBindingId(),
        sessionPosition: thread.turns.length,
      });
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        spawnConfig,
        activeTurnIdByRunId: new Map(),
        terminatedTurnIds: new Set(),
      });
      // The replacement record starts with an empty turn map, so every route
      // that pointed at the superseded leg is now dead. Swept here rather than
      // at teardown: `closeSession` reads the LIVE record, which no longer knows
      // those runs, so a route left behind would never be collected and the map
      // would grow by one entry per in-flight run per resume, for the daemon's
      // whole lifetime.
      this.#forgetRunRoutes(params.sessionId);
      // A resume is a fresh spawn, so any prior leg for this session is now
      // superseded and its process would otherwise be orphaned. Released AFTER
      // the new record is installed, which is what keeps a FAILED resume
      // non-destructive: on the catch path below, the prior leg is still the
      // live one and is left exactly as it was found.
      if (existing !== undefined) {
        await this.#releaseAbandonedConnection(existing.connection);
      }
      return resumedResult;
    } catch (cause) {
      // Quietly: teardown of the leg that just failed must not throw past the
      // typed result. A close that escaped here would turn the `recovery-needed`
      // condition back into an exception, which is exactly the loss I-005-5
      // forbids.
      await this.#releaseAbandonedConnection(connection);
      return DriverResumeResultSchema.parse({
        status: "failed",
        // Always `recovery-needed` at this task: `reauth-required` is an
        // authentication classification, and distinguishing provider failure
        // causes is T3.14/T3.22's leg.
        recoveryCondition: "recovery-needed",
        // The driver observed a refused resume, not the span of work that was in
        // flight; classifying that span needs run state the driver does not hold.
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  /** Starts one provider turn for a run. */
  async startRun(params: StartRunParams): Promise<void> {
    const runConfig = parseCodexRunConfig(params.agentConfig);
    const record = this.#requireSession(runConfig.sessionId);
    let turnId: string;
    try {
      turnId = readTurnId(await this.#requestTurnStart(record, runConfig, params), "turn/start");
    } catch (cause) {
      if (isAmbiguousTurnStartOutcome(cause)) {
        await this.#disposeAmbiguousSession(record);
      }
      throw cause;
    }
    // Everything from here is ONE synchronous run, so a single slot check covers
    // both the install and the terminal-memory consume below it.
    if (!this.#stillHoldsSlot(record)) {
      // The record can stop being the session's settled one while `turn/start` is
      // in flight: a `closeSession` claims the slot and tears it down, or a
      // resume supersedes it — and either way the connection this turn was
      // accepted on has already been released, so the turn died with it.
      // Installing the route here would point `interruptRun` at a dead process
      // and strand an entry in `#sessionIdByRunId` that no sweep can reach, since
      // every sweep keys on a record that is gone. Refused rather than silently
      // reported as started: whatever the provider answered, this run is not
      // running. Not disposed either — whoever claimed the slot owns that
      // connection's teardown and is already performing it.
      throw new CodexTransportError(
        `Codex session "${record.sessionId}" stopped holding its slot while a turn was starting.`,
        { sessionId: record.sessionId, method: "turn/start" },
      );
    }
    record.activeTurnIdByRunId.set(params.runId, turnId);
    this.#sessionIdByRunId.set(params.runId, record.sessionId);
    // The turn can already be OVER by the time this install runs. Resolving the
    // `turn/start` response schedules this continuation as a microtask, while
    // `#ingest` keeps draining the rest of the read chunk SYNCHRONOUSLY — so for
    // a fast turn whose response and `turn/completed` arrive in one chunk, the
    // sweep runs first, matches nothing, and this install would leave a route
    // that `hasActiveTurn` reports live for the daemon's lifetime. Consulting the
    // record's short memory of unmatched terminals closes that window; the
    // `delete` is the consume, so a later turn reusing the id (it cannot — turn
    // ids are UUIDv7) could not be retired twice.
    if (record.terminatedTurnIds.delete(turnId)) {
      record.activeTurnIdByRunId.delete(params.runId);
      this.#sessionIdByRunId.delete(params.runId);
    }
  }

  /** The `turn/start` request itself, split out so `startRun` reads as its policy. */
  async #requestTurnStart(
    record: CodexSessionRecord,
    runConfig: CodexRunConfig,
    params: StartRunParams,
  ): Promise<unknown> {
    return await record.connection.request(
      "turn/start",
      {
        threadId: record.threadId,
        input: [{ type: "text", text: runConfig.input, text_elements: [] }],
        // The pin that actually carries the security property. A TURN is what
        // generates approval requests, and `TurnStartParams.approvalsReviewer` is
        // documented as overriding routing for "this turn and subsequent turns"
        // — so a config- or profile-selected `auto_review` reviewer would win on
        // every turn if only the thread-level pin were sent. Pinning it here is
        // idempotent rather than redundant, and `turn/steer` needs no pin because
        // it requires an already-active turn and creates none. Field verified
        // present on `TurnStartParams` at `codex-cli 0.149.1` (regenerated
        // 2026-08-27 — `docs/reference/provider-wire/codex.md`).
        approvalsReviewer: "user",
        ...(runConfig.model === undefined ? {} : { model: runConfig.model }),
        ...(runConfig.clientUserMessageId === undefined
          ? {}
          : { clientUserMessageId: runConfig.clientUserMessageId }),
        ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
      },
      this.#turnStartTimeoutMs,
    );
  }

  /**
   * Disposes the session a `turn/start` left ambiguous: kill first, then release.
   *
   * Claimed like any other teardown, so nothing can slip into the window while
   * the child is dying — the dispose is a state transition of the slot, not a
   * side effect beside it. Scoped to the RECORD rather than to the session id: if
   * a resume superseded this leg while the turn was starting, that resume already
   * released this connection and installed its own, and this dispose must not
   * take the replacement down with it.
   *
   * No graceful `thread/unsubscribe` phase. The connection is precisely the thing
   * whose answers cannot be trusted, so asking it a question would buy a second
   * deadline and no information.
   */
  async #disposeAmbiguousSession(record: CodexSessionRecord): Promise<void> {
    await this.#claimSessionSlot(record.sessionId, "closing", async () => {
      if (this.#sessions.get(record.sessionId) === record) {
        this.#sessions.delete(record.sessionId);
        this.#forgetRunRoutes(record.sessionId);
      }
      try {
        await record.connection.killAndClose();
      } catch {
        // Swallowed: the caller is already throwing the typed cause that says WHY
        // the session was disposed, and a teardown artifact must not displace it.
      }
    });
  }

  /** Interrupts the provider turn bound to a run. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const { record, turnId } = this.#requireActiveTurn(params.runId);
    await record.connection.request("turn/interrupt", {
      threadId: record.threadId,
      turnId,
    });
    record.activeTurnIdByRunId.delete(params.runId);
    this.#sessionIdByRunId.delete(params.runId);
  }

  /**
   * Unsubscribes from the thread and tears down the process. Idempotent: closing
   * an unknown or already-closed session resolves without throwing.
   */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Read and claim in ONE synchronous run, with no `await` between them. The
    // early return is not an optimization: claiming for a session this manager
    // does not hold would refuse a concurrent create for a slot that is genuinely
    // free, and a close of an unknown session is specified as a no-op.
    //
    // A close arriving mid-establishment does NOT take that branch — the slot
    // reads `establishing` — so it claims and chains, and the in-flight create or
    // resume can no longer install a record that outlives the session the daemon
    // believes it closed. Chaining also covers a QUEUE of transitions
    // transitively, since each claim already waits on its predecessor. Safe from
    // deadlock: no establishment path calls `closeSession` (each closes its own
    // CONNECTION directly), so the wait can never be on this call.
    if (this.#describeSlotHolder(params.sessionId) === undefined) {
      return;
    }
    await this.#claimSessionSlot(params.sessionId, "closing", async () => {
      await this.#tearDownSession(params.sessionId);
    });
  }

  /**
   * Graceful teardown of whatever record holds the session, inside a claimed slot.
   *
   * The record is deleted in a `finally` at the END rather than up front, and
   * both halves of that are load-bearing. Deleting first freed the slot for the
   * length of the unsubscribe and the process close — the window a second create
   * used to spawn into. Deleting only on success would make a session whose
   * teardown threw permanently unclosable AND permanently un-creatable, which
   * trades a leaked process for a wedged slot.
   */
  async #tearDownSession(sessionId: SessionId): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      // The establishment this close chained behind failed, so nothing was ever
      // installed; that path released its own connection on the way out.
      return;
    }
    // Routes are dropped up front, apart from the record: they are not the slot,
    // and `hasActiveTurn` must stop reporting a run live the instant its session
    // begins tearing down rather than when the process finally goes.
    this.#forgetRunRoutes(sessionId);
    try {
      if (!record.connection.isClosed) {
        try {
          // Best effort, and bounded: the process is going away regardless, so a
          // refused OR unanswered unsubscribe must not block teardown or surface
          // as a close failure. The explicit deadline is what makes "must not
          // block" true against a wedged provider.
          await record.connection.request(
            "thread/unsubscribe",
            { threadId: record.threadId },
            UNSUBSCRIBE_TIMEOUT_MS,
          );
        } catch {
          /* teardown proceeds */
        }
      }
      await record.connection.close();
    } finally {
      this.#sessions.delete(sessionId);
    }
  }

  /** Steer is routed here by the intervention dispatcher (T3.2). */
  async steerRun(runId: RunId, content: string, expectedTurnId?: string): Promise<void> {
    const { record, turnId } = this.#requireActiveTurn(runId);
    await record.connection.request("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: content, text_elements: [] }],
      // The provider REQUIRES an active-turn precondition. A caller-supplied
      // expectation wins so a stale steer is refused by the provider rather than
      // silently retargeted at whatever turn is running now.
      expectedTurnId: expectedTurnId ?? turnId,
    });
  }

  /** True when the run has a live provider turn. */
  hasActiveTurn(runId: RunId): boolean {
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return false;
    }
    return this.#sessions.get(sessionId)?.activeTurnIdByRunId.has(runId) === true;
  }

  /**
   * Names the current holder of a session slot, or `undefined` when it is free.
   *
   * One predicate, so the live and in-flight views can never drift into
   * disagreeing about what "taken" means.
   */
  #describeSlotHolder(sessionId: SessionId): CodexSessionSlotState | undefined {
    // Transition FIRST. During a supersede-resume both views are occupied (the
    // predecessor's record plus the resume's claim), and during a teardown the
    // record deliberately stays installed until the transition settles — so
    // reading `#sessions` first would report `live` for a session that is dying.
    // The in-flight kind is the more specific truth in both cases.
    const transition = this.#sessionTransitions.get(sessionId);
    if (transition !== undefined) {
      return transition.kind;
    }
    return this.#sessions.has(sessionId) ? "live" : undefined;
  }

  /**
   * True when `record` is still the session's SETTLED, live holder.
   *
   * Stronger than an identity check on `#sessions`, and it has to be: a record
   * mid-teardown is still installed (that is what holds the slot), so identity
   * alone would report a dying session as usable.
   */
  #stillHoldsSlot(record: CodexSessionRecord): boolean {
    return (
      this.#describeSlotHolder(record.sessionId) === "live" &&
      this.#sessions.get(record.sessionId) === record
    );
  }

  /**
   * Claims the session slot in one state and runs the transition behind any
   * predecessor. The only way a slot is ever taken, in either direction.
   *
   * The read of the predecessor and the publication of the claim happen in ONE
   * synchronous run, which is the whole point. An `await` between them — even one
   * that finds the slot empty — yields a microtask, and two callers dispatched in
   * the same tick would both observe an empty slot, both proceed, and the second
   * would overwrite the first's claim while both transitions ran concurrently.
   *
   * `predecessor.then(runTransition)` rather than an inline async body, because
   * the two are not equivalent: an async IIFE runs synchronously up to its own
   * first `await`, so the transition would begin BEFORE the claim it depends on
   * was published — correct today only because nothing can interleave inside a
   * single synchronous run, which is an argument rather than a structure. `.then`
   * defers the body to a microtask, making "claimed before it runs" true by
   * construction. It also unifies the empty-slot case, which has no predecessor
   * to await and therefore no branch.
   *
   * Chaining rather than waiting-for-absence is what serializes a QUEUE: two
   * callers released by the same settlement would both observe a free slot.
   *
   * The stored view is rejection-swallowed: it exists to SEQUENCE, and a stored
   * promise that could reject would surface as an unhandled rejection whenever
   * nobody happened to be waiting on that session.
   */
  async #claimSessionSlot<TSettled>(
    sessionId: SessionId,
    kind: CodexSessionTransitionKind,
    runTransition: () => Promise<TSettled>,
  ): Promise<TSettled> {
    const predecessor = this.#sessionTransitions.get(sessionId)?.settled ?? Promise.resolve();
    const transition = predecessor.then(runTransition);
    const claim: CodexSessionTransition = {
      kind,
      settled: transition.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.#sessionTransitions.set(sessionId, claim);
    try {
      return await transition;
    } finally {
      // Identity-checked on the CLAIM OBJECT: only ever clear our own. A later
      // caller chains onto this one and publishes its own claim, so clearing
      // unconditionally would free a slot that is still occupied.
      if (this.#sessionTransitions.get(sessionId) === claim) {
        this.#sessionTransitions.delete(sessionId);
      }
    }
  }

  /**
   * Per-session connection options, with the manager interposed on the server
   * notification stream.
   *
   * The manager has to SEE the stream to retire routes on turn termination, but
   * it is not the consumer of it — the event normalizer (T3.5) is. Interposing
   * rather than competing keeps one sink: the manager observes, then hands the
   * frame on unchanged, in order, with the delegate's `(method, params)` shape
   * untouched. When no delegate is supplied the transport's own
   * `unconsumed-server-notification` diagnostic is preserved by re-reporting it
   * here, since the sink is now always present from the transport's point of
   * view.
   */
  #connectionOptionsFor(sessionId: SessionId): CodexConnectionOptions {
    const delegate = this.#options.onServerNotification;
    const reportDiagnostic = this.#options.reportDiagnostic;
    return {
      ...this.#options,
      onServerNotification: (method: string, params: unknown): void => {
        this.#observeServerNotification(sessionId, method, params);
        if (delegate === undefined) {
          reportDiagnostic({ kind: "unconsumed-server-notification", method });
          return;
        }
        delegate(method, params);
      },
    };
  }

  /**
   * Retires the route bound to a turn the provider has just ended.
   *
   * Without this, only `interruptRun` and `closeSession` ever clear a route, so a
   * turn that simply FINISHES leaks both map entries for the daemon's lifetime
   * and `hasActiveTurn` keeps reporting the run live — which would let a later
   * intervention target a turn id the provider retired long ago.
   */
  #observeServerNotification(sessionId: SessionId, method: string, params: unknown): void {
    if (method !== CODEX_TURN_COMPLETED_NOTIFICATION) {
      return;
    }
    const payload = isPlainObject(params) ? params : {};
    const rawTurn = payload["turn"];
    const turn = isPlainObject(rawTurn) ? rawTurn : {};
    const turnId = turn["id"];
    const status = turn["status"];
    if (typeof turnId !== "string" || turnId.length === 0) {
      return;
    }
    if (typeof status !== "string" || !CODEX_TERMINAL_TURN_STATUSES.has(status)) {
      return;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      // No record means no route can exist for this turn yet, and none can be
      // installed against a session this manager does not hold. Nothing to
      // remember.
      return;
    }
    // Keyed by TURN id, not by run id. A run whose route was superseded (by a
    // resume) or already retired (by an interrupt) must not have a NEWER turn
    // cleared out from under it by a late terminal for the old one.
    let matchedRoute = false;
    for (const [runId, activeTurnId] of record.activeTurnIdByRunId) {
      if (activeTurnId === turnId) {
        record.activeTurnIdByRunId.delete(runId);
        this.#sessionIdByRunId.delete(runId);
        matchedRoute = true;
      }
    }
    if (!matchedRoute) {
      rememberTerminatedTurn(record, turnId);
    }
  }

  /**
   * Tears down a connection whose outcome no longer matters, without letting the
   * teardown change the outcome of the operation that abandoned it.
   *
   * `close()` swallows a host that no longer knows the session, but an injected
   * subscription disposer is caller code and can throw. All three call sites need
   * that failure contained, and each already holds the outcome that matters: a
   * succeeded resume has produced its `resumed` result, a failed resume is
   * mid-flight to the typed `recovery-needed` result I-005-5 requires, and a
   * failed create is about to rethrow the spawn or handshake cause that explains
   * itself. `closeSession` deliberately does NOT route through here — a close has
   * no other outcome to protect, so its caller is exactly who should hear that
   * the disposer misbehaved.
   */
  async #releaseAbandonedConnection(connection: CodexAppServerConnection): Promise<void> {
    try {
      await connection.close();
    } catch {
      // Deliberately swallowed — see the note above. The transport is abandoned
      // either way; a refusing teardown is a host-level condition, not a result.
    }
  }

  /**
   * Drops every run route bound to a session, scanning BY VALUE.
   *
   * Keyed lookup is not available: the routes are keyed by run, and the record
   * that could enumerate them is either gone or replaced by the time a sweep is
   * owed. Mirrors the Claude leg's `#forgetSession`.
   */
  #forgetRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }

  #requireSession(sessionId: SessionId): CodexSessionRecord {
    // A record now stays installed for the whole of its teardown — that is what
    // holds the slot — so "installed" no longer implies "usable". Refused here
    // rather than left to fail on the wire: an unsubscribe is already in flight,
    // so a turn started now would run unobserved on a process about to die.
    if (this.#describeSlotHolder(sessionId) === "closing") {
      throw new CodexTransportError(`Codex session "${sessionId}" is being torn down.`, {
        sessionId,
        holderState: "closing",
      });
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new CodexTransportError(`No live Codex session for "${sessionId}".`, { sessionId });
    }
    return record;
  }

  #requireActiveTurn(runId: RunId): { record: CodexSessionRecord; turnId: string } {
    const sessionId = this.#sessionIdByRunId.get(runId);
    const record = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const turnId = record?.activeTurnIdByRunId.get(runId);
    if (record === undefined || turnId === undefined) {
      throw new CodexTransportError(`No active Codex turn for run "${runId}".`, { runId });
    }
    return { record, turnId };
  }
}

interface ThreadView {
  id: string;
  sessionId: string;
  turns: unknown;
}

function readThread(response: unknown, method: string): ThreadView {
  const record = isPlainObject(response) ? response : {};
  const thread = record["thread"];
  // Routed through the shared guard so an ARRAY is refused here too. The former
  // `typeof thread !== "object"` check admitted one, and an array's `["id"]`
  // reads `undefined`, so a malformed response reached the identity check as a
  // merely-absent field rather than as the wrong shape it is.
  if (!isPlainObject(thread)) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no thread.`, {
      method,
    });
  }
  const id = thread["id"];
  const sessionId = thread["sessionId"];
  if (typeof id !== "string" || id.length === 0 || typeof sessionId !== "string") {
    throw new CodexTransportError(
      `The Codex app-server "${method}" response carried an unusable thread identity.`,
      { method },
    );
  }
  return { id, sessionId, turns: thread["turns"] };
}

function readTurnId(response: unknown, method: string): string {
  const record = isPlainObject(response) ? response : {};
  const turn = record["turn"];
  const turnRecord = isPlainObject(turn) ? turn : {};
  const id = turnRecord["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no turn id.`, {
      method,
    });
  }
  return id;
}
