// ClaudeSessionLifecycle — the Claude driver's session + run lifecycle band
// (Plan-005 Phase 3, T3.6).
//
// Owns five of the fourteen `ProviderDriver` operations for the Claude leg:
// `createSession`, `resumeSession`, `startRun`, `interruptRun`, `closeSession`.
// The remaining nine (capabilities / models / modes, the R8 parity operations,
// `respondToRequest`, `probeAuth`) are authored by sibling Phase-3 tasks and are
// deliberately absent here rather than stubbed — a stub that throws would be a
// declared-then-unsupported capability, which is exactly what I-005-2 forbids.
//
// SPEC COVERAGE
//   * `Spec-005 §Required Behavior` — the normalized operation surface: the daemon drives
//     Claude through these methods and never through provider-native calls.
//   * `Spec-005 §Fallback Behavior` (AC3) — a resume-handle failure surfaces `provider failure`
//     detail plus a visible `recovery-needed` condition, and MUST NOT silently
//     create a replacement provider session under the same canonical run.
//
// I-005-5 (the load-bearing invariant of this file), realized three ways:
//   1. STRUCTURALLY — `DriverResumeResult` is a discriminated union whose
//      `failed` arm carries no `bindingId`, so "failed" and "resumed" cannot be
//      conflated. That half ships in `@ai-sidekicks/contracts` (T1.6).
//   2. BY IDENTITY GATE — a resume is `resumed` ONLY when the transport reports
//      back the SAME provider session id the resume handle names. Claude answers
//      a resume whose recorded working directory no longer matches by starting a
//      FRESH session (`docs/reference/provider-wire/claude.md` §Session flags),
//      and a fresh session announcing its own id through a resume path is
//      precisely the silent replacement the invariant prohibits. The readback is
//      a REQUIRED field of `ClaudeResumedSessionAttachment` (never an optional
//      one plus a presence check), so a transport that cannot report identity
//      cannot express a successful resume at all.
//   3. BY DISPOSAL — every refused attachment is disposed before the `failed`
//      arm is returned, so a refusal never leaves a second live Claude process
//      bound to the same canonical session.
//
// The DOMAIN half of resume verification — comparing `sessionPosition` against
// the daemon's RECORDED position, and the divergence reconciliation a mismatch
// triggers — is Spec-015's, not this layer's: it needs session state this driver
// does not carry. This file performs the checks it can actually perform.
//
// PORTS, NOT PROCESSES. Every provider-process concern (binary resolution and
// the version floor gate — T3.23; spawn-environment hygiene and the auth probe —
// T3.14; per-capability zero-turn detection — T3.24) sits behind the injected
// `ClaudeSessionTransport` / `ClaudeSessionChannel` ports declared below. This
// module spawns nothing, reads no environment variable, and therefore cannot
// echo, persist, or log a `CLAUDE_CODE_OAUTH_TOKEN`.
//
// Typed-error convention: mirrors `provider-registry.ts` — a `readonly code`
// literal drawn from the `driver.*` namespace already registered in
// `docs/architecture/contracts/error-contracts.md` §Driver (closed at seven),
// plus a structured `fields` bag. Internal validation errors (e.g.
// `ProviderOutputValidationError`) carry NO code — class identity
// discriminates; a dotted literal belongs only to registered wire/domain
// errors. PR-A mints NO new dotted code: `driver.unavailable` carries the
// driver-side refusals to service a session/run operation and
// `driver.capability_unsupported` carries a provider's typed control-request
// refusal ("registry membership is not availability"). A finer taxonomy is
// T3.14's P3-3 to register and re-home.

import {
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DriverAuthProbeResultSchema,
  DriverResumeResultSchema,
  type CallbackToolInvocation,
  type CallbackToolResult,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverResumeResult,
  type ExecutionPosture,
  type InterruptRunParams,
  type McpServerStatusProducer,
  type ProviderSessionHandle,
  type RecoveryCondition,
  type ResumeSessionParams,
  type RunId,
  type SessionCallbackTool,
  type SessionId,
  type StartRunParams,
  type SubagentPolicy,
} from "@ai-sidekicks/contracts";
import { createHash, randomUUID } from "node:crypto";

import { CLAUDE_DRIVER_NAME } from "./capabilities.js";

// --------------------------------------------------------------------------
// Canonical driver id + fixed message text
// --------------------------------------------------------------------------

// The driver's identity constant lives in `capabilities.ts` beside the registry
// it keys; this band imports it rather than declaring a second one, so a rename
// cannot leave the two disagreeing.

// The V1 driver-side span classification for EVERY resume failure. The halted
// span's CONTENT is not knowable at the driver boundary — the driver sees a
// refused attach, never the work the previous leg performed — and
// `unclassifiable` is the fail-closed member the consumer must handle exactly as
// `irreversible`. T3.14's resume-failure taxonomy (P3-3) is where a finer
// reading, if one is ever justified, belongs.
const CLAUDE_RESUME_SPAN_CLASSIFICATION = "unclassifiable" as const;

const UNDESCRIBED_FAILURE_DETAIL =
  "The Claude provider transport failed the resume with no describable detail.";

// --------------------------------------------------------------------------
// Transport ports — the seam between this driver band and the provider process
// --------------------------------------------------------------------------

// A single outbound participant-authored text frame. Deliberately a NARROW named
// shape rather than a writable stream handle: T3.18's driver-boundary text
// neutralization (I-005-7) adds its frame-origin discriminator here as an
// additive member and neutralizes inside the shared frame writer, which is
// impossible if callers hold a raw stream. This module therefore never composes
// a wire frame and never mutates participant text.
export interface ClaudeUserTextFrame {
  readonly text: string;
}

// The one control-request subtype this band drives. `interrupt` is censused at
// the pin; `cancel` is NOT a control-request subtype at all
// (`docs/reference/provider-wire/claude.md` §Control-request registry), which is
// why the cancel intent rides `cancelQueued` on this same request instead of a
// second subtype the CLI would refuse. `cancelQueued` is REQUIRED so a caller
// states the intent explicitly; realizing it against a build whose
// `system/init` capability tokens do not include `interrupt_cancel_queued_v1` is
// the transport's job (per-capability detection is T3.24).
export interface ClaudeInterruptControlRequest {
  readonly subtype: "interrupt";
  readonly cancelQueued: boolean;
}

// Widened by later Phase-3 tasks as they take ownership of further subtypes
// (T3.15's parity operations, T3.14's interactive-request plumbing). A closed
// union is the point: an unrouted subtype must not typecheck.
export type ClaudeControlRequest = ClaudeInterruptControlRequest;

// The already-correlated `control_response` payload. Request/response id
// correlation and read-to-EOF framing belong to the transport; this band sees
// only the settled answer, because what it must classify is the TYPED REFUSAL
// ("Unsupported control request subtype: ...", or a dispatcher arm reporting the
// callback is not registered) that the wire reference requires every driver to
// feature-detect at call time rather than infer from a version number.
export type ClaudeControlResponse =
  | { readonly subtype: "success"; readonly response?: Record<string, unknown> | undefined }
  | { readonly subtype: "error"; readonly error: string };

