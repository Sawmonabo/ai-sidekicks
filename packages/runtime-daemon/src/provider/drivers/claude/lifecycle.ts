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
// Typed-error convention: mirrors `provider-registry.ts` and
// `provider-output-validation.ts` — a `readonly code` literal drawn from the
// `driver.*` namespace already registered in
// `docs/architecture/contracts/error-contracts.md` §Driver, plus a structured
// `fields` bag. PR-A mints NO new dotted code: `driver.unavailable` carries the
// driver-side refusals to service a session/run operation and
// `driver.capability_unsupported` carries a provider's typed control-request
// refusal ("registry membership is not availability"). A finer taxonomy is
// T3.14's P3-3 to register and re-home.

import {
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DriverResumeResultSchema,
  type CallbackToolInvocation,
  type CallbackToolResult,
  type CloseSessionParams,
  type CreateSessionParams,
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
import { randomUUID } from "node:crypto";

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
  | "resume_result_invalid";

// One live Claude provider process, already handshaken through `system/init`.
export interface ClaudeSessionChannel {
  readonly providerSessionId: string;
  sendUserText(frame: ClaudeUserTextFrame): Promise<void>;
  sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse>;
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

export interface ClaudeSessionTransport {
  spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment>;
  resumeSession(request: ClaudeSessionResumeRequest): Promise<ClaudeResumedSessionAttachment>;
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
  | "output_schema_unbound";

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

// NEVER serializes an arbitrary value. `providerFailureDetail` is persisted and
// operator-visible, and a blind `JSON.stringify` of an unknown rejection reason
// is how spawn configuration — up to and including credential material the
// transport was handed — leaks into a durable row.
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? `${error.name}: ${error.message}` : error.name;
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
interface ClaudeSpawnBinding {
  readonly admittedCostCapCents: number | undefined;
  readonly executionPostureMode: ExecutionPosture["mode"] | undefined;
  readonly executionPostureNetworkAccess: ExecutionPosture["networkAccess"] | undefined;
  readonly outputSchemaBound: boolean;
}

interface LiveClaudeSession {
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly channel: ClaudeSessionChannel;
  readonly spawnBinding: ClaudeSpawnBinding;
}

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
  readonly #liveSessions: Map<SessionId, LiveClaudeSession> = new Map();
  // The session slots whose provider process is being brought up right now.
  // `#liveSessions` alone cannot answer "is this session taken?": both entry
  // points await a transport spawn between their check and their registration,
  // so two concurrent callers would both pass a `#liveSessions.has()` test, both
  // spawn, and the second registration would overwrite the first — leaving the
  // loser's channel unreachable by `closeSession` and its CLI process alive
  // forever. Claimed SYNCHRONOUSLY before the first await, which is what makes
  // the check-then-act atomic on a single-threaded runtime. The stored promise
  // settles when the establishment does and never rejects, so `closeSession` can
  // await it without risking an unhandled rejection.
  readonly #sessionsBeingEstablished: Map<SessionId, Promise<void>> = new Map();
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

    this.#registerLiveSession({
      sessionId: params.sessionId,
      providerSessionId: attachment.providerSessionId,
      channel: attachment.channel,
      spawnBinding: this.#buildSpawnBinding(params),
    });

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

    const resumed: DriverResumeResult = {
      status: "resumed",
      bindingId: this.#mintBindingId(),
      sessionPosition: attachment.sessionPosition,
    };
    // An out-of-contract `resumed` arm (a non-integer or negative position, an
    // unusable binding id) is ITSELF a provider failure and must surface
    // `recovery-needed` rather than parse-rejecting into an exception the resume
    // caller has no arm for.
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

    this.#registerLiveSession({
      sessionId: params.sessionId,
      providerSessionId: attachment.providerSessionId,
      channel: attachment.channel,
      spawnBinding: this.#buildSpawnBinding(params),
    });
    return validated.data;
  }

  async startRun(params: StartRunParams): Promise<void> {
    const dispatch = await this.#runDispatchResolver.resolveRunDispatch(params);
    if (dispatch === undefined) {
      throw new ClaudeSessionUnavailableError("run_dispatch_unresolved", { runId: params.runId });
    }

    const live = this.#liveSessions.get(dispatch.sessionId);
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
    // A close arriving mid-establishment must not read the slot as empty and
    // no-op: the in-flight create or resume would register its channel a moment
    // later, and that process would outlive the session the daemon believes it
    // closed. Waiting is safe — establishment never awaits a close, so no cycle
    // exists — and the awaited promise never rejects.
    const establishment = this.#sessionsBeingEstablished.get(params.sessionId);
    if (establishment !== undefined) {
      await establishment;
    }

    const live = this.#liveSessions.get(params.sessionId);
    // Idempotent: closing an already-closed session is the teardown path's
    // normal double-call, not a fault.
    if (live === undefined) {
      return;
    }
    // Forget FIRST, so a disposal that throws cannot leave a route pointing at a
    // channel the daemon has been told to close. The disposal failure still
    // propagates — a leaked provider process is not something to swallow.
    this.#forgetSession(params.sessionId);
    await live.channel.dispose("session_closed");
  }

  findChannelForRun(runId: RunId): ClaudeSessionChannel | undefined {
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.#liveSessions.get(sessionId)?.channel;
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
    const posture = params.executionPosture;
    return {
      admittedCostCapCents: params.admittedCostCapCents,
      executionPostureMode: posture?.mode,
      executionPostureNetworkAccess: posture?.networkAccess,
      outputSchemaBound: params.outputSchema !== undefined,
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
    if (
      runPosture !== undefined &&
      (runPosture.mode !== live.spawnBinding.executionPostureMode ||
        runPosture.networkAccess !== live.spawnBinding.executionPostureNetworkAccess)
    ) {
      throw new ClaudeSessionUnavailableError("execution_posture_mismatch", {
        sessionId: live.sessionId,
        runId: params.runId,
        detail: `Run posture ${runPosture.mode}/${runPosture.networkAccess}, session posture ${String(live.spawnBinding.executionPostureMode)}/${String(live.spawnBinding.executionPostureNetworkAccess)}.`,
      });
    }

    if (params.outputSchema !== undefined && !live.spawnBinding.outputSchemaBound) {
      throw new ClaudeSessionUnavailableError("output_schema_unbound", {
        sessionId: live.sessionId,
        runId: params.runId,
      });
    }
  }

  #registerLiveSession(live: LiveClaudeSession): void {
    this.#liveSessions.set(live.sessionId, live);
  }

  // Names the current holder of a session slot for a refusal detail, or
  // `undefined` when the slot is free. One predicate, so the two entry points
  // cannot drift into disagreeing about what "taken" means.
  #describeSlotHolder(sessionId: SessionId): string | undefined {
    if (this.#liveSessions.has(sessionId)) {
      return `A live Claude session is already bound to session ${sessionId};`;
    }
    if (this.#sessionsBeingEstablished.has(sessionId)) {
      return `A create or resume for session ${sessionId} is already in flight;`;
    }
    return undefined;
  }

  // Claims the slot synchronously, runs the establishment, and releases the claim
  // however it settles. The claim is published BEFORE `establish` is awaited, so
  // no other caller can observe a free slot while this one is spawning.
  async #withSessionSlotClaimed<TEstablished>(
    sessionId: SessionId,
    establish: () => Promise<TEstablished>,
  ): Promise<TEstablished> {
    const establishment = establish();
    // `#sessionsBeingEstablished` holds a rejection-swallowed view: `closeSession`
    // awaits it purely to sequence, and a stored promise that could reject would
    // surface as an unhandled rejection whenever nobody closes the session.
    const settled = establishment.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionsBeingEstablished.set(sessionId, settled);
    try {
      return await establishment;
    } finally {
      // Identity-checked: only ever clear OUR claim. A later caller's claim can
      // not be reached here (it is refused while this one stands), and the check
      // keeps that true without relying on that argument.
      if (this.#sessionsBeingEstablished.get(sessionId) === settled) {
        this.#sessionsBeingEstablished.delete(sessionId);
      }
    }
  }

  #forgetSession(sessionId: SessionId): void {
    this.#liveSessions.delete(sessionId);
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