// Why a channel is being torn down. Passed to the transport so an INTENDED close
// is distinguishable from a crash — the seam T3.14's intended-close terminal
// suppression (P1-1) consumes. This band never suppresses an event itself.
export type ClaudeChannelDisposalReason =
  | "session_closed"
  | "spawn_identity_diverged"
  | "resume_identity_diverged"
  | "resume_result_invalid"
  // Anything that failed between the transport handing over a live channel and
  // that channel being registered — a throwing binding minter, a schema the
  // spawn-binding digest cannot canonicalize, a transport whose `onTurnTerminal`
  // rejects registration. Distinct from the identity arms because the provider
  // did nothing wrong: the driver could not complete adoption.
  | "establishment_failed";

// One live Claude provider process, already handshaken through `system/init`.
export interface ClaudeSessionChannel {
  readonly providerSessionId: string;
  sendUserText(frame: ClaudeUserTextFrame): Promise<void>;
  sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse>;

  /**
   * Registers the lifecycle's turn-terminal observer. Called EXACTLY ONCE, when
   * the driver adopts the channel; a later registration replaces the listener.
   *
   * TRANSPORT OBLIGATION — the transport MUST invoke `listener` when a terminal
   * stream frame (`result/success`, `result/error_*`) arrives for this session's
   * turn, and MUST NOT invoke it for any non-terminal frame. The driver has no
   * other way to learn that a turn ended: stream frames flow to the transport's
   * own consumer, not through this interface.
   *
   * Why the driver needs it at all: Claude's interrupt is CHANNEL-level, not
   * run-level. A run route that outlives its turn is therefore not a harmless
   * stale entry — it is an aimed weapon, and a late interrupt for the finished
   * run would land on whatever turn the channel is running now. The listener
   * retires the route so that interrupt refuses instead.
   *
   * The hook carries NO payload on purpose. The driver's response to every
   * terminal is the same (retire the route), so passing the discriminant would
   * hand this band a frame vocabulary it does not otherwise parse — the
   * normalizer owns frame content, and it is deliberately unwired here. The
   * transport already knows which terminal it saw; if a future caller needs the
   * distinction, widening one hook is a smaller change than unpicking a coupling.
   */
  onTurnTerminal(listener: () => void): void;

  /**
   * Tears the provider process down. `dispose` is this band's WHOLE teardown
   * surface: the driver holds no kill, no signal escalation, and no reaper, so
   * process supervision (SIGTERM then SIGKILL, exit confirmation, orphan sweep)
   * lives entirely behind this method in the transport implementation.
   *
   * TRANSPORT OBLIGATION — a `dispose` that REJECTS must retain supervision of
   * the underlying process and owns its eventual termination. The rejection is
   * a report, never a handoff: nothing above this interface can finish the job.
   *
   * What the driver does with a rejection depends on whose process it is:
   *
   *   * A channel bound to the session's OWN identity is retained in the
   *     lifecycle's quarantine, its slot is held against any further create or
   *     resume, and the next `closeSession` for that session retries THIS
   *     channel. The driver keeps a handle, so the transport has a retrier.
   *   * A REFUSED channel — one whose announced provider session id diverged
   *     from the pinned or resumed id — is deliberately NOT retained. It is
   *     bound to a foreign identity, so quarantining the session slot would
   *     punish the slot for someone else's process and leave create
   *     un-retryable after a divergence. The driver drops its reference and
   *     surfaces the rejection in the refusal error text only; no lifecycle
   *     operation ever revisits it. From that moment the transport is the sole
   *     owner of that process, which is what this obligation exists to pin.
   */
  dispose(reason: ClaudeChannelDisposalReason): Promise<void>;
}

// The spawn-bound parity legs, in ONE shape shared by the create and resume
// requests. Resume is a FRESH PROCESS SPAWN, so a leg bound at create and
// omitted at resume is silently shed — a posture-less relaunch runs UNSANDBOXED
// and a schema-less one unconstrained. Sharing the shape (and the single private
// builder below that fills it) makes that shedding structurally impossible here
// rather than a discipline the two call sites are asked to remember.
export interface ClaudeSpawnBoundLegs {
  readonly sessionId: SessionId;
  readonly admittedCostCapCents: number | undefined;
  readonly executionPosture: ExecutionPosture | undefined;
  readonly callbackTools: SessionCallbackTool[] | undefined;
  readonly subagentPolicy: SubagentPolicy | undefined;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly onCallbackToolCall:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  readonly onMcpServerStatus: McpServerStatusProducer | undefined;
}

export interface ClaudeSessionSpawnRequest extends ClaudeSpawnBoundLegs {
  // Pinned by the driver and passed to the CLI as `--session-id`, so the id the
  // process runs under is one the daemon chose. It is deliberately NOT the
  // daemon's `SessionId`: a session relaunch spawns a second process for the same
  // canonical session, and reusing the canonical id would collide with the leg
  // still shutting down.
  readonly providerSessionId: string;
  readonly config: Record<string, unknown>;
}

export interface ClaudeSessionResumeRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string;
}

export interface ClaudeSessionAttachment {
  // What the spawned process announced on `system/init`. Compared against the
  // pinned / requested id — never assumed to match.
  readonly providerSessionId: string;
  readonly channel: ClaudeSessionChannel;
}

export interface ClaudeResumedSessionAttachment extends ClaudeSessionAttachment {
  // REQUIRED, per I-005-5: a resume without a comparable position is
  // structurally inexpressible, so a transport cannot report a success it cannot
  // evidence.
  readonly sessionPosition: number;
}

/**
 * What a transport reports when the zero-turn auth probe found a usable credential.
 *
 * Resolving IS the authenticated verdict; there is no negative arm, because the
 * two negative outcomes are already carried by typed throws (see the port). A
 * three-armed reading would have given a transport a second way to say "logged
 * out" and this band two shapes to agree with each other about.
 */
export interface ClaudeAuthProbeReading {
  /**
   * Operator-facing, non-PII, and OPTIONAL — e.g. which credential source
   * answered.
   *
   * MUST NOT carry credential material or a seat email. The pinned CLI's
   * `CLAUDE_CODE_OAUTH_TOKEN` is a credential the wire reference says is never
   * to be echoed, persisted, or written to a workspace, and a probe detail is
   * all three waiting to happen. The driver contract bounds this at
   * `DRIVER_AUTH_DETAIL_MAX_LEN` and treats it as diagnostics only: `status`
   * alone carries the fail-closed admission decision.
   */
  readonly detail?: string | undefined;
}

export interface ClaudeSessionTransport {
  /**
   * Starts a provider process for a new session.
   *
   * SPAWN-ENVIRONMENT OBLIGATION (P0-4), owned here for the same reason the auth
   * probe is: THIS BAND SPAWNS NOTHING, so the only place the rule can bind is
   * the port. The child environment is CONSTRUCTED, never inherited — the
   * transport composes it from the curated base plus the run-provisioned
   * variables and strips the effective credential policy's denied names, and no
   * path spreads the daemon's own `process.env` into a child. It applies
   * identically to `resumeSession`, which is a fresh spawn and not a reattach.
   * Beneath it sits the provider-native layer this CLI needs: `CLAUDE_*` and
   * `CLAUDECODE*` are stripped so an ambient developer configuration cannot
   * reach an agent's process, and configuration is supplied through `--settings`
   * rather than the ambient `~/.claude`, so two sessions on one node cannot read
   * each other's settings.
   *
   * AUTH-FAILURE OBLIGATION, shared with `resumeSession` below (P3-3): a
   * DETERMINATE logged-out failure throws `ClaudeAuthenticationRequiredError`,
   * and every other failure throws anything else. That typed distinction is the
   * only route by which this band reports `reauth-required` instead of
   * `recovery-needed` — `classifyRecoveryCondition` keys on the class and never
   * on message text, so a transport that reported a logout as a generic error
   * would silently downgrade the operator's remediation to "reconcile by hand".
   */
  spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment>;
  /**
   * Re-attaches to an existing provider session.
   *
   * Carries the same auth-failure obligation as `spawnSession`: this is the call
   * whose rejection `#establishResumedSession` classifies, so an expired
   * credential MUST arrive as `ClaudeAuthenticationRequiredError`.
   */
  resumeSession(request: ClaudeSessionResumeRequest): Promise<ClaudeResumedSessionAttachment>;
  /**
   * The zero-turn authentication probe (P0-5), owned by the transport because
   * THIS BAND SPAWNS NOTHING.
   *
   * The pinned wire reference records that no authless protocol probe exists for
   * this provider: reaching a working `system/init` IS the authentication
   * evidence, and only the layer that can start a process can obtain it. So the
   * probe is a port obligation rather than a method here, and this band supplies
   * the classification instead.
   *
   * TRANSPORT OBLIGATIONS, all four load-bearing:
   *   1. It spends NO turn and admits no run. A probe that cost a turn would
   *      defeat its own purpose, which is to refuse admission before one is spent.
   *   2. It returns, logs, and persists NO credential material — in particular
   *      never the `CLAUDE_CODE_OAUTH_TOKEN` value, whether it read one or not.
   *   3. It throws `ClaudeAuthenticationRequiredError` for a DETERMINATE
   *      logged-out reading, and any other error for one it could not take. That
   *      typed distinction is the whole reason this band can report
   *      `unauthenticated` separately from `indeterminate` without sniffing a
   *      message string — the same rule `classifyRecoveryCondition` already
   *      applies on the resume path.
   *   4. Any process it starts is torn down before the returned promise settles,
   *      on every path including the throwing ones.
   */
  probeAuth(): Promise<ClaudeAuthProbeReading>;
}

// --------------------------------------------------------------------------
// Run dispatch resolution — the daemon-owned half of `startRun`
// --------------------------------------------------------------------------

// `StartRunParams` carries `runId` / `channelId` / `agentConfig` and NEITHER the
// owning `sessionId` NOR the run's opening text. Both are daemon-owned facts:
// the run-to-binding mapping lives in `runtime_bindings` (T2.2) and the opening
// content is composed by the daemon's run pipeline. Reading either out of the
// untyped `agentConfig` record would invent a key the corpus has not ratified,
// so this band asks for them through an injected port instead. The daemon wires
// the implementation; T3.18's frame writer later takes over composing the text.
export interface ClaudeRunDispatch {
  readonly sessionId: SessionId;
  readonly openingText: string;
}

export interface ClaudeRunDispatchResolver {
  resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined>;
}

// The read the intervention dispatcher (T3.7) needs, and the only coupling
// between the two bands — narrowed to one method so `intervention.ts` cannot
// reach session state it has no business mutating.
export interface ClaudeRunChannelLookup {
  findChannelForRun(runId: RunId): ClaudeSessionChannel | undefined;
}

// --------------------------------------------------------------------------
// Typed errors (both codes already registered in error-contracts.md §Driver)
// --------------------------------------------------------------------------

export type ClaudeSessionUnavailableReason =
  | "session_already_live"
  | "session_id_pin_diverged"
  | "no_live_session"
  | "no_live_run"
  | "run_dispatch_unresolved"
  | "cost_cap_mismatch"
  | "execution_posture_mismatch"
  | "output_schema_unbound"
  | "output_schema_mismatch";

const SESSION_UNAVAILABLE_MESSAGES: Readonly<Record<ClaudeSessionUnavailableReason, string>> = {
  session_already_live:
    "A live Claude session is already bound to this session; create would orphan it.",
  session_id_pin_diverged:
    "The spawned Claude process announced a session id other than the pinned one.",
  no_live_session: "No live Claude session is bound to this session.",
  no_live_run: "No live Claude session is bound to this run.",
  run_dispatch_unresolved: "The daemon resolved no Claude dispatch for this run.",
  cost_cap_mismatch:
    "The run's admitted cost cap does not match the cap the Claude session was spawned with.",
  // (A run declaring no cap is admitted into any session — see
  // `#assertSpawnBoundRealization`.)
  execution_posture_mismatch:
    "The run's execution posture does not match the posture the Claude session was spawned with.",
  output_schema_mismatch:
    "The run's output schema differs from the schema the Claude session was spawned with.",
  output_schema_unbound:
    "The run requires schema-constrained output but the Claude session was spawned without a schema.",
};

export interface ClaudeSessionUnavailableFields {
  readonly driverId: string;
  readonly reason: ClaudeSessionUnavailableReason;
  readonly sessionId: SessionId | undefined;
  readonly runId: RunId | undefined;
}

export interface ClaudeSessionUnavailableContext {
  readonly sessionId?: SessionId | undefined;
  readonly runId?: RunId | undefined;
  readonly detail?: string | undefined;
}

// Every driver-side refusal to service a session or run operation. Rides the
// REGISTERED `driver.unavailable` (503) rather than minting a code, because
// `error-contracts.md` is not this task's to edit and no registered member names
// a finer condition. The `reason` field carries the distinction operators need.
export class ClaudeSessionUnavailableError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: ClaudeSessionUnavailableFields;

  constructor(reason: ClaudeSessionUnavailableReason, context: ClaudeSessionUnavailableContext) {
    const detail = context.detail;
    super(
      detail === undefined
        ? SESSION_UNAVAILABLE_MESSAGES[reason]
        : `${SESSION_UNAVAILABLE_MESSAGES[reason]} ${detail}`,
    );
    this.name = "ClaudeSessionUnavailableError";
    this.fields = {
      driverId: CLAUDE_DRIVER_NAME,
      reason,
      sessionId: context.sessionId,
      runId: context.runId,
    };
  }
}

export interface ClaudeControlRequestRefusedFields {
  readonly driverId: string;
  readonly subtype: ClaudeControlRequest["subtype"];
  readonly providerError: string;
}

// A censused control subtype that the running dispatcher refused. The wire
// reference is explicit that registry membership is not availability and that a
// refusal arrives as a TYPED `control_response` error, so this is a runtime
// unsupported-capability answer — the registered `driver.capability_unsupported`
// (400), not an invented code.
export class ClaudeControlRequestRefusedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: ClaudeControlRequestRefusedFields;

  constructor(subtype: ClaudeControlRequest["subtype"], providerError: string) {
    super(`The Claude CLI refused the ${subtype} control request.`);
    this.name = "ClaudeControlRequestRefusedError";
    this.fields = { driverId: CLAUDE_DRIVER_NAME, subtype, providerError };
  }
}

// The marker a transport throws when the failure it hit is an expired or missing
// credential rather than a generic provider fault. It is the ONLY route by which
// a resume reports `reauth-required` instead of `recovery-needed` — two
// conditions with two different operator actions, which is why the classification
// must come from a typed signal and never from message-substring sniffing. The
// producing side is T3.14's auth probe / mid-run reauth route; this band is the
// consumer. Rides the registered `driver.not_authenticated` (409).
export class ClaudeAuthenticationRequiredError extends Error {
  readonly code = "driver.not_authenticated" as const;
  readonly fields: { readonly driverId: string };

  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthenticationRequiredError";
    this.fields = { driverId: CLAUDE_DRIVER_NAME };
  }
}

// --------------------------------------------------------------------------
// Detail sanitation
// --------------------------------------------------------------------------

// `name` and `message` are ordinary data properties on a normal `Error`, but
// nothing stops a value from backing either with an accessor — and a getter that
// throws would throw INSIDE the catch block that called us. Reads are therefore
// guarded, and a non-string value falls through rather than being stringified:
// `${anObject}` is how "[object Object]" — or a credential-bearing `toString` —
// reaches a durable row.
function readErrorStringProperty(error: Error, property: "message" | "name"): string | undefined {
  try {
    const value: unknown = error[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Renders an arbitrary thrown value as one operator-safe line.
 *
 * CONTRACT: TOTAL over arbitrary JavaScript values — it returns a string for
 * every input and throws for none. That totality is load-bearing rather than
 * tidy: every caller is a `catch` block, and `#disposeRefusedChannel`'s entire
 * job is to not throw, so a `describeFailure` that could throw would defeat the
 * guard calling it and re-open the orphaned-process window one layer up.
 *
 * NEVER serializes an arbitrary value. `providerFailureDetail` is persisted and
 * operator-visible, and a blind `JSON.stringify` of an unknown rejection reason
 * is how spawn configuration — up to and including credential material the
 * transport was handed — leaks into a durable row. For the same reason there is
 * no `String(error)` and no `String(error.cause)` fallback: an unreadable value
 * is reported as undescribable, never rendered on a best-effort basis.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const name = readErrorStringProperty(error, "name");
    const message = readErrorStringProperty(error, "message");
    if (message !== undefined && message.length > 0) {
      // An unreadable name costs the prefix, not the whole detail.
      return name !== undefined && name.length > 0 ? `${name}: ${message}` : message;
    }
    if (name !== undefined && name.length > 0) {
      return name;
    }
    return UNDESCRIBED_FAILURE_DETAIL;
  }
  if (typeof error === "string") {
    return error;
  }
  return UNDESCRIBED_FAILURE_DETAIL;
}

// `wireFreeFormString` demands 1..MAX characters, at least one non-whitespace
// character, and no NUL byte. Trimming first means the truncation below can
// never leave a whitespace-only remainder.
function sanitizeFailureDetail(detail: string): string {
  const trimmed = detail.replaceAll("\0", "").trim();
  if (trimmed.length === 0) {
    return UNDESCRIBED_FAILURE_DETAIL;
  }
  return trimmed.length <= DRIVER_FAILURE_DETAIL_MAX_LEN
    ? trimmed
    : trimmed.slice(0, DRIVER_FAILURE_DETAIL_MAX_LEN);
}

/**
 * Builds a probe result, TOTALLY — an over-long or refused detail never throws.
 *
 * `DRIVER_AUTH_DETAIL_MAX_LEN` is two orders of magnitude tighter than the
 * failure-detail bound `sanitizeFailureDetail` cuts to, so a sanitized cause
 * still needs its own trim before the strict envelope sees it. When the envelope
 * refuses even the trimmed string the detail is DROPPED rather than allowed to
 * throw: `status` carries the fail-closed admission decision and the detail only
 * tells an operator why, so losing it costs diagnostics and never correctness.
 */
function buildAuthProbeResult(
  status: DriverAuthProbeResult["status"],
  detail: string,
): DriverAuthProbeResult {
  const sanitized = sanitizeFailureDetail(detail);
  const bounded =
    sanitized.length > DRIVER_AUTH_DETAIL_MAX_LEN
      ? sanitized.slice(0, DRIVER_AUTH_DETAIL_MAX_LEN)
      : sanitized;
  const parsed = DriverAuthProbeResultSchema.safeParse({ status, detail: bounded });
  return parsed.success ? parsed.data : DriverAuthProbeResultSchema.parse({ status });
}

// Stands in when a transport reports an authenticated reading with no detail of
// its own. Names the EVIDENCE rather than asserting a credential source the
// probe did not report: the pinned CLI publishes no authless protocol probe, so
// reaching a working provider handshake is the whole of what an authenticated
// verdict rests on, and the detail should not imply more than that.
const CLAUDE_AUTH_PROBE_REACHED_DETAIL = "the provider answered the zero-turn auth probe";

function classifyRecoveryCondition(error: unknown): RecoveryCondition {
  return error instanceof ClaudeAuthenticationRequiredError ? "reauth-required" : "recovery-needed";
}

// --------------------------------------------------------------------------
// Live-session bookkeeping
// --------------------------------------------------------------------------

// The spawn-bound realization of the surfaces Claude binds AT PROCESS SPAWN,
// recorded so `startRun` can refuse a run whose per-run realization disagrees
// (see `#assertSpawnBoundRealization`). Only the closed-literal axes are kept:
// they are the sandbox-defeating ones, and comparing them needs no canonical
// serializer whose key ordering could manufacture a false refusal.
// The axes of `ExecutionPosture` that a spawn realizes, in the order a mismatch
// is reported. Enumerated from the contract type rather than sampled: the type is
// an intersection of two discriminated unions, so `allowedDomains` exists only on
// the `allowed-domains` network arm and `credentialPolicyRef` only on the two
// sandboxed mode arms. Comparing a subset would admit a run into a process whose
// sandbox differs on an axis nobody checked, and the run's recorded effective
// posture would then be a lie.
//
// `allowedDomains` and `writableRoots` are SETS — a caller that lists the same
// roots in a different order has declared the same posture, so they compare
// order-insensitively. Every other axis is a scalar and compares strictly.
const CLAUDE_POSTURE_SCALAR_AXES = [
  "mode",
  "networkAccess",
  "credentialPolicyRef",
  "profileName",
] as const;
const CLAUDE_POSTURE_SET_AXES = ["allowedDomains", "writableRoots"] as const;

type ClaudePostureScalarAxis = (typeof CLAUDE_POSTURE_SCALAR_AXES)[number];
type ClaudePostureSetAxis = (typeof CLAUDE_POSTURE_SET_AXES)[number];

function readPostureScalarAxis(
  posture: ExecutionPosture,
  axis: ClaudePostureScalarAxis,
): string | undefined {
  // Each axis is read through the union-widened view rather than a direct member
  // access: `credentialPolicyRef` is typed `never` on the `trusted` arm and
  // `profileName` is optional, so neither is reachable on the bare union.
  const widened = posture as Partial<Record<ClaudePostureScalarAxis, string>>;
  return widened[axis];
}

function readPostureSetAxis(
  posture: ExecutionPosture,
  axis: ClaudePostureSetAxis,
): readonly string[] | undefined {
  const widened = posture as Partial<Record<ClaudePostureSetAxis, readonly string[]>>;
  return widened[axis];
}

// Order-insensitive, multiplicity-sensitive. A duplicate is a real difference:
// two identical writable roots and one are not the same declaration, and
// silently collapsing them would be this finding's mistake in miniature.
function postureSetAxisDiffers(
  runValue: readonly string[] | undefined,
  spawnValue: readonly string[] | undefined,
): boolean {
  if (runValue === undefined || spawnValue === undefined) {
    return runValue !== spawnValue;
  }
  if (runValue.length !== spawnValue.length) {
    return true;
  }
  const sortedRun = [...runValue].sort();
  const sortedSpawn = [...spawnValue].sort();
  return sortedRun.some((entry, index) => entry !== sortedSpawn[index]);
}

// Names the FIRST axis on which a run-declared posture diverges from the posture
// its session was spawned under, or `undefined` when every axis agrees.
function findPostureDivergence(
  runPosture: ExecutionPosture,
  spawnPosture: ExecutionPosture,
): string | undefined {
  for (const axis of CLAUDE_POSTURE_SCALAR_AXES) {
    const runValue = readPostureScalarAxis(runPosture, axis);
    const spawnValue = readPostureScalarAxis(spawnPosture, axis);
    if (runValue !== spawnValue) {
      return `${axis} (run ${String(runValue)}, session ${String(spawnValue)})`;
    }
  }
  for (const axis of CLAUDE_POSTURE_SET_AXES) {
    const runValue = readPostureSetAxis(runPosture, axis);
    const spawnValue = readPostureSetAxis(spawnPosture, axis);
    if (postureSetAxisDiffers(runValue, spawnValue)) {
      return `${axis} (run ${JSON.stringify(runValue)}, session ${JSON.stringify(spawnValue)})`;
    }
  }
  return undefined;
}

// A stable serialization: object keys sorted recursively, array order PRESERVED.
// Array order is semantic in JSON Schema (`prefixItems`, `allOf` short-circuit
// order), so sorting arrays would call two different schemas equal. Keys are
// emitted through `JSON.stringify` so escaping is the platform's problem, and
// `undefined`-valued keys are dropped because `JSON.stringify` drops them too —
// a schema object cannot distinguish an absent key from one set to `undefined`.
function canonicalizeJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    // Code-unit ordering, deliberately not `localeCompare`: a digest whose key
    // order depends on the host locale is not deterministic.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeJsonValue(entryValue)}`)
    .join(",")}}`;
}

// Identity for an output schema. A boolean "is one bound?" admits a run carrying
// schema B into a process spawned with schema A — the provider would then
// constrain output to a shape the run never asked for.
function digestOutputSchema(outputSchema: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJsonValue(outputSchema)).digest("hex");
}

interface ClaudeSpawnBinding {
  readonly admittedCostCapCents: number | undefined;
  // The COMPLETE posture the process was spawned under, retained so every axis
  // can be compared. Storing a projection is what let axes drift unchecked.
  readonly executionPosture: ExecutionPosture | undefined;
  readonly outputSchemaDigest: string | undefined;
}

interface LiveClaudeSession {
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly channel: ClaudeSessionChannel;
  readonly spawnBinding: ClaudeSpawnBinding;
}

// The state of one canonical session's slot. Absence from `#sessionSlots` is the
// fifth state, EMPTY — the only one in which a create or resume may proceed.
//
// This is ONE registry on purpose. An earlier revision kept three maps (live,
// establishing, quarantined) and answered "is this slot taken?" by querying all
// three; the bug that shape produced was structural rather than local — a slot
// mid-disposal belonged to no map, so it read as EMPTY for the whole `dispose`
// await and a concurrent create spawned a replacement beside a process that was
// still dying. A union in a single map makes the states exhaustive: a new state
// is a new arm the compiler forces every reader to handle, not a fourth map some
// reader forgets to consult.
//
// THE RULE, stated once: a slot is HELD from the moment an operation claims it
// until that operation's LAST await has settled. No transition is observable
// mid-flight. Every arm that owns an in-flight transition therefore carries a
// `settled` promise that resolves — never rejects — when the transition ends.
type ClaudeSessionSlot =
  // A create or resume is bringing a process up. Ends LIVE, or EMPTY if it fails.
  | { readonly state: "establishing"; readonly settled: Promise<void> }
  // A process is up and may accept runs. The only startable state.
  | { readonly state: "live"; readonly session: LiveClaudeSession }
  // `dispose` is in flight. Ends EMPTY on resolve, QUARANTINED on reject.
  | { readonly state: "closing"; readonly settled: Promise<void> }
  // `dispose` rejected: the process is still alive and this channel is the only
  // handle anyone holds on it. Retained until a later close disposes it.
  | { readonly state: "quarantined"; readonly channel: ClaudeSessionChannel };

export interface ClaudeSessionLifecycleDependencies {
  readonly transport: ClaudeSessionTransport;
  readonly runDispatchResolver: ClaudeRunDispatchResolver;
  // The provider-side session id pinned at spawn (`--session-id`). Injected so
  // tests and a future deterministic id source can drive it; defaults to a v4
  // UUID, the shape the CLI flag requires.
  readonly mintProviderSessionId?: (() => string) | undefined;
  // The opaque session-binding handle the `resumed` arm carries. The daemon's
  // `runtime_bindings` store mints it in production; the default keeps this band
  // runnable without a database.
  readonly mintBindingId?: (() => string) | undefined;
}

export class ClaudeSessionLifecycle implements ClaudeRunChannelLookup {
  readonly #transport: ClaudeSessionTransport;
  readonly #runDispatchResolver: ClaudeRunDispatchResolver;
  readonly #mintProviderSessionId: () => string;
  readonly #mintBindingId: () => string;
  // The single source of truth for every canonical session's slot. See
  // `ClaudeSessionSlot` for the five states and the holding rule.
  //
  // ONE coherent contention mechanism, stated here so the two sides cannot drift:
  //
  //   * `createSession` / `resumeSession` REFUSE on any non-EMPTY slot. They never
  //     chain, because the winner's spawn-bound legs (cap, posture, schema) are
  //     not the loser's — handing back a session realized under someone else's
  //     posture is the swap `#assertSpawnBoundRealization` exists to prevent.
  //   * `closeSession` CHAINS: it awaits whatever transition is in flight and
  //     re-reads, because "make this session not exist" is satisfiable no matter
  //     which state the slot settles into, and refusing a close would leave the
  //     caller no way to reach a process it must be able to stop.
  //
  // Claims are taken SYNCHRONOUSLY — between reading a slot and writing its next
  // state there is never an await — which is what makes check-then-act atomic on
  // a single-threaded runtime.
  readonly #sessionSlots: Map<SessionId, ClaudeSessionSlot> = new Map();
  readonly #sessionIdByRunId: Map<RunId, SessionId> = new Map();

  constructor(dependencies: ClaudeSessionLifecycleDependencies) {
    this.#transport = dependencies.transport;
    this.#runDispatchResolver = dependencies.runDispatchResolver;
    this.#mintProviderSessionId = dependencies.mintProviderSessionId ?? randomUUID;
    this.#mintBindingId = dependencies.mintBindingId ?? randomUUID;
  }

  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Fail closed rather than replacing: an existing live channel was spawned
    // with ITS OWN posture / cap / schema, so silently swapping it for a new one
    // would both orphan a process and re-realize the spawn-bound legs behind the
    // daemon's back. A create racing another create — or a resume — for the same
    // canonical session is the same fault seen a moment earlier, so it takes the
    // same refusal rather than a second one.
    const slotHolder = this.#describeSlotHolder(params.sessionId);
    if (slotHolder !== undefined) {
      throw new ClaudeSessionUnavailableError("session_already_live", {
        sessionId: params.sessionId,
        detail: slotHolder,
      });
    }

    return await this.#withSessionSlotClaimed(
      params.sessionId,
      async () => await this.#establishCreatedSession(params),
    );
  }

  async #establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    const pinnedProviderSessionId = this.#mintProviderSessionId();
    const attachment = await this.#transport.spawnSession({
      ...this.#buildSpawnBoundLegs(params),
      providerSessionId: pinnedProviderSessionId,
      config: params.config,
    });

    if (attachment.providerSessionId !== pinnedProviderSessionId) {
      const disposalNote = await this.#disposeRefusedChannel(
        attachment.channel,
        "spawn_identity_diverged",
      );
      throw new ClaudeSessionUnavailableError("session_id_pin_diverged", {
        sessionId: params.sessionId,
        detail: `Pinned ${pinnedProviderSessionId}, announced ${attachment.providerSessionId}.${disposalNote}`,
      });
    }

    // ADOPTION INVARIANT — between the transport handing us a live channel and
    // that channel being registered, EVERY exit (return or throw) either
    // registers the channel or disposes it. There is no third exit. Without this
    // guard a throw in the window escapes past both, the outer slot claim clears
    // the slot in its settle path, and the still-running process is orphaned with
    // its slot free — so the next create spawns a second process beside it.
    //
    // The window is not empty: `#buildSpawnBinding` digests a caller-supplied
    // output schema (a cyclic or unserializable one throws) and
    // `#registerLiveSession` calls transport-implemented `onTurnTerminal`.
    try {
      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: this.#buildSpawnBinding(params),
      });
    } catch (error) {
      // Dispose, then re-throw the ORIGINAL cause. `createSession` has no
      // degraded arm — throwing is its only failure channel, and it already
      // propagates raw transport errors — so wrapping would hide the real fault
      // behind a reason arm no caller could act on differently.
      await this.#disposeRefusedChannel(attachment.channel, "establishment_failed");
      throw error;
    }

    // Claude resumes by session id (`--resume <session-id>`), so the resume
    // handle IS the provider session id at this pin. The daemon treats it as
    // opaque, which is what lets a future provider hand back something else.
    return {
      providerSessionId: attachment.providerSessionId,
      resumeHandle: attachment.providerSessionId,
    };
  }

  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Resuming beside a live channel for the same canonical session is the
    // silent-replacement shape from the other direction: two Claude processes,
    // one canonical run. Refuse through the `failed` arm — never by throwing,
    // because the contract's failure channel for resume IS that arm. An
    // establishment already in flight is refused identically: the winner's
    // spawn-bound legs are not this caller's, so handing back its handle would be
    // the realization swap `#assertSpawnBoundRealization` exists to prevent.
    const slotHolder = this.#describeSlotHolder(params.sessionId);
    if (slotHolder !== undefined) {
      return this.#buildResumeFailure(
        "recovery-needed",
        `${slotHolder} Resuming beside it would replace it silently.`,
      );
    }

    return await this.#withSessionSlotClaimed(
      params.sessionId,
      async () => await this.#establishResumedSession(params),
    );
  }

  async #establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    let attachment: ClaudeResumedSessionAttachment;
    try {
      attachment = await this.#transport.resumeSession({
        ...this.#buildSpawnBoundLegs(params),
        resumeHandle: params.resumeHandle,
      });
    } catch (error) {
      return this.#buildResumeFailure(classifyRecoveryCondition(error), describeFailure(error));
    }

    // I-005-5's identity gate. Claude answers a resume it cannot honour (a
    // working-directory mismatch is the documented case) by starting a FRESH
    // session, which announces its own id. Adopting that session would be the
    // silent replacement.
    if (attachment.providerSessionId !== params.resumeHandle) {
      const disposalNote = await this.#disposeRefusedChannel(
        attachment.channel,
        "resume_identity_diverged",
      );
      return this.#buildResumeFailure(
        "recovery-needed",
        `Resume handle ${params.resumeHandle} was answered by session ${attachment.providerSessionId}; the provider started a replacement session rather than resuming.${disposalNote}`,
      );
    }

    // ADOPTION INVARIANT — from here to registration, EVERY exit (return or
    // throw) either registers the channel or disposes it. There is no third exit.
    //
    // The window contains three things that can throw, none of them the
    // provider's doing: the injected binding minter, `#buildSpawnBinding`'s
    // digest of a caller-supplied output schema, and the transport's own
    // `onTurnTerminal`. An escaping throw would be doubly wrong here — the outer
    // slot claim clears the slot in its settle path, orphaning a process that is
    // resumed and running while the next create spawns beside it, AND resume's
    // contractual failure channel is the `failed` ARM, so a raw throw reaches a
    // caller that has no arm for it.
    let validatedResumeResult: DriverResumeResult;
    try {
      const resumed: DriverResumeResult = {
        status: "resumed",
        bindingId: this.#mintBindingId(),
        sessionPosition: attachment.sessionPosition,
      };
      // An out-of-contract `resumed` arm (a non-integer or negative position, an
      // unusable binding id) is ITSELF a provider failure and must surface
      // `recovery-needed` rather than parse-rejecting into an exception the
      // resume caller has no arm for.
      const validated = DriverResumeResultSchema.safeParse(resumed);
      if (!validated.success) {
        const disposalNote = await this.#disposeRefusedChannel(
          attachment.channel,
          "resume_result_invalid",
        );
        return this.#buildResumeFailure(
          "recovery-needed",
          `The Claude transport reported a resume that fails the driver resume contract: ${validated.error.message}${disposalNote}`,
        );
      }
      validatedResumeResult = validated.data;

      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: this.#buildSpawnBinding(params),
      });
    } catch (error) {
      const disposalNote = await this.#disposeRefusedChannel(
        attachment.channel,
        "establishment_failed",
      );
      // `recovery-needed`, not `reauth-required`: the resume itself SUCCEEDED —
      // the daemon simply could not adopt what it got back — so re-authenticating
      // would answer a question nobody asked. Retrying is the recovery.
      return this.#buildResumeFailure(
        "recovery-needed",
        `The Claude session resumed but could not be adopted: ${describeFailure(error)}${disposalNote}`,
      );
    }
    return validatedResumeResult;
  }

  async startRun(params: StartRunParams): Promise<void> {
    const dispatch = await this.#runDispatchResolver.resolveRunDispatch(params);
    if (dispatch === undefined) {
      throw new ClaudeSessionUnavailableError("run_dispatch_unresolved", { runId: params.runId });
    }

    const live = this.#findLiveSession(dispatch.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    this.#assertSpawnBoundRealization(params, live);

    // Bind BEFORE the frame is written: once the text is on the wire the turn may
    // already be running, and an interrupt racing the write must find a route.
    // A failed write deliberately LEAVES the binding — an interruptible run the
    // daemon can stop is strictly safer than a turn that may exist with no route
    // to it.
    this.#sessionIdByRunId.set(params.runId, dispatch.sessionId);
    await live.channel.sendUserText({ text: dispatch.openingText });
  }

  /**
   * Zero-turn authentication probe (P0-5). NEVER throws.
   *
   * The classification, and nothing else: the transport owns the observation
   * (this band spawns no process and reads no environment variable, which is why
   * it could not obtain one), and this method maps the three ways that
   * observation can land onto the contract's three-value result.
   *
   *   resolved                              -> `authenticated`
   *   `ClaudeAuthenticationRequiredError`   -> `unauthenticated`
   *   any other throw                       -> `indeterminate`
   *
   * The last arm is fail-closed for admission and still distinguishable from the
   * middle one, which is the distinction the three-value enum exists to keep: an
   * operator must be able to tell a logged-out provider from a probe that could
   * not run. Claiming `unauthenticated` for an unhealthy probe would send them to
   * re-authenticate a credential that was never in question.
   *
   * NO SESSION SLOT is claimed. The probe holds no session id, installs no live
   * session, and starts no run, so it cannot refuse a concurrent create or close
   * — and a `probeAuth` that queued behind a session transition would stall the
   * very admission check it exists to make cheap.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    try {
      const reading = await this.#transport.probeAuth();
      return buildAuthProbeResult(
        "authenticated",
        reading.detail ?? CLAUDE_AUTH_PROBE_REACHED_DETAIL,
      );
    } catch (cause) {
      // Typed, never sniffed — the same rule the resume path's recovery
      // classification follows, and for the same reason: a message-substring
      // test would silently reclassify on any provider wording change.
      return buildAuthProbeResult(
        cause instanceof ClaudeAuthenticationRequiredError ? "unauthenticated" : "indeterminate",
        describeFailure(cause),
      );
    }
  }

  async interruptRun(params: InterruptRunParams): Promise<void> {
    const channel = this.findChannelForRun(params.runId);
    if (channel === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId: params.runId });
    }
    // `params.reason` is deliberately dropped rather than forwarded: the pinned
    // CLI's `interrupt` control request carries no reason member, and inventing
    // one would be an unregistered wire field. The reason is the daemon's own
    // audit record, not provider input.
    //
    // `interruptRun` returns `void`: it has no `degraded` arm, so a typed refusal
    // can only be reported by throwing. Reporting success here would tell the
    // daemon a run was interrupted that is still producing tokens.
    const response = await channel.sendControlRequest({
      subtype: "interrupt",
      cancelQueued: false,
    });
    if (response.subtype === "error") {
      throw new ClaudeControlRequestRefusedError("interrupt", response.error);
    }
  }

  async closeSession(params: CloseSessionParams): Promise<void> {
    // Close CHAINS rather than refusing (the field doc states why): it awaits any
    // in-flight transition, then re-reads, because the slot may have settled into
    // a different state than the one it started waiting on — an establishment can
    // finish LIVE, a concurrent close can finish EMPTY, and a failed close can
    // finish QUARANTINED.
    for (;;) {
      const slot = this.#sessionSlots.get(params.sessionId);
      // EMPTY. Idempotent: closing an already-closed session is the teardown
      // path's normal double-call, not a fault.
      if (slot === undefined) {
        return;
      }
      // Exhaustive over the union: a new slot state cannot be added without
      // deciding here whether a close chains on it or acts on it.
      switch (slot.state) {
        case "establishing":
        case "closing":
          // Chain, then re-read — the slot may settle into any other state.
          await slot.settled;
          continue;
        case "live":
          // The slot is settled and occupied, so this call is the actor.
          // Everything from here to the CLOSING write inside
          // `#disposeHeldChannel` is SYNCHRONOUS, so no second closer can
          // observe this same settled state and act on it too.
          //
          // Routes go first and unconditionally: a route pointing into a process
          // that is being torn down would aim a later interrupt at a dead run.
          this.#retireRunRoutes(params.sessionId);
          await this.#disposeHeldChannel(params.sessionId, slot.session.channel);
          return;
        case "quarantined":
          // Retry THIS retained channel. It is the only handle anyone still
          // holds on a process that would not exit.
          await this.#disposeHeldChannel(params.sessionId, slot.channel);
          return;
      }
    }
  }

  // Disposes a channel with the slot HELD for the whole await. The CLOSING state
  // is written before `dispose` is even called, so there is no instant at which
  // the slot reads EMPTY while a process is still dying — the window an earlier
  // revision left open, through which a concurrent create spawned a replacement
  // and a later quarantine installed itself beside the new live channel.
  async #disposeHeldChannel(sessionId: SessionId, channel: ClaudeSessionChannel): Promise<void> {
    let markSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#sessionSlots.set(sessionId, { state: "closing", settled });
    try {
      await channel.dispose("session_closed");
      // CLOSING -> EMPTY.
      this.#sessionSlots.delete(sessionId);
    } catch (error) {
      // CLOSING -> QUARANTINED. The channel is retained rather than dropped: the
      // process is still running and nothing else holds a reference to it. The
      // rejection still propagates — a provider process that would not exit is
      // not something to swallow.
      this.#sessionSlots.set(sessionId, { state: "quarantined", channel });
      throw error;
    } finally {
      // Runs after the state write on BOTH paths, so a chainer resuming on this
      // promise always observes the settled state rather than the transition.
      markSettled();
    }
  }

  findChannelForRun(runId: RunId): ClaudeSessionChannel | undefined {
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.#findLiveSession(sessionId)?.channel;
  }

  // A slot yields a session only in the LIVE state. Establishing, closing, and
  // quarantined slots deliberately answer `undefined`: no run may start in a
  // process that is coming up, going down, or refusing to die.
  #findLiveSession(sessionId: SessionId): LiveClaudeSession | undefined {
    const slot = this.#sessionSlots.get(sessionId);
    return slot?.state === "live" ? slot.session : undefined;
  }

  // The ONE builder both spawn paths use — see `ClaudeSpawnBoundLegs`.
  #buildSpawnBoundLegs(params: CreateSessionParams | ResumeSessionParams): ClaudeSpawnBoundLegs {
    return {
      sessionId: params.sessionId,
      admittedCostCapCents: params.admittedCostCapCents,
      executionPosture: params.executionPosture,
      callbackTools: params.callbackTools,
      subagentPolicy: params.subagentPolicy,
      outputSchema: params.outputSchema,
      onCallbackToolCall: params.onCallbackToolCall,
      onMcpServerStatus: params.onMcpServerStatus,
    };
  }

  #buildSpawnBinding(params: CreateSessionParams | ResumeSessionParams): ClaudeSpawnBinding {
    const outputSchema = params.outputSchema;
    return {
      admittedCostCapCents: params.admittedCostCapCents,
      executionPosture: params.executionPosture,
      outputSchemaDigest: outputSchema === undefined ? undefined : digestOutputSchema(outputSchema),
    };
  }

  // Claude binds the cap, the posture, and the output schema AT SPAWN. A run
  // admitted against a different realization must force a session-boundary
  // relaunch — which is the daemon's decision — so the driver's job is to refuse
  // rather than to start the run under whatever the process happens to carry.
  // Never a start-in-uncapped, never a silent partial posture application.
  //
  // Each check is ONE-DIRECTIONAL, keyed on what the RUN declares. A run that
  // declares nothing on an axis is not constrained on it.
  #assertSpawnBoundRealization(params: StartRunParams, live: LiveClaudeSession): void {
    // `Spec-016 §Cost Derivation And Absent-Cost Semantics` states this rule in
    // exactly one direction: "a native-cap run **starts only inside a provider
    // session spawned with the matching cap**: an existing uncapped (or
    // differently-capped) process forces a capped relaunch ... never a start
    // inside an uncapped process." The converse — a run carrying NO cap inside a
    // capped session — is deliberately not prohibited: the same section wires the
    // native cap "as defense-in-depth beneath this accountant, never as the
    // accountant", so the daemon accountant is the enforcement, and a provider
    // stop on such a run surfaces as an ordinary visible provider stop. Refusing
    // it here would permanently strand every capless run in a capped session,
    // forcing relaunches no spec sentence orders.
    const runCostCapCents = params.admittedCostCapCents;
    if (
      runCostCapCents !== undefined &&
      runCostCapCents !== live.spawnBinding.admittedCostCapCents
    ) {
      throw new ClaudeSessionUnavailableError("cost_cap_mismatch", {
        sessionId: live.sessionId,
        runId: params.runId,
        detail: `Run cap ${String(runCostCapCents)}, session cap ${String(live.spawnBinding.admittedCostCapCents)}.`,
      });
    }

    const runPosture = params.executionPosture;
    if (runPosture !== undefined) {
      const spawnPosture = live.spawnBinding.executionPosture;
      if (spawnPosture === undefined) {
        throw new ClaudeSessionUnavailableError("execution_posture_mismatch", {
          sessionId: live.sessionId,
          runId: params.runId,
          detail: `The run declares execution posture ${runPosture.mode}, but the Claude session was spawned with none.`,
        });
      }
      const divergentAxis = findPostureDivergence(runPosture, spawnPosture);
      if (divergentAxis !== undefined) {
        throw new ClaudeSessionUnavailableError("execution_posture_mismatch", {
          sessionId: live.sessionId,
          runId: params.runId,
          detail: `Execution posture diverges on ${divergentAxis}.`,
        });
      }
    }

    const runOutputSchema = params.outputSchema;
    if (runOutputSchema !== undefined) {
      const spawnOutputSchemaDigest = live.spawnBinding.outputSchemaDigest;
      if (spawnOutputSchemaDigest === undefined) {
        throw new ClaudeSessionUnavailableError("output_schema_unbound", {
          sessionId: live.sessionId,
          runId: params.runId,
        });
      }
      const runOutputSchemaDigest = digestOutputSchema(runOutputSchema);
      if (runOutputSchemaDigest !== spawnOutputSchemaDigest) {
        throw new ClaudeSessionUnavailableError("output_schema_mismatch", {
          sessionId: live.sessionId,
          runId: params.runId,
          detail: `Run schema digest ${runOutputSchemaDigest.slice(0, 16)}, session schema digest ${spawnOutputSchemaDigest.slice(0, 16)}.`,
        });
      }
    }
  }

  #registerLiveSession(live: LiveClaudeSession): void {
    // Listener FIRST, slot SECOND. `onTurnTerminal` is transport-implemented and
    // may throw; registering it before the slot is written means such a throw
    // leaves the slot UNSET, so the caller's adoption guard can dispose the
    // channel and free the slot. The reverse order would strand a LIVE slot
    // pointing at a channel its own caller is about to dispose. The listener is
    // identity-gated, so it is inert in the instant before the slot exists.
    //
    // Claude serializes turns per session, so "a terminal arrived on this
    // channel" identifies the run without the transport naming it: the route
    // pointing at this session IS the run that just ended. Registered here, the
    // one place both establishment paths converge on.
    //
    // Retiring routes only — never the slot. The session stays LIVE and startable
    // after a turn ends; it is the RUN that is over.
    const retireOnTurnTerminal = (): void => {
      // Identity-gated. A channel that has been disposed, quarantined, or
      // replaced can still fire — the driver holds no kill, so an undead process
      // may emit a terminal long after the daemon stopped listening to it — and
      // an ungated listener would then retire the routes of whatever session
      // occupies this slot NOW. Only the channel that is currently live may
      // retire, which also makes the listener a no-op during CLOSING (routes are
      // already gone) rather than a second writer racing the close.
      if (this.#findLiveSession(live.sessionId)?.channel !== live.channel) {
        return;
      }
      this.#retireRunRoutes(live.sessionId);
    };
    live.channel.onTurnTerminal(retireOnTurnTerminal);
    this.#sessionSlots.set(live.sessionId, { state: "live", session: live });
  }

  // Names the current holder of a session slot for a refusal detail, or
  // `undefined` when the slot is free. One predicate, so the two entry points
  // cannot drift into disagreeing about what "taken" means.
  #describeSlotHolder(sessionId: SessionId): string | undefined {
    const slot = this.#sessionSlots.get(sessionId);
    if (slot === undefined) {
      return undefined;
    }
    // Exhaustive over the union: adding a state without deciding what a create
    // racing it should see stops compiling here.
    switch (slot.state) {
      case "live":
        return `A live Claude session is already bound to session ${sessionId};`;
      case "establishing":
        return `A create or resume for session ${sessionId} is already in flight;`;
      case "closing":
        return `A close for session ${sessionId} is still disposing its Claude process;`;
      case "quarantined":
        return `The Claude process for session ${sessionId} refused to exit and is quarantined pending a successful close;`;
    }
  }

  // Claims the slot synchronously, runs the establishment, and releases the claim
  // however it settles. The claim is published BEFORE `establish` is awaited, so
  // no other caller can observe a free slot while this one is spawning.
  async #withSessionSlotClaimed<TEstablished>(
    sessionId: SessionId,
    establish: () => Promise<TEstablished>,
  ): Promise<TEstablished> {
    const establishment = establish();
    // A rejection-swallowed view: chainers await this purely to sequence, and a
    // stored promise that could reject would surface as an unhandled rejection
    // whenever nobody closes the session.
    const settled = establishment.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionSlots.set(sessionId, { state: "establishing", settled });
    try {
      return await establishment;
    } finally {
      // A SUCCESSFUL establishment has already overwritten this slot with its
      // LIVE arm, so only a failed one is cleared here. Identity-checked so this
      // can never clear a claim that is not ours.
      const slot = this.#sessionSlots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#sessionSlots.delete(sessionId);
      }
    }
  }

  // Drops every run route pointing at this session. Deliberately does NOT touch
  // the slot: route retirement and slot transition are separate concerns, and
  // fusing them is what previously let a close free the slot as a side effect of
  // clearing routes.
  #retireRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }

  #buildResumeFailure(condition: RecoveryCondition, detail: string): DriverResumeResult {
    return {
      status: "failed",
      recoveryCondition: condition,
      recoverySpanClassification: CLAUDE_RESUME_SPAN_CLASSIFICATION,
      providerFailureDetail: sanitizeFailureDetail(detail),
    };
  }

  // Disposal of a channel we are refusing to adopt. The refusal is the
  // load-bearing signal, so a disposal failure must not mask it — it is folded
  // into the operator-visible detail instead of being swallowed or rethrown.
  // Disposes a channel the driver is REFUSING to adopt, and answers with a note
  // for the refusal text. The rejection is deliberately not rethrown: the caller
  // is already failing for a better reason (the identity divergence), and
  // replacing that with a teardown error would hide why the session was refused.
  //
  // Nothing is retained. That is a decision, not an oversight — the process
  // belongs to a foreign provider session id, so holding the canonical slot for
  // it would make create un-retryable after a divergence, and this band mints no
  // reaper to revisit it. Ownership therefore passes to the transport under the
  // obligation documented on `ClaudeSessionChannel.dispose`, which is where a
  // transport implementation's review must check it.
  async #disposeRefusedChannel(
    channel: ClaudeSessionChannel,
    reason: ClaudeChannelDisposalReason,
  ): Promise<string> {
    try {
      await channel.dispose(reason);
      return "";
    } catch (error) {
      return ` The refused provider channel could not be disposed: ${describeFailure(error)}`;
    }
  }
}
