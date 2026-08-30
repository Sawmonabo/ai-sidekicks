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
  DriverGoalResultSchema,
  DriverResumeResultSchema,
  DriverRollbackResultSchema,
  type CallbackToolInvocation,
  type CallbackToolResult,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverGoalResult,
  type DriverResumeResult,
  type DriverRollbackResult,
  type ExecutionPosture,
  type InterruptRunParams,
  type McpServerStatusProducer,
  type ProviderSessionHandle,
  type RecoveryCondition,
  type ResumeSessionParams,
  type RollbackToParams,
  type RunId,
  type SessionCallbackTool,
  type SessionId,
  type SetSessionGoalParams,
  type StartRunParams,
  type SubagentDefinition,
  type SubagentPolicy,
} from "@ai-sidekicks/contracts";
import { createHash, randomUUID } from "node:crypto";

import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import {
  ThreadFrameRouter,
  type RoutableProviderFrame,
  type SubagentLifecycleEmission,
  type ThreadFrameRoute,
  type ThreadFrameRouterConfig,
} from "../../thread-frame-router.js";
import {
  UsageDeltaAccountant,
  type CumulativeAxisReadings,
  type MeteredUsageDelta,
} from "../../usage-delta-accountant.js";

import {
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  ProviderBindingQuarantine,
  UNRECOGNIZED_TURN_EVIDENCE,
  composeTextNeutralizationRunFailure,
  type OutboundTextFrame,
  type TextNeutralityMechanismGrade,
  type TextNeutralizationRunFailure,
} from "../outbound-frame.js";
import { CLAUDE_DRIVER_NAME } from "./capabilities.js";
import {
  CLAUDE_SUBAGENT_START_SIGNAL,
  ClaudeTerminalEmissionGate,
  classifyClaudeFrameFamilyForRouting,
  classifyClaudeTurnEvidence,
  normalizeClaudeSubagentLifecycle,
  type ClaudeSubagentLifecycleSignal,
} from "./event-normalizer.js";

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

// A single outbound participant-authored text frame.
//
// Now the SHARED branded frame rather than a local shape, which is what makes
// the neutralization structural instead of conventional: `OutboundTextFrame`
// carries a `#private` field, so it is nominal and no object literal satisfies
// it. This module therefore CANNOT compose a wire frame — it can only obtain
// one from the frame writer, which is the single place the sentinel is applied
// and the correlation value is minted. The transport reads `wireText`; the
// author's bytes travel beside it as `authoredText` and are never what this
// band persists, events, or replays.
export type ClaudeUserTextFrame = OutboundTextFrame;

// How far a FAILED `sendUserText` got — the discriminator this band cannot
// derive and the transport cannot avoid knowing.
//
//   * `unsent` — the write was refused BEFORE any byte was handed over: the
//     channel was already closed, the stream was not writable, or the frame
//     could not be encoded. A POSITIVE claim about bytes, reserved for failures
//     wholly ahead of the first one. The provider saw nothing, so no turn
//     exists on account of this frame and none ever will.
//   * `indeterminate` — anything at or after the hand-off, and anything the
//     transport cannot place ahead of it. The host took the bytes and its write
//     rejected, the process died mid-write, or the failure is simply not one of
//     the two the transport can classify. How much of the line the child read
//     is not knowable from here, and a partially written line is exactly the
//     shape a child reads as a whole message once it sees the newline.
//
// There is deliberately NO `refused` arm. A user-text write on this leg is
// one-way stdin: the provider answers a TURN, never the write, so no failure on
// this path can carry the proof of receipt a control response can. Inventing
// one would be inventing evidence.
export type ClaudeUserTextDelivery = "unsent" | "indeterminate";

// The settled outcome of one `sendUserText`, reported rather than thrown.
//
// A rejection cannot carry this: it collapses "nothing left" and "the bytes are
// gone and the turn may be running" into one value, and the caller cannot
// recover the difference afterwards without reading an error message, which is
// a guess. The two cases are owed OPPOSITE treatment by the tripwire, so the
// difference has to cross the seam as data.
export type ClaudeUserTextWriteAttempt =
  | { readonly settled: "written" }
  | {
      readonly settled: "failed";
      readonly delivery: ClaudeUserTextDelivery;
      readonly cause: unknown;
    };

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

/**
 * One inbound Claude stream frame's cumulative token readings, as the transport
 * read them.
 *
 * Cumulative, not per-turn: this provider reports a RUNNING TOTAL for the
 * session that resets at no turn boundary, at no compaction, and on no resume.
 * The driver differences it; the transport must not.
 */
export interface ClaudeCumulativeUsageObservation {
  /** The turn the metered frame itself names, or `null` where it names none. */
  readonly namedTurnId: string | null;
  readonly cumulative: CumulativeAxisReadings;
  /** The wire's own per-turn figure where one exists; a cross-check only. */
  readonly declaredPerTurn?: CumulativeAxisReadings | null;
}

/**
 * The routing-relevant facts of one inbound Claude stream frame.
 *
 * Deliberately not the frame. See {@link ClaudeSessionChannel.onInboundFrame}
 * for why this shape, and not a frame body, is what crosses the seam.
 */
export interface ClaudeInboundFrameObservation {
  /** The composed `type/subtype` wire kind, verbatim and untrusted. */
  readonly frameKind: string;
  /**
   * The provider-attributed subagent identity where the frame carries one.
   *
   * `null` for a frame on the session's own thread. Claude frames carry NO
   * thread-id member, so this identity IS the child's identity axis and its
   * absence is what marks a frame as the session's own.
   */
  readonly subagentId: string | null;
  /** Cumulative token readings where the frame carries a usage block. */
  readonly cumulativeUsage: ClaudeCumulativeUsageObservation | null;
  /** The `SubagentStart` / `SubagentStop` signal where the frame is one. */
  readonly subagentLifecycle: ClaudeSubagentLifecycleSignal | null;
}

// One live Claude provider process, already handshaken through `system/init`.
export interface ClaudeSessionChannel {
  readonly providerSessionId: string;

  /**
   * Whether this channel can still deliver a turn terminal.
   *
   * TRANSPORT OBLIGATION — `isClosed` MUST read `true` once no further
   * {@link ClaudeSessionChannel.onTurnTerminal} invocation can arrive for this
   * channel, and MUST read `false` while one still can. That is the WHOLE of
   * the property, and it is narrower than it looks: not "the process exited",
   * not "the pipe broke", not "the last write failed" — only whether a terminal
   * is still reachable. A transport that wired this to some other notion of
   * liveness would be answering a question this band never asked.
   *
   * The one caller is the failed-write ruling below, whose entire argument for
   * RETAINING an ambiguous frame is that the turn's own terminal will arrive
   * and rule it. A channel that can deliver no terminal cannot make that
   * argument, so this is the fact the fail-closed arm turns on.
   *
   * Reading `false` is the SAFE default, which is why the flag is asked in this
   * direction. A transport that has not implemented it honestly yet leaves the
   * frame retained: that costs one pending slot on a scope that already
   * admitted it, and scope release reclaims it. The opposite default would trip
   * a healthy binding on every recoverable write failure — a run failed and a
   * provider session disposed over text the provider is still perfectly able to
   * answer for.
   */
  readonly isClosed: boolean;

  /**
   * Writes one participant-authored text frame and REPORTS the outcome.
   *
   * TRANSPORT OBLIGATION — a failure MUST be reported as a `failed` attempt
   * carrying the delivery classification, NOT raised as a rejection. The
   * classification is not recoverable above this seam: only the transport
   * observes whether the refusal happened ahead of the first byte or after the
   * host took the line, and that difference decides whether the frame is
   * forgotten or ruled fail-closed. See {@link ClaudeUserTextDelivery} for what
   * each arm claims — `unsent` is a positive claim and every failure the
   * transport cannot place ahead of the first byte is `indeterminate`.
   *
   * The driver still contains a rejection (as `indeterminate`, the fail-closed
   * arm) rather than trusting this obligation to hold, because a contract
   * violation must not be read as good news about bytes.
   */
  sendUserText(frame: ClaudeUserTextFrame): Promise<ClaudeUserTextWriteAttempt>;

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
   * The hook carries the terminal frame BODY, untyped and untrusted — the
   * "future caller" its previous no-payload form named, arrived. T3.18's
   * runtime tripwire has to ask whether a model turn demonstrably happened, and
   * that answer lives in typed members of this exact frame (`num_turns`,
   * `modelUsage`, `duration_api_ms`, `total_cost_usd`; see
   * `docs/reference/provider-wire/claude.md`).
   *
   * The band's no-frame-vocabulary discipline is PRESERVED rather than
   * abandoned: this module does not read a single member of the value. It
   * forwards it to the normalizer's classifier, which is the module that owns
   * frame content, and acts only on the classification that comes back. Typed
   * `unknown` so that stays enforced rather than merely intended.
   */
  onTurnTerminal(listener: (terminalFrame: unknown) => void): void;

  /**
   * Registers the lifecycle's inbound-frame observer. Called EXACTLY ONCE, when
   * the driver adopts the channel; a later registration replaces the listener.
   *
   * TRANSPORT OBLIGATION — the transport MUST invoke `observer` for EVERY
   * inbound stream frame, BEFORE handing that frame to its own normalize
   * consumer, and MUST deliver that frame to the consumer if and ONLY if the
   * returned {@link ThreadFrameRoute}'s decision appears in the DELIVER column
   * below. A transport that observed after projecting, or that ignored the
   * decision, would put a child thread's output in the parent's timeline — the
   * fabricated transcript I-005-12 forbids.
   *
   * DELIVER — the frame reaches the normalize consumer:
   *
   *   * `project` — a frame on the session's own thread.
   *   * `route-connection-scoped` — a frame from a censused connection- or
   *     account-scoped family, which carries no thread identity by design:
   *     `system/init`, `system/rate_limit_event`, `system/api_retry`, and the
   *     whole `control_request/*` / `control_response/*` family. Withholding
   *     these would silence rate-limit telemetry and HANG every inbound
   *     permission prompt, whose answer the provider is blocking on.
   *   * `carve-out-interactive-request` — a child's ask travels on the DECISION
   *     itself and routes through the same approval pipeline as the parent's.
   *     Suppressing it would not hide the child but hang it.
   *
   * WITHHOLD — the frame does not reach the consumer:
   *
   *   * `carve-out-usage` — a child's spend is metered driver-side, ahead of
   *     suppression; the child's content still never enters the parent's
   *     timeline.
   *   * `suppress-child-transcript` — the child's content, whose only timeline
   *     presence is the `subagent.*` pair.
   *   * `held-pending-registration` — buffered against a not-yet-registered
   *     child; re-routed on registration and answered through
   *     {@link ClaudeSessionLifecycleOptions.onReleasedFrameRoute}.
   *   * `quarantined` — an absent or unrecognized identity, recorded as a
   *     diagnostic rather than guessed into the parent.
   *
   * Held and quarantined frames are recorded by the router; neither is a silent
   * drop. This table is the same one the sibling driver applies driver-side in
   * its own route-decision switch — the difference is only WHO delivers, since
   * this band answers by return value and never touches frame content.
   *
   * Why the widening. Claude multiplexes subagent threads over the PARENT's own
   * stream, so "arrived on this channel" no longer identifies whose stream a
   * frame came from — the assumption `onTurnTerminal` was written under. The
   * thread-identity registry, the fail-closed routing decision, and the
   * usage-delta base registers are driver-session state held for the life of
   * the provider session, so the driver must see every frame to keep them.
   *
   * The observation carries NO frame content: a wire kind, an optional
   * provider-attributed subagent identity, an optional CLOSED numeric usage
   * reading, and an optional subagent-lifecycle signal. The normalizer still
   * owns the frame vocabulary and every payload mapping — what crosses here is
   * only what the routing and metering decisions are made of.
   */
  onInboundFrame(observer: (observation: ClaudeInboundFrameObservation) => ThreadFrameRoute): void;

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
  /**
   * The session goal, rendered to text by the daemon (T3.15 leg 2, EMULATED).
   *
   * TRANSPORT OBLIGATION — a present goal is realized as the CLI's system-prompt
   * append on this spawn. It is not a user turn and MUST NOT be delivered as
   * one: the goal is daemon-authored standing instruction, and injecting it into
   * the participant's message stream would put words in a participant's mouth
   * and put them in the transcript.
   *
   * Rides the SPAWN-BOUND shape rather than a live control request because this
   * provider exposes no arbitrary session-metadata surface — session name, tag,
   * and `getSessionInfo` only — so the append is the mechanism, and an append is
   * bound at process start. That is exactly why `setSessionGoal` answers
   * `degraded` against a running process instead of claiming an application it
   * cannot perform until the next spawn.
   */
  readonly goalText: string | undefined;
  readonly admittedCostCapCents: number | undefined;
  readonly executionPosture: ExecutionPosture | undefined;
  readonly callbackTools: SessionCallbackTool[] | undefined;
  /**
   * The subagent policy as REALIZED — definitions this driver cannot
   * boundary-mediate are already withheld and `maxDepth` is already clamped, so
   * the transport realizes what it is given rather than re-deciding.
   */
  readonly subagentPolicy: SubagentPolicy | undefined;
  /**
   * The definitions withheld from `subagentPolicy` and why (T3.15 leg 4).
   *
   * Carried BESIDE the policy rather than folded into it, because a transport
   * that received only the surviving definitions could not tell a policy that
   * declared three from one that declared five and lost two. Enforcement is
   * observability-only: a withheld definition never fails a run.
   */
  readonly withheldSubagentDefinitions: readonly ClaudeWithheldSubagentDefinition[];
  /**
   * The `--settings` sandbox document composed from `executionPosture` (T3.15
   * leg 5), or `undefined` when the session declares no posture.
   *
   * Composed by the DRIVER and handed over ready to write: the posture-to-flag
   * mapping is a normalization decision the driver contract owns, and leaving it
   * to each transport would make the enforced sandbox depend on which transport
   * happened to be wired.
   */
  readonly sandboxSettings: ClaudeSandboxSettings | undefined;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly onCallbackToolCall:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  /**
   * The daemon-hosted ephemeral MCP server the admitted `callbackTools` are
   * served through (T3.15 leg 3), or `undefined` when none are served.
   *
   * TRANSPORT OBLIGATION — realized as `--mcp-config` with this server's tools,
   * and the provider-facing names are taken from the descriptor rather than
   * re-derived. An invocation arriving under a provider-facing name is
   * translated back through `registryNamesByProviderName` before it becomes a
   * `CallbackToolInvocation`, so the daemon-side host is always asked about a
   * name its own registry holds.
   *
   * PRESENT ONLY when `onCallbackToolCall` is bound. That pairing is the leg-3
   * fail-closed spawn rule made structural: a registry served with no dispatcher
   * would offer the model tools whose invocations nothing could answer.
   */
  readonly callbackToolServer: ClaudeCallbackMcpServerDescriptor | undefined;
  /**
   * The daemon boundary that serializes beyond-cap subagent tool calls (T3.15
   * leg 4), or `undefined` when the session declares no enabled subagent policy.
   */
  readonly subagentAdmission: ClaudeSubagentAdmissionPort | undefined;
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

/**
 * A conversation rewind (T3.15 leg 1). Composed, on this provider, from
 * `--resume-session-at <message-uuid>` + `--fork-session`, with
 * `--replay-user-messages` so message-uuid rewind targets appear on the wire at
 * all.
 *
 * It extends the SPAWN-BOUND legs for the same reason resume does, and the
 * reason is not symmetry: a fork is a fresh process, so a rewind that omitted a
 * leg would relaunch the session shorn of it — unsandboxed, uncapped, or
 * unconstrained — while every layer above read an ordinary rewind.
 *
 * TRANSPORT OBLIGATIONS:
 *   1. `targetPosition` is the DRIVER-NORMALIZED session position. Resolving it
 *      to the provider's message uuid is the transport's job, because the uuid
 *      lives in the stream this band deliberately does not parse. A position
 *      that names no boundary MUST throw rather than resolve to a nearby one:
 *      rewinding to approximately the right place is a wrong answer that reads
 *      as a right one.
 *   2. The forked process runs from the IDENTICAL worktree cwd as the session
 *      being rewound. This provider answers a resume it cannot honour by
 *      starting a fresh session instead, and a cwd change is the documented
 *      trigger.
 *   3. `--rewind-files` is NOT used. Its coverage is Write/Edit-only, so it
 *      would restore some of the tree and leave the rest — file-state restore is
 *      the daemon's turn-snapshot leg, which is provider-uniform and strictly
 *      richer.
 */
export interface ClaudeSessionRewindRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string;
  readonly targetPosition: number;
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
 * What a transport reports for a completed rewind.
 *
 * `providerSessionId` is the FORKED session's own id and is expected to differ
 * from the handle that was rewound — that difference is what "fork" means here,
 * and the driver checks it rather than assuming it.
 *
 * `sessionPosition` is REQUIRED and is the position the fork actually landed on,
 * not the one that was asked for. Reporting the request back would make a
 * boundary the transport silently adjusted indistinguishable from one it hit
 * exactly, which is the same evidence gap I-005-5 closes on resume.
 */
export interface ClaudeRewoundSessionAttachment extends ClaudeSessionAttachment {
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
   * Forks the session at a rewind target, producing a new provider session whose
   * history stops at that boundary (T3.15 leg 1).
   *
   * A SEPARATE method rather than an optional member on `resumeSession`: the two
   * differ in their answer as well as their flags — a resume that lands on a
   * different session id is a FAILURE (the provider replaced the session), while
   * a rewind that lands on the same id is one (the provider did not fork). One
   * method could not carry both rules, and a shared one would have to pick.
   *
   * Carries `spawnSession`'s spawn-environment and auth-failure obligations
   * unchanged: this is a fresh process spawn, not a reattach.
   */
  rewindSession(request: ClaudeSessionRewindRequest): Promise<ClaudeRewoundSessionAttachment>;
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
  /**
   * Why this text is being written (T3.18). Typed as `string` rather than as
   * the origin union because the resolver reads it out of daemon-side run
   * state, so an off-union value is a runtime state the frame writer classifies
   * fail-closed — it neutralizes and reports `origin=unknown` — rather than a
   * compile error pushed onto a caller that cannot fix it.
   *
   * ABSENT ALSO NEUTRALIZES. That is the whole reason this is a frame-origin
   * discriminator instead of a capability flag: an undeclared capability
   * resolves fail-OPEN under I-005-2, which is exactly backwards here.
   */
  readonly frameOrigin?: string | undefined;
}

export interface ClaudeRunDispatchResolver {
  resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined>;
}

// The read the intervention dispatcher (T3.7) needs, and the only coupling
// between the two bands — narrowed to one method so `intervention.ts` cannot
// reach session state it has no business mutating.
//
// THREE outcomes, not two, since T3.18: a live channel, `undefined` for a run
// with no route, and a THROWN refusal for a run whose provider binding a
// text-neutralization trip disposed. The third is deliberately not folded into
// the second — "this run has no channel yet" invites a retry, and a retry into
// a process that has already swallowed a participant's words is the one
// response that must not happen. A caller that treats every non-channel answer
// as absence will now see the refusal escape instead, which is the intended
// direction: it names the real cause rather than a plausible wrong one.
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

// --------------------------------------------------------------------------
// Execution posture + subagent policy -> Claude spawn config (T3.15 legs 4 + 5)
// --------------------------------------------------------------------------

/**
 * The approval supervision every non-`trusted` posture runs under.
 *
 * RATIFIED MAPPING (user decision, 2026-08-25): a `supervised` posture maps to
 * `on-request` UNCONDITIONALLY — there is no conditional arm, and no posture
 * axis, profile, or provider capability may soften it. On this provider that is
 * realized as the ALWAYS-ARMED permission prompt: `allowUnsandboxedCommands` is
 * pinned `false` and the daemon's own permission-prompt tool adjudicates every
 * call, so no tool call reaches the model's hands without passing the daemon.
 * Recorded in code because this constant is the enforcement, and a reader
 * changing it must see that they are reversing a ratified decision.
 */
const CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS = false;

/**
 * The subagent depth ceiling this driver clamps to (T3.15 leg 4).
 *
 * A CEILING, not a default: a policy asking for less gets what it asked for. It
 * exists because subagent depth multiplies a run's blast radius geometrically
 * and the single-supervisor invariant makes the daemon answerable for every
 * level, so an unbounded depth would be a promise this daemon cannot keep.
 */
export const CLAUDE_SUBAGENT_MAX_DEPTH_CEILING: number = 5;

/**
 * The permission modes under which a subagent's tool calls still pass the
 * daemon's interception point.
 *
 * THE FAIL-CLOSED CRITERION for leg 4, and it is mechanical rather than
 * editorial: the daemon interposes at the permission prompt, so a definition
 * whose mode SKIPS that prompt has no interception point and its beyond-cap tool
 * calls cannot be held at a boundary that is not there. An UNRECOGNIZED mode is
 * treated the same way for the I-005-2 reason — a capability is present only
 * when explicitly declared, never inferred from a string this driver does not
 * know.
 *
 * An ABSENT mode is mediatable: it inherits the session's own mode, which this
 * driver pins to the always-armed prompt above.
 */
const CLAUDE_BOUNDARY_MEDIATABLE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "plan",
]);

/** Why one subagent definition was withheld from the spawn. */
export interface ClaudeWithheldSubagentDefinition {
  readonly name: string;
  readonly reason: string;
}

/** A subagent policy split into what this driver will spawn and what it refused. */
export interface ClaudeSubagentPolicyRealization {
  readonly policy: SubagentPolicy;
  readonly withheld: readonly ClaudeWithheldSubagentDefinition[];
}

/**
 * Admits the subagent definitions this driver can boundary-mediate and withholds
 * the rest (T3.15 leg 4's fail-closed rule).
 *
 * Withheld rather than downgraded. Rewriting an unmediatable definition's
 * permission mode would hand the agent a subagent that runs under a
 * configuration nobody chose, and doing so silently is worse than not offering
 * the subagent at all: the agent wastes no turns invoking a definition that was
 * never registered, and it cannot be misled about what the one it got enforces.
 *
 * `maxDepth` is clamped rather than refused. Depth is a scalar the daemon can
 * satisfy PARTIALLY and still be honest about — running three levels when five
 * were asked for is a strict subset of the request — where a definition is not
 * divisible that way.
 */
export function realizeClaudeSubagentPolicy(
  policy: SubagentPolicy,
): ClaudeSubagentPolicyRealization {
  if (!policy.enabled) {
    return { policy, withheld: [] };
  }
  const admitted: SubagentDefinition[] = [];
  const withheld: ClaudeWithheldSubagentDefinition[] = [];
  for (const definition of policy.definitions) {
    const permissionMode = definition.permissionMode;
    if (
      permissionMode === undefined ||
      CLAUDE_BOUNDARY_MEDIATABLE_PERMISSION_MODES.has(permissionMode)
    ) {
      admitted.push(definition);
      continue;
    }
    withheld.push({
      name: definition.name,
      reason: `permission mode "${permissionMode}" bypasses the daemon permission prompt, so this subagent's tool calls could not be held at the daemon boundary`,
    });
  }
  return {
    policy: {
      enabled: true,
      maxDepth: Math.min(policy.maxDepth, CLAUDE_SUBAGENT_MAX_DEPTH_CEILING),
      maxConcurrent: policy.maxConcurrent,
      definitions: admitted,
    },
    withheld,
  };
}

// --------------------------------------------------------------------------
// Subagent concurrency: the daemon-side boundary serialization (T3.15 leg 4)
// --------------------------------------------------------------------------

/**
 * Fails the waiters of a session whose process is going away.
 *
 * Free-standing rather than a method so both teardown paths — the close and the
 * rewind's predecessor release — reach it identically, and so a spawn that
 * declared no subagents (no gate) needs no null check at either call site.
 */
function disposeSubagentAdmission(legs: ClaudeSpawnBoundLegs): void {
  legs.subagentAdmission?.dispose();
}

/** Releases one held subagent slot. Idempotent — a double release frees one. */
export type ClaudeSubagentSlotRelease = () => void;

/** One queued admission, retained so a disposal can name who it abandoned. */
interface ClaudeSubagentSlotWaiter {
  readonly subagentId: string;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

/**
 * The port the transport awaits before dispatching a SUBAGENT-originated tool
 * call, and the one this driver satisfies.
 *
 * Exists because this provider documents no concurrency cap of its own, so
 * `maxConcurrent` has no native enforcement here and the daemon must supply it.
 * The enforcement point is the tool-call boundary rather than the spawn: a
 * subagent that has been created but is not calling tools is consuming nothing
 * this cap is about, and holding at creation would serialize planning as well
 * as work.
 *
 * TRANSPORT OBLIGATION — the release returned by `admit` MUST be called when the
 * tool call settles, on every path including failure. A leaked release holds the
 * slot for the session's lifetime, and the gate deliberately has no timeout that
 * would forgive one: reclaiming a slot on a guess would let the cap be exceeded
 * exactly when the daemon had lost track of who held it.
 *
 * `admit` REJECTS rather than hanging when the session it guards is disposed —
 * a waiter with no failure path outlives the process it was queued behind, and
 * a provider turn awaiting a tool result that can never arrive is a run that
 * never terminates.
 */
export interface ClaudeSubagentAdmissionPort {
  admit(subagentId: string): Promise<ClaudeSubagentSlotRelease>;
  /** Fails every waiter. Called when the guarded session is disposed. */
  dispose(): void;
}

/**
 * Holds beyond-cap subagent tool calls at the daemon boundary, and records the
 * breaches it could not hold (T3.15 leg 4).
 *
 * TWO SURFACES, and the split is the honest part. `admit` is ENFORCEMENT: a
 * call arriving with every slot taken waits in arrival order until one frees,
 * which is the "boundary-serialized" mechanism the parity matrix records for
 * this provider. `observeLiveSubagentCount` is OBSERVABILITY-ONLY: the provider
 * can create subagents without any of them calling a tool, so the daemon can
 * see more live subagents than the cap admits without the gate ever having been
 * consulted. That is a breach, it surfaces a diagnostic, and it never fails a
 * run — which is exactly what the row requires and all it requires.
 *
 * FIFO rather than a bare counter. A waiter set resolved in arbitrary order
 * starves whichever subagent is unlucky, and a starved subagent inside a run
 * with a wall-clock budget is a run that fails for a reason no participant did.
 */
export class ClaudeSubagentConcurrencyGate implements ClaudeSubagentAdmissionPort {
  readonly #sessionId: SessionId;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxConcurrent: number;
  readonly #waiters: ClaudeSubagentSlotWaiter[] = [];
  #heldSlotCount = 0;
  #reportedBreachCeiling = 0;
  #disposed = false;

  constructor(options: {
    readonly sessionId: SessionId;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly maxConcurrent: number;
  }) {
    this.#sessionId = options.sessionId;
    this.#diagnostics = options.diagnostics;
    // A cap below one would admit nothing and deadlock every subagent tool call
    // behind a slot that can never free, so it floors at one. The refusal a
    // caller who wants no subagents needs is `enabled: false`, which never
    // constructs a gate at all.
    this.#maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  }

  /** Slots currently held. Exposed for the breach comparison and for tests. */
  get heldSlotCount(): number {
    return this.#heldSlotCount;
  }

  /** Calls waiting for a slot. */
  get waitingCallCount(): number {
    return this.#waiters.length;
  }

  async admit(subagentId: string): Promise<ClaudeSubagentSlotRelease> {
    this.#assertLive(subagentId);
    if (this.#heldSlotCount < this.#maxConcurrent) {
      // Take the slot in the SAME synchronous step as the test. Deciding here
      // and incrementing after an `await` would let a second caller read the
      // pre-increment count and take the same slot.
      this.#heldSlotCount += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        this.#waiters.push({ subagentId, resolve, reject });
      });
      // The slot was HANDED OVER by the releasing call, which never decremented
      // — so `#heldSlotCount` already accounts for this admission. Incrementing
      // here would double-count; decrementing at release and re-incrementing in
      // this continuation would open a window (the continuation runs a
      // microtask later) in which a third caller reads a free slot that a
      // waiter has already been promised.
      this.#assertLive(subagentId);
    }
    let released = false;
    return () => {
      // Idempotent: a transport that releases on both a success path and a
      // `finally` must not free two slots for one call.
      if (released) {
        return;
      }
      released = true;
      const nextWaiter = this.#waiters.shift();
      if (nextWaiter !== undefined) {
        nextWaiter.resolve();
        return;
      }
      this.#heldSlotCount -= 1;
    };
  }

  /**
   * Fails every waiter, and every later admission, for a session that is gone.
   *
   * Held slots are NOT reclaimed: their releases are already in flight on the
   * transport, are idempotent, and freeing them here would hand a slot to a
   * waiter this method is in the middle of failing.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // Drain by splice rather than iterate-then-clear: a rejection handler that
    // re-enters `admit` must find an empty queue, not one being walked.
    const abandonedWaiters = this.#waiters.splice(0, this.#waiters.length);
    for (const waiter of abandonedWaiters) {
      waiter.reject(this.#composeDisposedError(waiter.subagentId));
    }
  }

  #assertLive(subagentId: string): void {
    if (this.#disposed) {
      throw this.#composeDisposedError(subagentId);
    }
  }

  #composeDisposedError(subagentId: string): ClaudeSessionUnavailableError {
    return new ClaudeSessionUnavailableError("no_live_session", {
      sessionId: this.#sessionId,
      detail: `Subagent ${subagentId} was waiting for a concurrency slot when the session was disposed.`,
    });
  }

  /**
   * Records that the daemon observed `liveSubagentCount` subagents alive at
   * once. Emits at most one diagnostic per NEW ceiling, so a breach that
   * persists across many observations is one record rather than a stream.
   */
  observeLiveSubagentCount(liveSubagentCount: number): void {
    if (
      liveSubagentCount <= this.#maxConcurrent ||
      liveSubagentCount <= this.#reportedBreachCeiling
    ) {
      return;
    }
    this.#reportedBreachCeiling = liveSubagentCount;
    this.#diagnostics.emit({
      provider: "claude",
      kind: "subagent_concurrency_breach",
      rawWireType: null,
      dispositionReason:
        "more subagents were observed alive than the declared concurrency cap admits; the cap is enforced at the tool-call boundary and never fails a run",
      details: {
        sessionId: this.#sessionId,
        maxConcurrent: this.#maxConcurrent,
        liveSubagentCount,
      },
    });
  }
}

// --------------------------------------------------------------------------
// Callback tools: the daemon-hosted ephemeral MCP server (T3.15 leg 3)
// --------------------------------------------------------------------------

/**
 * The server name every callback tool is served under.
 *
 * One server rather than one per tool: the provider namespaces tool names by
 * server, so a second server would only add a second name to keep in sync while
 * the daemon's registry is already flat.
 */
export const CLAUDE_CALLBACK_MCP_SERVER_NAME: string = "sidekicks";

/**
 * Composes the provider-facing name for one callback tool.
 *
 * `mcp__<server>__<tool>` is the provider's own naming, and it is NOT parsed
 * back: a tool name containing the separator would make the split ambiguous, so
 * the descriptor carries an explicit reverse map built at composition time
 * instead. Mangling is injective for distinct registry names, which is what
 * makes that map total.
 */
export function composeClaudeProviderToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** The daemon-hosted ephemeral MCP server one session's callback tools ride. */
export interface ClaudeCallbackMcpServerDescriptor {
  readonly serverName: string;
  /** The admitted registry, in registration order and de-duplicated by name. */
  readonly tools: readonly SessionCallbackTool[];
  /**
   * Provider-facing name -> registry name. The transport answers the provider
   * with provider-facing names and dispatches with registry names, so this map
   * is what keeps the two vocabularies from being conflated at either end.
   */
  readonly registryNamesByProviderName: ReadonlyMap<string, string>;
}

/**
 * Builds the ephemeral-MCP descriptor for one admitted registry.
 *
 * DUPLICATES are collapsed last-wins, matching the daemon-side host's own
 * registry construction: two entries under one name are one tool to the
 * provider, and having the driver and the host disagree about WHICH one would
 * make an invocation dispatch against a schema the provider was never shown.
 */
export function composeClaudeCallbackMcpServer(
  tools: readonly SessionCallbackTool[],
): ClaudeCallbackMcpServerDescriptor {
  const admittedByName = new Map<string, SessionCallbackTool>();
  for (const tool of tools) {
    admittedByName.set(tool.name, tool);
  }
  const registryNamesByProviderName = new Map<string, string>();
  for (const name of admittedByName.keys()) {
    registryNamesByProviderName.set(
      composeClaudeProviderToolName(CLAUDE_CALLBACK_MCP_SERVER_NAME, name),
      name,
    );
  }
  return {
    serverName: CLAUDE_CALLBACK_MCP_SERVER_NAME,
    tools: [...admittedByName.values()],
    registryNamesByProviderName,
  };
}

/**
 * The `--settings` sandbox document one execution posture composes to (T3.15
 * leg 5, native-partial and Bash-scoped).
 *
 * `credentialPolicyRef` rides through as the REFERENCE it is. Expanding it here
 * would put the installation's denied-credential list inside the driver, which
 * is the disclosure the content-addressed reference exists to avoid — and the
 * enforcement does not need it: the transport's spawn-environment obligation
 * already strips the effective policy's denied names from the child
 * environment. TRANSPORT OBLIGATION — a present ref is resolved by the
 * transport and mirrored into `permissions.deny` `Read` rules beside that env
 * scrub, so the deny-list is enforced on both the filesystem and the
 * environment rather than on one of them.
 */
export interface ClaudeSandboxSettings {
  readonly sandbox: {
    readonly enabled: boolean;
    readonly failIfUnavailable: boolean;
    readonly allowUnsandboxedCommands: boolean;
    readonly filesystem: { readonly allowWrite: readonly string[] };
    readonly network?: { readonly allowedDomains: readonly string[] } | undefined;
  };
  readonly credentialPolicyRef?: string | undefined;
}

/**
 * Composes the sandbox settings document for a posture.
 *
 * `failIfUnavailable` is pinned `true` on every sandboxed arm, and that is the
 * whole fail-closed property of this leg: a host whose sandbox cannot be brought
 * up must REFUSE to start the session, because the alternative — starting
 * unsandboxed while the daemon records a sandboxed posture — is the one outcome
 * an execution posture exists to make impossible.
 *
 * `trusted` is the single arm where the sandbox is off, which is what `trusted`
 * means. It still pins `failIfUnavailable`, harmlessly, so the document's shape
 * is uniform and a future edit cannot flip `enabled` without also deciding the
 * failure mode.
 */
export function composeClaudeSandboxSettings(posture: ExecutionPosture): ClaudeSandboxSettings {
  const sandboxed = posture.mode !== "trusted";
  return {
    sandbox: {
      enabled: sandboxed,
      failIfUnavailable: true,
      allowUnsandboxedCommands: sandboxed ? CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS : true,
      filesystem: {
        // `readonly-sandboxed` writes nowhere, so the list is EMPTY rather than
        // omitted: an omitted list is a request for the provider's default,
        // which is not the same statement.
        allowWrite: posture.mode === "readonly-sandboxed" ? [] : posture.writableRoots,
      },
      // `full` omits the restriction entirely — the absence IS the statement, and
      // an empty list would mean the opposite. `none` is the empty list, and an
      // allow-list rides through natively, which is the axis this provider
      // expresses and the Codex leg cannot.
      ...(posture.networkAccess === "full"
        ? {}
        : {
            network: {
              allowedDomains:
                posture.networkAccess === "allowed-domains" ? posture.allowedDomains : [],
            },
          }),
    },
    ...(posture.mode === "trusted" ? {} : { credentialPolicyRef: posture.credentialPolicyRef }),
  };
}

/**
 * One session's routing and metering band (T3.11).
 *
 * The two halves are one record because they are one lifetime: the router's
 * thread registry and the accountant's base registers answer the same question
 * from two sides, and a band holding one without the other routes a frame
 * against a thread it can meter nothing for.
 */
interface ClaudeSessionRoutingBand {
  readonly router: ThreadFrameRouter<ClaudeRoutableFrame>;
  readonly accountant: UsageDeltaAccountant;
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
  /**
   * The exact legs this process was spawned with, retained whole.
   *
   * A rewind is a fresh spawn with NO params object of its own — the caller
   * addresses a position, not a configuration — so these are the only record of
   * what the rewound leg must be re-realized under. Retaining the legs rather
   * than re-deriving them is the point: re-derivation would have to guess, and a
   * guess that omits the posture relaunches the session unsandboxed.
   *
   * Distinct from `spawnBinding` beside it, which holds a DIGEST for comparison.
   * A digest can prove two spawns agree; it cannot spawn anything.
   */
  readonly spawnBoundLegs: ClaudeSpawnBoundLegs;
  /**
   * Which base-establishment arm this leg takes, and whose sum it bases on
   * (T3.11).
   *
   * A daemon-created session bases its usage registers at ZERO. A resume — and
   * a rewind, which is a fresh spawn continuing a session whose spend the
   * daemon already emitted — bases at the prior-emitted cumulative sum.
   *
   * The resume arm carries `priorEmittedThreadId` because the thread to base
   * FROM is not always the thread being established. A provider-native resume
   * answers with the id it was handed (I-005-5's identity gate refuses anything
   * else), so the two coincide there. A REWIND forks: the successor announces a
   * brand-new provider session id that the daemon has never emitted a single
   * token against, so keying the lookup on it would resolve to nothing on every
   * rewind. The predecessor's id is the only key under which the daemon's own
   * emitted sum exists.
   */
  readonly establishment: ClaudeUsageEstablishment;
}

/**
 * Which usage base-establishment arm a live session's binding takes.
 *
 * A union rather than a string discriminant so the resume arm cannot be
 * constructed without naming the thread whose prior-emitted sum it bases on —
 * the omission that made every rewind base at zero.
 */
type ClaudeUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

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
  //
  // `channel` is the channel BOUND to this session for the duration of the
  // claim, which is `undefined` for a create or resume (nothing is bound yet —
  // both start from EMPTY) and the PREDECESSOR's channel for a rewind, which
  // starts from LIVE and keeps its process running for the whole multi-second
  // fork. Carried for the same reason the `quarantined` arm carries one: an
  // establishing slot that named no channel made every predecessor frame
  // unattributable for the length of the window, so a rewind that then FAILED
  // resumed a session with a diagnosed hole in its transcript — the opposite of
  // the non-destructive-on-failure property the rewind claim exists to give.
  | {
      readonly state: "establishing";
      readonly settled: Promise<void>;
      readonly channel: ClaudeSessionChannel | undefined;
    }
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
  /**
   * The daemon-wide diagnostic band (T3.11).
   *
   * REQUIRED. The parity legs owe a RECORD on each of their fail-closed paths —
   * a withheld subagent definition, a withheld callback-tool registry, an
   * observed concurrency breach — and a leg whose record could be dropped
   * because a sink was left unbound is fail-closed in name only.
   */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * The daemon's own prior-emitted cumulative token sums for one provider
   * session, used to base a PROVIDER-NATIVE RESUME or a REWIND (T3.11).
   *
   * `threadId` is the thread the sums were emitted UNDER, which on a rewind is
   * the predecessor rather than the successor being established. Answering
   * `undefined` is a legitimate answer meaning "nothing was emitted under this
   * id"; it bases at zero and records nothing. A reader left unbound, or one
   * that throws, is the faulty case and IS recorded.
   *
   * Optional because the driver cannot rebuild it: the sums live in the
   * canonical event record, which the daemon owns and this module never reads.
   */
  readonly readPriorEmittedUsage?:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  /**
   * Receives each metered per-turn usage delta (T3.11). PRODUCER-ONLY: the
   * driver states what was spent and the emission pipeline mints the
   * `usage_telemetry` envelope, so no driver mints a session event.
   */
  readonly onMeteredUsage?: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  /**
   * This leg's declared text-neutrality parity grade (T3.18), defaulting to the
   * grade `Spec-005 §Parity Capability Mechanism Grades` records for it.
   *
   * Injectable because the grade is a behavioral INPUT: a leg re-graded
   * `native` by amendment flips this value, and no code path branches on the
   * provider's name to decide it.
   */
  readonly textNeutralityMechanismGrade?: TextNeutralityMechanismGrade | undefined;
  /** Correlation minting for outbound text frames (T3.18). Injectable for tests. */
  readonly mintOutboundFrameCorrelationId?: (() => string) | undefined;
  /**
   * Receives the run terminal a text-neutralization tripwire trip produces
   * (T3.18). PRODUCER-ONLY, exactly like the sibling callbacks above: the
   * driver states that the run failed and why, and the emission pipeline mints
   * the envelope.
   *
   * REQUIRED, like `diagnostics` and unlike the optional sibling callbacks: the
   * trip NEVER raises a JSON-RPC error, so this callback is the ONLY surface a
   * swallowed turn has. An optional arm would let a construction site that
   * simply never bound it end a neutralized turn with no terminal an operator
   * can read.
   */
  readonly onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  /**
   * Receives the `subagent.started` / `subagent.completed` pair for each
   * provider-attributed child (T3.11). PRODUCER-ONLY, and the child's ONLY
   * timeline presence: a registered child's content and lifecycle frames are
   * transcript-suppressed, so this pair survives the suppression rather than
   * sharing it.
   */
  readonly onSubagentLifecycle?:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  /**
   * Receives the routing decision for a frame that was RELEASED from a pending
   * hold rather than routed inside the observer call (T3.11).
   *
   * REQUIRED FOR CORRECTNESS ON THE HELD PATH, optional only because a
   * deployment binding no consumer for released frames is already choosing not
   * to project them. A frame routed inside {@link
   * ClaudeSessionChannel.onInboundFrame} answers the transport by RETURN VALUE;
   * a held frame is released later, when no observer call is in flight and no
   * return value exists — so without this seam every deliverable decision a
   * release can carry would have no recipient.
   *
   * What a release can actually carry on THIS provider. A hold is only ever
   * taken for a frame naming a thread identity the router has not yet seen, so
   * a release re-routes that frame against the now-registered child. The
   * reachable outcomes are `carve-out-usage` — the child's spend, metered
   * driver-side and deliberately NOT delivered — and `suppress-child-transcript`
   * for the child's content. Both are terminal here; the seam exists so the
   * release path is a routed decision with a recorded recipient rather than a
   * drop, and so a future family whose released decision IS deliverable has a
   * seam to arrive on.
   *
   * `carve-out-interactive-request` is structurally unreachable on this leg.
   * The frame kinds that raise an interactive request on this provider are the
   * `control_request/*` family, which
   * {@link classifyClaudeFrameFamilyForRouting} censuses CONNECTION-scoped:
   * they carry no thread identity, so they are
   * never held, never released, and never routed against a child. Contrast the
   * sibling driver, whose routable frame carries params and a per-frame thread
   * identity: there the same carve-out is reachable, and its release is a
   * body-complete delivery to the normalize band.
   */
  readonly onReleasedFrameRoute?:
    | ((
        sessionId: SessionId,
        observation: ClaudeInboundFrameObservation,
        route: ThreadFrameRoute,
      ) => void)
    | undefined;
  // The provider-side session id pinned at spawn (`--session-id`). Injected so
  // tests and a future deterministic id source can drive it; defaults to a v4
  // UUID, the shape the CLI flag requires.
  readonly mintProviderSessionId?: (() => string) | undefined;
  // The opaque session-binding handle the `resumed` arm carries. The daemon's
  // `runtime_bindings` store mints it in production; the default keeps this band
  // runnable without a database.
  readonly mintBindingId?: (() => string) | undefined;
}

/**
 * One observed Claude frame as the thread-frame router sees it.
 *
 * Claude frames carry no thread-id member, so `threadId` DERIVES: the frame's
 * subagent identity where it has one, and the session's own provider session id
 * otherwise. It is never `null` for a session frame — passing `null` would
 * quarantine every ordinary frame as a thread-scoped family with no identity.
 */
interface ClaudeRoutableFrame extends RoutableProviderFrame {
  readonly threadId: string;
  /**
   * The observation this frame was built from, carried along because a HELD
   * frame must still be meterable: the router releases pending holds when the
   * registration they were waiting for lands, and a release that handed back
   * only the routing members would have shed the child's usage reading.
   */
  readonly observation: ClaudeInboundFrameObservation;
}

/**
 * The router's bounds for a Claude session.
 *
 * The hold covers one race — a subagent's frames arriving ahead of the
 * `SubagentStart` signal that announces it — which is short and narrow; the
 * timeout is the outer bound on that race and is deliberately far below any
 * human-visible latency, because a frame held longer than this is not racing an
 * announcement, it names a child that will never be announced.
 */
const CLAUDE_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});

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
  // The P1-1 producer half. One gate per session, installed at establishment
  // and signalled at the top of `closeSession`; the terminal-emission boundary
  // in `event-normalizer.ts` is the CONSUMER that stamps the flag, because that
  // is the module that owns the terminal frame.
  //
  // Keyed beside the slot map rather than carried on `LiveClaudeSession`: the
  // intent must be recordable while the slot is ESTABLISHING, CLOSING, or
  // QUARANTINED — states that hold no live session — and a close arriving
  // during an establishment is exactly the case where mis-reading a clean
  // shutdown as a crash would be most misleading.
  readonly #terminalEmissionGates: Map<SessionId, ClaudeTerminalEmissionGate> = new Map();
  // The T3.11 child-routing and usage-delta band, one instance of each per
  // provider session and held for that session's lifetime — the state
  // `Spec-005 §Interfaces And Contracts` describes as driver-session state, so
  // it is constructed here rather than composed from outside.
  // ONE map, so the router and the accountant are created and released
  // together. Two maps let a caller resurrect one half of a band the other half
  // had already been released from, which is a routing decision made against a
  // thread registry no accountant holds registers for.
  readonly #routingBands: Map<SessionId, ClaudeSessionRoutingBand> = new Map();
  readonly #readPriorEmittedUsage:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  readonly #onMeteredUsage: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  // T3.18. The writer is the ONLY composer of provider-bound text bytes on this
  // leg; the tripwire correlates each written frame with the turn that settles
  // it; the quarantine holds bindings a trip disposed. Constructed here rather
  // than injected as a unit because all three are driver-session state whose
  // lifetime is this object's.
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #providerBindingQuarantine: ProviderBindingQuarantine = new ProviderBindingQuarantine();
  readonly #onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  readonly #onSubagentLifecycle:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  readonly #onReleasedFrameRoute:
    | ((
        sessionId: SessionId,
        observation: ClaudeInboundFrameObservation,
        route: ThreadFrameRoute,
      ) => void)
    | undefined;
  /**
   * The daemon-stored session goals (T3.15 leg 2's emulation, driver half).
   *
   * DRIVER-HELD, never durable truth: the goal's record of record is the
   * session's own `goal_updated` / `goal_cleared` events, and the daemon
   * re-pushes on resume. This map exists only so a spawn this driver performs
   * ITSELF — a rewind fork — carries the goal the session currently has, rather
   * than silently relaunching without it.
   *
   * Keyed beside the slot map for the same reason the terminal gates are: a goal
   * set against a session whose slot is mid-transition must still be recorded.
   */
  readonly #sessionGoals: Map<SessionId, string> = new Map();
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeSessionLifecycleDependencies) {
    this.#transport = dependencies.transport;
    this.#runDispatchResolver = dependencies.runDispatchResolver;
    this.#diagnostics = dependencies.diagnostics;
    this.#readPriorEmittedUsage = dependencies.readPriorEmittedUsage;
    this.#onMeteredUsage = dependencies.onMeteredUsage;
    this.#onSubagentLifecycle = dependencies.onSubagentLifecycle;
    this.#onReleasedFrameRoute = dependencies.onReleasedFrameRoute;
    this.#mintProviderSessionId = dependencies.mintProviderSessionId ?? randomUUID;
    this.#mintBindingId = dependencies.mintBindingId ?? randomUUID;
    this.#onTextNeutralizationFailure = dependencies.onTextNeutralizationFailure;
    this.#outboundTextFrameWriter = new OutboundTextFrameWriter({
      // `emulated` is this leg's grade at the pin: the provider's own
      // programmatic input surface intercepts command-shaped text client-side,
      // measured first-party and recorded in
      // `docs/reference/provider-wire/claude.md`.
      mechanismGrade: dependencies.textNeutralityMechanismGrade ?? "emulated",
      mintCorrelationId: dependencies.mintOutboundFrameCorrelationId,
    });
    // Constructed here rather than as a field initializer because the predicate
    // reads a field declared after it, and a field initializer that captured
    // that field would depend on declaration order to be correct.
    //
    // A session is retired once it holds no slot at all — every disposal path
    // ends by deleting it — or once a trip has quarantined the binding. Either
    // way no turn on it can ever settle, so the frames it left pending are owed
    // no ruling. The SLOT map rather than `#findLiveSession`, deliberately: a
    // session mid-establishment or mid-close still holds its slot and its
    // frames may still be ruled, and reclaiming those would be the eviction the
    // capacity refusal exists to replace.
    this.#outboundFrameTripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey: string): boolean =>
        !this.#sessionSlots.has(scopeKey as SessionId) ||
        this.#providerBindingQuarantine.isSessionDisposed(scopeKey),
    });
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
    // Built ONCE and retained, not built twice. The second build would read
    // `#sessionGoals` again, so a goal set between the spawn and the
    // registration would be recorded as the leg this process launched under
    // when it is not.
    const spawnBoundLegs = this.#buildSpawnBoundLegs(params);
    const attachment = await this.#transport.spawnSession({
      ...spawnBoundLegs,
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
        spawnBoundLegs: spawnBoundLegs,
        establishment: { mode: "fresh" },
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
    const spawnBoundLegs = this.#buildSpawnBoundLegs(params);
    let attachment: ClaudeResumedSessionAttachment;
    try {
      attachment = await this.#transport.resumeSession({
        ...spawnBoundLegs,
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
        spawnBoundLegs: spawnBoundLegs,
        // The resume identity gate above already refused any id but the handle
        // the caller supplied, so the session being established IS the thread
        // the daemon has been emitting against.
        establishment: { mode: "resume", priorEmittedThreadId: attachment.providerSessionId },
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

    // T3.18, and BEFORE the live-session lookup so the cause survives. A trip
    // disposes the session's channel, so a quarantined session fails that lookup
    // too — with `no_live_session`, a plausible wrong cause that reads as a race
    // and invites a retry into the process that swallowed the participant's
    // words. Asked here, the refusal names the neutralization instead. Released
    // at establishment, so the promised recovery — a fresh spawn under this id —
    // is the thing that lifts it.
    this.#providerBindingQuarantine.assertSessionAttachable(dispatch.sessionId);

    const live = this.#findLiveSession(dispatch.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    this.#assertSpawnBoundRealization(params, live);

    // T3.18. The bytes are composed HERE and nowhere else: this band cannot
    // build a `ClaudeUserTextFrame` itself, so the neutralization is on the only
    // path to the wire rather than on a path a reviewer has to remember to
    // check. Composed before the registration because the registration is keyed
    // by the frame it admits.
    const frame = this.#outboundTextFrameWriter.compose({
      text: dispatch.openingText,
      origin: dispatch.frameOrigin,
    });
    // A REFUSED registration aborts before the write. Taking the write anyway
    // would be the one genuinely unsafe option — a turn that settles against no
    // correlated frame PASSES, so an unwatched frame turns this session's
    // backlog into a silent swallow.
    //
    // Admitted BEFORE the run route is bound, so a refusal here leaves this
    // method having mutated nothing at all. The order is not cosmetic: a route
    // bound ahead of a throwing admission would survive it, `findChannelForRun`
    // would answer for a run that never dispatched, and a later interrupt or
    // cancel for that run would send a SESSION-scoped control request that
    // stops whatever older turn is genuinely running on the channel. Both steps
    // are synchronous and both precede the write, so nothing is given up by
    // asking for the budget first.
    this.#outboundFrameTripwire.register({
      scopeKey: dispatch.sessionId,
      joinKey: params.runId,
      frame,
    });
    // Bound BEFORE the frame is written: once the text is on the wire the turn
    // may already be running, and an interrupt racing the write must find a
    // route. What a FAILED write leaves behind is now decided by how far its
    // bytes got — see `#ruleFailedOpeningFrame`.
    this.#sessionIdByRunId.set(params.runId, dispatch.sessionId);
    const attempt = await this.#attemptOpeningWrite(live.channel, frame);
    if (attempt.settled === "failed") {
      this.#ruleFailedOpeningFrame({
        sessionId: dispatch.sessionId,
        runId: params.runId,
        channel: live.channel,
        frame,
        delivery: attempt.delivery,
      });
      throw attempt.cause;
    }
  }

  /**
   * Writes the opening frame, containing a transport that rejects instead of
   * reporting.
   *
   * `sendUserText` is obliged to REPORT its failures so the delivery
   * classification crosses the seam as data. A transport that rejected has
   * broken that obligation, and the one thing this band must not do with a
   * broken contract is read it as good news: a rejection carries no claim about
   * bytes, and `unsent` is precisely a claim about bytes. So it lands on the
   * fail-closed arm — the same rule the classification itself runs under, where
   * anything that cannot be placed ahead of the first byte is `indeterminate`.
   */
  async #attemptOpeningWrite(
    channel: ClaudeSessionChannel,
    frame: ClaudeUserTextFrame,
  ): Promise<ClaudeUserTextWriteAttempt> {
    try {
      return await channel.sendUserText(frame);
    } catch (cause) {
      return { settled: "failed", delivery: "indeterminate", cause };
    }
  }

  /**
   * Decides what a failed opening frame is owed, by how far its bytes got
   * (T3.18).
   *
   * UNSENT — owed nothing. No turn will ever account for the frame, and leaving
   * it registered would let it consume the evidence of the NEXT run on this
   * session: the older frame rules first, the live run is ruled against none,
   * and a run whose text did reach the provider is failed for it. The drop is
   * frame-scoped for the shape this leg does not yet have but the sibling does
   * — a second frame on the same key, still live and still owed its own ruling.
   *
   * The route goes with it, and that is a DEPARTURE from what a failed write
   * used to leave behind. A route is not inert bookkeeping on this leg: Claude's
   * interrupt is CHANNEL-scoped, so a route pointing at a run that provably
   * never dispatched is an aimed weapon with nothing to aim at, and the
   * interrupt it answers would stop whatever older turn the channel is actually
   * running. The old blanket "an interruptible run beats a turn with no route to
   * it" is the right trade only where a turn MIGHT exist; here, provably, none
   * does.
   *
   * INDETERMINATE on a serviceable channel — owed the opposite. The provider may
   * have received the text, intercepted it as a client-side command, and
   * answered with the zero-turn success this tripwire exists to catch; the
   * rejection the caller saw says nothing either way. Withdrawing the frame
   * there is exactly how a swallowed directive escapes detection while the
   * unsafe binding stays reusable. So the registration is RETAINED, the route is
   * retained with it, and the turn's own terminal rules it — the argument the
   * sibling driver's steer path could not make and this one can, because this
   * path deliberately keeps both the route and the binding live.
   *
   * Retention has a cost, and it is worth naming rather than discovering: the
   * retained frame becomes the FIRST claimant on this session's next terminal.
   * If a later run then writes successfully and that run's turn settles, the
   * ambiguous frame consumes the settling evidence and the later run is ruled
   * against none — so the trip is reported against the wrong run. That is the
   * fail-closed direction: the session is quarantined and disposed either way,
   * and the participant is protected. The alternative — dropping the ambiguous
   * frame so the attribution reads cleanly — is a SILENT PASS on the exact case
   * this tripwire exists for.
   *
   * INDETERMINATE on a dead channel — the one case retention cannot cover. No
   * terminal will ever arrive, so the frame would sit until the scope's budget
   * is released and be dropped as mere occupancy: silence in the case that
   * warrants the loudest answer. Ruled here instead, fail-closed, and ruled
   * FRAME-scoped so a sibling frame on the same key whose delivery was never in
   * doubt is not tripped alongside it.
   *
   * The route is deliberately LEFT on that last arm. `disposeRun` is what makes
   * `findChannelForRun` refuse rather than answer `undefined`, and the two mean
   * different things to a caller — a quiet `undefined` reads as "no channel
   * yet", the one reading that invites a retry straight back into the swallow.
   * Deleting the route would trade the loud refusal for exactly that silence.
   *
   * Residual, deliberately not closed here: a channel still serviceable at this
   * moment that dies later without ever settling the turn leaves the retained
   * frame to scope release. Closing it would mean carrying "delivery
   * indeterminate" as tripwire state and ruling it at scope release, which
   * fires neutralization failures on ordinary session closes that happen to
   * have a turn in flight — a false trip on every clean shutdown, to cover a
   * window this path already narrows to one that opens after the
   * classification.
   */
  #ruleFailedOpeningFrame(ruling: {
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly channel: ClaudeSessionChannel;
    readonly frame: ClaudeUserTextFrame;
    readonly delivery: ClaudeUserTextDelivery;
  }): void {
    if (ruling.delivery === "unsent") {
      this.#outboundFrameTripwire.forgetFrame(ruling.frame);
      this.#sessionIdByRunId.delete(ruling.runId);
      return;
    }
    if (!ruling.channel.isClosed) {
      return;
    }
    const decision = this.#outboundFrameTripwire.settleFrame(
      ruling.frame,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (!decision.tripped) {
      return;
    }
    // The same disposal the settlement path performs, in the same order: the
    // SESSION arm first, so a caller reacting synchronously to the run failure
    // cannot reach the condemned process by the other door. `startRun` resolves
    // a session, so a run-keyed refusal alone would leave the next run free to
    // dispatch onto the same channel.
    this.#providerBindingQuarantine.disposeSession(ruling.sessionId);
    this.#providerBindingQuarantine.disposeRun(ruling.runId);
    this.#reportTextNeutralizationFailure(
      ruling.sessionId,
      ruling.runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(ruling.sessionId);
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

  /**
   * Rewinds a session's conversation to a recorded position (T3.15 leg 1).
   *
   * CONVERSATION ONLY. Working-tree restore is the daemon's turn-snapshot leg;
   * this provider's own `--rewind-files` is deliberately not used, because its
   * Write/Edit-only coverage would restore part of a tree and leave the rest.
   *
   * MECHANISM: a FORK, not an in-place rewind — the transport composes
   * `--resume-session-at` with `--fork-session`, so the rewound conversation
   * runs as a NEW provider session and the pre-rewind one is left intact. That
   * is why an `applied` result carries a freshly minted `bindingId`: the
   * surrogate is the daemon's only channel for the new provider session, and
   * without it the run stays bound to a session the store never recorded and is
   * therefore not resumable across a restart.
   *
   * NON-DESTRUCTIVE ON FAILURE, which is the property the slot discipline here
   * exists for. The predecessor is captured before the claim and restored by
   * `#withRewindSlotClaimed` on every path that does not install a successor, so
   * a rewind that fails leaves the session exactly as it was found — running,
   * startable, and un-rewound — rather than emptying a slot whose process is
   * still alive.
   */
  async rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      // Thrown rather than degraded, and the split is deliberate: `degraded` is
      // the vocabulary for a driver that WAS able to act and reported a
      // fallback. There is no session here to act on, so a `degraded` answer
      // would invite a fallback for a session that does not exist.
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }
    return await this.#withRewindSlotClaimed(
      params.sessionId,
      live,
      async () => await this.#establishRewoundSession(params, live),
    );
  }

  async #establishRewoundSession(
    params: RollbackToParams,
    predecessor: LiveClaudeSession,
  ): Promise<DriverRollbackResult> {
    // A rewind IS a spawn, so it is the boundary `setSessionGoal` promised to
    // bind at. The predecessor's legs carry the goal as it stood at ITS spawn,
    // and reusing them verbatim would drop a goal recorded since — answering a
    // caller `degraded, goal-appended-at-next-session-spawn` and then skipping
    // the very next spawn. Re-read here, and registered below, so a second
    // rewind does not re-drop it.
    const rewoundSpawnBoundLegs: ClaudeSpawnBoundLegs = {
      // The predecessor's OWN legs, re-realized verbatim. Rebuilding them from
      // anything else would relaunch the session under a configuration nobody
      // chose — the failure mode CP-005-1 names for resume, reached here by a
      // path that carries no params to rebuild from.
      ...predecessor.spawnBoundLegs,
      goalText: this.#sessionGoals.get(params.sessionId),
      // A FRESH gate, never the predecessor's. A rewind relaunches the process,
      // so every subagent the old gate was holding slots for died with it —
      // carrying that gate forward would hold a permanently reduced cap against
      // calls that no longer exist. The predecessor's gate is disposed with its
      // channel below.
      subagentAdmission: this.#buildSubagentAdmission(
        params.sessionId,
        predecessor.spawnBoundLegs.subagentPolicy,
      ),
    };
    let attachment: ClaudeRewoundSessionAttachment;
    try {
      attachment = await this.#transport.rewindSession({
        ...rewoundSpawnBoundLegs,
        resumeHandle: predecessor.providerSessionId,
        targetPosition: params.position,
      });
    } catch (error) {
      // The predecessor is untouched, so the session is exactly as it was and a
      // retry is safe. `degraded` rather than a throw: the caller has a fallback
      // arm for precisely this, and the daemon's own rewind path is what runs it.
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-refused: ${sanitizeFailureDetail(describeFailure(error))}`,
      });
    }

    // THE FORK CHECK. A rewind that answers with the id it was given did not
    // fork — it either rewound the original session in place or handed the same
    // process back. Either way the binding lineage the daemon records would be
    // wrong, and the pre-rewind conversation the fork is supposed to preserve is
    // gone. Refused rather than adopted.
    if (attachment.providerSessionId === predecessor.providerSessionId) {
      // Disposed only when it is a DIFFERENT channel. Handing the predecessor's
      // own channel back is the one case where disposal would kill the session
      // this method is about to restore.
      const disposalNote =
        attachment.channel === predecessor.channel
          ? ""
          : await this.#disposeRefusedChannel(attachment.channel, "resume_identity_diverged");
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-not-forked: the provider answered with session ${attachment.providerSessionId} rather than a fork.${disposalNote}`,
      });
    }

    // ADOPTION INVARIANT — from here to registration, EVERY exit either
    // registers the new channel or disposes it. The window holds the result
    // validation and `#registerLiveSession`'s transport-implemented
    // `onTurnTerminal`, and an escaping throw would orphan a forked process
    // whose slot this method's own claim then restores to the PREDECESSOR.
    let validatedRollbackResult: DriverRollbackResult;
    try {
      const applied = {
        status: "applied" as const,
        sessionPosition: attachment.sessionPosition,
        bindingId: this.#mintBindingId(),
      };
      const validated = DriverRollbackResultSchema.safeParse(applied);
      if (!validated.success) {
        const disposalNote = await this.#disposeRefusedChannel(
          attachment.channel,
          "resume_result_invalid",
        );
        return DriverRollbackResultSchema.parse({
          status: "degraded",
          fallbackAction: `rewind-result-invalid: ${sanitizeFailureDetail(validated.error.message)}${disposalNote}`,
        });
      }
      validatedRollbackResult = validated.data;

      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: predecessor.spawnBinding,
        spawnBoundLegs: rewoundSpawnBoundLegs,
        // A rewind is a fresh spawn continuing a session whose earlier spend
        // the daemon has already emitted, so it bases like a resume: a zero
        // base here would re-meter every pre-rewind turn. Keyed on the
        // PREDECESSOR's id, which is the only id the daemon has emitted spend
        // under — the fork's brand-new id resolves to nothing by construction.
        //
        // Whether the provider's counter CONTINUES across `--fork-session` is
        // deliberately unrecorded in the pinned wire reference, which states
        // only that the flag mints a new session id on resume. Both readings
        // are handled and they are not symmetric. If the counter continues,
        // this base is exact. If it restarts, the successor's readings fall
        // BELOW this base and the accountant's decrease-floor rule floors the
        // deltas at zero and records a diagnostic — loud under-metering that
        // repairs itself once the counter passes the base. Zero-basing has the
        // inverse failure: silent double-counting of every pre-rewind turn,
        // which reaches a receipt as real money and says nothing.
        establishment: { mode: "resume", priorEmittedThreadId: predecessor.providerSessionId },
      });
    } catch (error) {
      const disposalNote = await this.#disposeRefusedChannel(
        attachment.channel,
        "establishment_failed",
      );
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-adoption-failed: ${sanitizeFailureDetail(describeFailure(error))}${disposalNote}`,
      });
    }

    // The predecessor's correlation is dropped only AFTER adoption has
    // committed, and outside the try so that no throw can land between the drop
    // and the registration.
    //
    // Both calls move together because they are one record read two ways: the
    // tripwire finds a session's correlated runs THROUGH the routes, so
    // forgetting the frames while the routes stood — or the reverse — leaves a
    // predecessor the slot machinery can restore but whose swallowed turns
    // nothing can rule. A failed adoption restores a still-running predecessor,
    // and it must come back correlated.
    //
    // Dropping them at all is still right on the committed path: every run bound
    // to this session was running on the PREDECESSOR's turn, so a surviving
    // route would aim a later interrupt at a turn that never started, and the
    // predecessor's turns can no longer settle, so their frame registrations are
    // owed no ruling and would hold this session's watch budget for the fork's
    // whole lifetime. Nothing can observe the interval: the two calls are
    // synchronous and adjacent to the registration, with no await between them.
    this.#retireRunRoutes(params.sessionId);
    this.#outboundFrameTripwire.forgetScope(params.sessionId);

    // The predecessor is released only AFTER the successor is installed, which
    // is what made every failure path above non-destructive. Its disposal
    // failure is folded into the applied result's report rather than thrown: the
    // rewind SUCCEEDED, and converting it into a throw would tell the daemon a
    // completed fork did not happen while leaving the forked process live.
    disposeSubagentAdmission(predecessor.spawnBoundLegs);
    await this.#disposeRefusedChannel(predecessor.channel, "session_closed");
    return validatedRollbackResult;
  }

  /**
   * Records the session goal (T3.15 leg 2, EMULATED on this provider).
   *
   * ALWAYS `degraded` against a live session, and that is the honest answer
   * rather than a limitation being papered over. This provider exposes no
   * arbitrary session-metadata surface, so the goal is realized as a
   * system-prompt append — which is bound at process start. A running process
   * therefore cannot take a new goal, and answering `applied` would tell the
   * daemon the session is governed by an instruction its model has never seen.
   *
   * The goal IS recorded, so every spawn this driver performs from here on
   * carries it. `fallbackAction` names the boundary at which it takes effect, so
   * the caller can decide whether to relaunch.
   */
  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }
    this.#sessionGoals.set(params.sessionId, params.goalText);
    return await Promise.resolve(
      DriverGoalResultSchema.parse({
        status: "degraded",
        fallbackAction: "goal-appended-at-next-session-spawn",
      }),
    );
  }

  /**
   * Clears the session goal (T3.15 leg 2, EMULATED on this provider).
   *
   * `applied` ONLY when no goal was recorded. That is not a technicality: the
   * post-condition this operation promises is that the session carries no goal,
   * and a session that never had one already satisfies it exactly. Where a goal
   * WAS recorded, the running process still carries it in a system prompt that
   * cannot be un-appended, so the answer is `degraded` at the same boundary the
   * set path names.
   */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }
    const hadGoal = this.#sessionGoals.delete(params.sessionId);
    return await Promise.resolve(
      DriverGoalResultSchema.parse(
        hadGoal
          ? { status: "degraded", fallbackAction: "goal-cleared-at-next-session-spawn" }
          : { status: "applied" },
      ),
    );
  }

  async closeSession(params: CloseSessionParams): Promise<void> {
    // P1-1, FIRST and unconditionally — before the chaining loop, not inside
    // it. The daemon has expressed the intent by calling this method at all, so
    // every terminal from this point on belongs to a clean shutdown: the ones a
    // chained close only reaches after another transition settles, and the ones
    // an establishment still in flight is about to produce as it is torn down.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();

    // Close CHAINS rather than refusing (the field doc states why): it awaits any
    // in-flight transition, then re-reads, because the slot may have settled into
    // a different state than the one it started waiting on — an establishment can
    // finish LIVE, a concurrent close can finish EMPTY, and a failed close can
    // finish QUARANTINED.
    for (;;) {
      const slot = this.#sessionSlots.get(params.sessionId);
      // EMPTY. Idempotent: closing an already-closed session is the teardown
      // path's normal double-call, not a fault. The latch this call just set
      // goes with it — no slot means no session, so there is no terminal left
      // for the flag to describe, and keeping the gate would accumulate one
      // entry per redundant close.
      if (slot === undefined) {
        this.#terminalEmissionGates.delete(params.sessionId);
        this.#sessionGoals.delete(params.sessionId);
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
          // And with them the frames no turn on this channel can ever settle.
          // Called HERE and at the rewind above rather than folded into
          // `#retireRunRoutes`, because that helper's third caller is the
          // terminal path — where the tripwire has just been ruled and dropping
          // whatever it left behind would rest on "provably already empty"
          // rather than on the binding being gone.
          this.#outboundFrameTripwire.forgetScope(params.sessionId);
          // Before the await, for the same reason the routes go first: a
          // subagent waiting on a slot in a process being torn down would wait
          // for the session's whole remaining lifetime and answer its provider
          // turn never.
          disposeSubagentAdmission(slot.session.spawnBoundLegs);
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
      // The gate dies with the session it scoped. A terminal arriving after
      // this point names a run no slot can settle, so retaining the gate would
      // retain state for a decision nobody makes.
      this.#terminalEmissionGates.delete(sessionId);
      // Same scope, same reason: a goal is a property of a session that exists.
      this.#sessionGoals.delete(sessionId);
      // The routing and metering band is per-provider-session state; a router
      // surviving its session would answer the next one with a thread registry
      // that session never made.
      this.#routingBands.delete(sessionId);
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
    // T3.18. A binding a tripwire trip disposed is refused rather than answered
    // with `undefined`: the two states mean different things to the caller, and
    // a quiet `undefined` would read as "this run has no channel yet" — the one
    // reading that invites a retry into the same swallow. The refusal carries
    // the SAME code the run terminal did, so one cause reads as one cause.
    this.#providerBindingQuarantine.assertRunAttachable(runId);
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.#findLiveSession(sessionId)?.channel;
  }

  /**
   * The terminal-emission gate for one session (T3.14 P1-1 / P1-2-driver).
   *
   * The emission pipeline reads it to stamp `intendedClose` and to suppress a
   * duplicate terminal for an already-settled `(runId, runVersion)` epoch. Read
   * LIVE at each terminal rather than captured, for the same reason the
   * capability snapshot is: a gate captured before a close would answer with a
   * latch the close has since set.
   */
  terminalEmissionGateFor(sessionId: SessionId): ClaudeTerminalEmissionGate {
    return this.#intendedCloseGateFor(sessionId);
  }

  /**
   * The thread-frame router for one session, or `undefined` when this session
   * holds no routing band (T3.11).
   *
   * NON-CREATING, unlike the emission gate beside it. The band is per-provider-
   * session state built at registration and released with the session, so a
   * get-or-create accessor would let a call arriving AFTER the close silently
   * resurrect a band nothing will ever delete — state accumulating for a
   * session that no longer exists, and a router answering routing questions
   * with a thread registry no session ever made. The emission gate is
   * deliberately the other way round because its whole job is to survive
   * whichever of close and establishment arrives first; a router has no such
   * latch to keep.
   *
   * Read LIVE rather than captured: a router captured before a registration
   * would answer with a thread set the registration has since widened.
   */
  frameRouterFor(sessionId: SessionId): ThreadFrameRouter<ClaudeRoutableFrame> | undefined {
    return this.#routingBands.get(sessionId)?.router;
  }

  /**
   * The usage-delta accountant for one session, or `undefined` when this
   * session holds no routing band (T3.11). Non-creating for the same reason
   * {@link ClaudeSessionLifecycle.frameRouterFor} is.
   */
  usageAccountantFor(sessionId: SessionId): UsageDeltaAccountant | undefined {
    return this.#routingBands.get(sessionId)?.accountant;
  }

  // Builds this session's routing band if it holds none. THE only creator, and
  // it is reached from exactly one place: `#registerLiveSession`, where a
  // session that can emit frames first exists.
  #ensureRoutingBand(sessionId: SessionId): ClaudeSessionRoutingBand {
    const existing = this.#routingBands.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const band: ClaudeSessionRoutingBand = {
      router: new ThreadFrameRouter<ClaudeRoutableFrame>({
        provider: "claude",
        diagnostics: this.#diagnostics,
        config: CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
      }),
      accountant: new UsageDeltaAccountant({
        provider: "claude",
        diagnostics: this.#diagnostics,
      }),
    };
    this.#routingBands.set(sessionId, band);
    return band;
  }

  /**
   * Bind a session's OWN thread identity into the routing and metering band.
   *
   * ORDER IS THE CONTRACT: the accountant's base registers are established
   * BEFORE the router releases anything, because a released usage frame meters
   * immediately and an unestablished thread would refuse it outright.
   *
   * The registration's released frames are RE-ROUTED rather than discarded. On
   * this provider the identity is known at adoption, so the release is normally
   * empty — but a caller that discarded it would shed any frame that did race
   * the binding, and the router's release contract is the same on both legs.
   */
  #bindSessionThread(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    providerSessionId: string,
    establishment: ClaudeUsageEstablishment,
  ): void {
    if (establishment.mode === "fresh") {
      band.accountant.establishThread(providerSessionId, { mode: "fresh" });
    } else {
      band.accountant.establishThread(providerSessionId, {
        mode: "resume",
        priorEmittedCumulative:
          this.#readPriorEmittedSum(sessionId, establishment.priorEmittedThreadId) ?? {},
      });
    }
    this.#releaseHeldFrames(band, sessionId, band.router.registerSessionThread(providerSessionId));
  }

  /**
   * Read the daemon's own prior-emitted cumulative sum for one thread.
   *
   * The diagnostic is reserved for the genuinely FAULTY arm — no reader bound,
   * or a reader that threw. A bound reader answering `undefined` is a correct
   * answer to a correct question: a session that legitimately emitted nothing
   * has a prior-emitted sum of zero, and basing at zero is exactly right. An
   * earlier revision recorded that case too, which made the record fire on
   * every rewind and say nothing about any of them.
   */
  #readPriorEmittedSum(
    sessionId: SessionId,
    priorEmittedThreadId: string,
  ): CumulativeAxisReadings | undefined {
    const reader = this.#readPriorEmittedUsage;
    if (reader === undefined) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        priorEmittedThreadId,
        "no prior-emitted usage reader is bound, so the daemon's own emitted sum could not be rebuilt; base registers start at zero, so the first post-resume reading meters pre-resume spend again",
      );
      return undefined;
    }
    try {
      return reader(sessionId, priorEmittedThreadId);
    } catch (error) {
      // Swallowed on purpose, and recorded rather than rethrown: this runs
      // inside the adoption invariant's window, where an escaping throw
      // orphans a live provider process. Over-metering is recoverable from the
      // record; an orphaned process is not.
      this.#emitResumeBaseUnavailable(
        sessionId,
        priorEmittedThreadId,
        `the prior-emitted usage reader failed, so the daemon's own emitted sum could not be rebuilt (${sanitizeFailureDetail(describeFailure(error))}); base registers start at zero, so the first post-resume reading meters pre-resume spend again`,
      );
      return undefined;
    }
  }

  #emitResumeBaseUnavailable(
    sessionId: SessionId,
    priorEmittedThreadId: string,
    dispositionReason: string,
  ): void {
    this.#diagnostics.emit({
      provider: "claude",
      kind: "usage_resume_base_unavailable",
      rawWireType: null,
      dispositionReason,
      details: { sessionId, threadId: priorEmittedThreadId },
    });
  }

  /**
   * Re-route frames the router just released from its pending-registration
   * hold, and DELIVER each decision to the released-frame consumer.
   *
   * The delivery is the whole point of the separate path. A frame routed inside
   * the transport's observer call answers by return value; a released frame has
   * no observer call in flight to answer, so a caller that only applied the
   * decision would meter the frame and then drop it — silently shedding exactly
   * the interactive request the carve-out exists to keep reachable.
   */
  #releaseHeldFrames(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    releasedFrames: readonly ClaudeRoutableFrame[],
  ): void {
    const nowMs = Date.now();
    for (const releasedFrame of releasedFrames) {
      const route = band.router.routeFrame(releasedFrame, nowMs);
      this.#applyRouteDecision(band, sessionId, releasedFrame, route);
      this.#onReleasedFrameRoute?.(sessionId, releasedFrame.observation, route);
    }
  }

  /**
   * Route one observed inbound frame and answer with the transport's decision.
   *
   * THE routing entry point, ahead of every projection decision. A
   * `SubagentStart` registers its child BEFORE the announcing frame is routed —
   * otherwise the announcement would be held pending the very registration it
   * carries — and a `SubagentStop` completes the child AFTER its own frame has
   * routed, so the stop frame is still suppressed as the child's rather than
   * projected into the parent.
   */
  #observeInboundFrame(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    providerSessionId: string,
    observation: ClaudeInboundFrameObservation,
  ): ThreadFrameRoute {
    const router = band.router;
    const lifecycleSignal = observation.subagentLifecycle;
    if (lifecycleSignal !== null && lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
      const normalized = normalizeClaudeSubagentLifecycle(lifecycleSignal, providerSessionId);
      if (normalized.announcement !== null) {
        const registration = router.registerChildThread(normalized.announcement);
        if (registration.registered) {
          if (band.accountant.hasThread(registration.childThreadId)) {
            // A SECOND announcement for a child already carrying a base. The
            // router accepted it (re-registering a held identity is a no-op),
            // but re-establishing would reset this child's register to zero
            // mid-stream, so its next cumulative reading would re-meter every
            // token it has already spent — double-counted spend on the receipt
            // — and a second `subagent.started` would duplicate the child's
            // only timeline presence. Recorded rather than returned on: the
            // duplicate is a provider-side observation worth surfacing.
            this.#diagnostics.emit({
              provider: "claude",
              kind: "thread_duplicate_child_announcement",
              rawWireType: observation.frameKind,
              dispositionReason:
                "duplicate subagent announcement for an already-registered child; usage base retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            // A registered child is a BRAND-NEW provider thread, so its base
            // registers start at zero. Establishing it here rather than lazily
            // is what makes the usage carve-out reachable at all: the
            // accountant refuses an unestablished thread outright, so a child
            // whose spend was never established would carve out of the parent's
            // transcript and then be dropped on the floor — the child's cost
            // vanishing rather than being scoped, which is not what I-005-12
            // asks for.
            band.accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            this.#onSubagentLifecycle?.(sessionId, {
              eventType: "subagent.started",
              subagentId: normalized.subagentId,
              parentReference: normalized.parentToolUseId,
            });
          }
          // Released unconditionally on BOTH arms. A hold can only exist for an
          // identity the router had not yet seen, so the duplicate arm releases
          // an empty list — but making the release conditional would couple the
          // hold's fate to a metering decision it has nothing to do with.
          this.#releaseHeldFrames(band, sessionId, registration.releasedFrames);
        }
      }
    }

    const frame: ClaudeRoutableFrame = {
      rawWireType: observation.frameKind,
      familyClass: classifyClaudeFrameFamilyForRouting(observation.frameKind, observation),
      // The derivation this provider's wire forces: no frame carries a thread
      // id, so the subagent identity IS the child's identity axis and its
      // absence marks the session's own thread.
      threadId: observation.subagentId ?? providerSessionId,
      observation,
    };
    const route = router.routeFrame(frame, Date.now());
    this.#applyRouteDecision(band, sessionId, frame, route);
    return route;
  }

  #applyRouteDecision(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    frame: ClaudeRoutableFrame,
    route: ThreadFrameRoute,
  ): void {
    switch (route.decision) {
      case "project":
      case "route-connection-scoped":
      case "carve-out-usage":
        // The usage carve-out is applied AHEAD of suppression: a child's spend
        // is metered even though a child's content is not.
        this.#meterObservedUsage(band, sessionId, frame);
        this.#completeChildOnStopSignal(band, sessionId, frame);
        return;
      case "suppress-child-transcript":
        this.#completeChildOnStopSignal(band, sessionId, frame);
        return;
      case "carve-out-interactive-request":
      case "held-pending-registration":
      case "quarantined":
        // The interactive-request carve-out needs no driver-side action here:
        // the ask travels on the DECISION, not on a driver-side side effect,
        // and every caller of this method delivers that decision — the observer
        // path by returning it to the transport, the release path through
        // `#releaseHeldFrames`. A child's ask therefore routes through the same
        // approval pipeline as the parent's on either path. Held and
        // quarantined frames are already recorded by the router; neither is a
        // silent drop.
        return;
    }
  }

  #meterObservedUsage(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    frame: ClaudeRoutableFrame,
  ): void {
    const cumulativeUsage = frame.observation.cumulativeUsage;
    if (cumulativeUsage === null) {
      return;
    }
    const metered = band.accountant.meterReading({
      threadId: frame.threadId,
      namedTurnId: cumulativeUsage.namedTurnId,
      cumulative: cumulativeUsage.cumulative,
      declaredPerTurn: cumulativeUsage.declaredPerTurn ?? null,
    });
    if (metered !== null) {
      this.#onMeteredUsage?.(sessionId, metered);
    }
  }

  /**
   * Close a child's `subagent.*` pair on its own `SubagentStop`.
   *
   * The stop signal is this provider's child terminal: Claude publishes no
   * per-child result frame, so the lifecycle signal that opened the pair is
   * also the only thing that can close it.
   */
  #completeChildOnStopSignal(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    frame: ClaudeRoutableFrame,
  ): void {
    const lifecycleSignal = frame.observation.subagentLifecycle;
    if (lifecycleSignal === null || lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
      return;
    }
    const attribution = band.router.childAttributionFor(lifecycleSignal.subagentId);
    const completion = band.router.completeChildThread(lifecycleSignal.subagentId);
    if (!completion.wasRegistered) {
      return;
    }
    band.accountant.releaseThread(lifecycleSignal.subagentId);
    if (attribution?.kind === "subagent") {
      this.#onSubagentLifecycle?.(sessionId, {
        eventType: "subagent.completed",
        subagentId: attribution.subagentId,
        parentReference: lifecycleSignal.parentToolUseId,
      });
    }
  }

  // Get-or-create, so the intent latch survives whichever of close and
  // establishment reaches this session first.
  #intendedCloseGateFor(sessionId: SessionId): ClaudeTerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new ClaudeTerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
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
    const subagentPolicy = params.subagentPolicy;
    const realizedSubagents =
      subagentPolicy === undefined ? undefined : realizeClaudeSubagentPolicy(subagentPolicy);
    for (const withheldDefinition of realizedSubagents?.withheld ?? []) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "subagent_definition_disabled",
        rawWireType: null,
        dispositionReason: withheldDefinition.reason,
        // UNTRUSTED caller-supplied text carried verbatim as data, so an
        // operator can see WHICH definition was withheld.
        details: { sessionId: params.sessionId, definitionName: withheldDefinition.name },
      });
    }
    const posture = params.executionPosture;
    const callbackToolServer = this.#resolveCallbackToolServer(params);
    return {
      sessionId: params.sessionId,
      goalText: this.#sessionGoals.get(params.sessionId),
      admittedCostCapCents: params.admittedCostCapCents,
      executionPosture: posture,
      sandboxSettings: posture === undefined ? undefined : composeClaudeSandboxSettings(posture),
      // The registry the PROVIDER is offered is the one the descriptor serves,
      // so a withholding sheds both together and neither can be shipped without
      // the other.
      callbackTools: callbackToolServer === undefined ? undefined : [...callbackToolServer.tools],
      callbackToolServer,
      subagentPolicy: realizedSubagents?.policy,
      withheldSubagentDefinitions: realizedSubagents?.withheld ?? [],
      subagentAdmission: this.#buildSubagentAdmission(params.sessionId, realizedSubagents?.policy),
      outputSchema: params.outputSchema,
      onCallbackToolCall: params.onCallbackToolCall,
      onMcpServerStatus: params.onMcpServerStatus,
    };
  }

  /**
   * The leg-3 fail-closed spawn rule: a registry is served only when the daemon
   * can answer an invocation against it.
   *
   * TWO OWNERS, ONE DECISION EACH — see `CallbackToolHost`'s wiring note. The
   * host owns admission (is there a Plan-012 seam? did the daemon offer tools?)
   * and hands the composition root the admitted list; this driver owns the
   * STRUCTURAL PAIRING it alone can enforce — a registry is advertised to the
   * provider only when a dispatcher is bound to answer it. The two cannot
   * disagree because they decide different questions, and the driver's check is
   * the weaker one: everything the host withheld arrives here as an empty list.
   *
   * The reported reason is deliberately this band's OWN observation. The driver
   * cannot distinguish a host with no approval seam from a composition root that
   * never bound the dispatcher, so it names what it saw rather than borrowing
   * the host's finer `CallbackToolRegistryWithholdingReason`.
   *
   * The registry is withheld rather than served-and-refused: a tool the model
   * never learns exists costs it no turns.
   */
  #resolveCallbackToolServer(
    params: CreateSessionParams | ResumeSessionParams,
  ): ClaudeCallbackMcpServerDescriptor | undefined {
    const requestedTools = params.callbackTools ?? [];
    if (requestedTools.length === 0) {
      return undefined;
    }
    if (params.onCallbackToolCall === undefined) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "callback_tool_registry_withheld",
        rawWireType: null,
        dispositionReason:
          "no callback-tool dispatcher is bound for this spawn, so no invocation could be answered; the registry is withheld rather than offered unanswerable",
        details: {
          sessionId: params.sessionId,
          reason: "no-dispatcher-bound",
          withheldToolCount: requestedTools.length,
        },
      });
      return undefined;
    }
    return composeClaudeCallbackMcpServer(requestedTools);
  }

  // One gate per spawn rather than per session: a relaunch is a new process
  // whose subagents are new, and carrying the predecessor's held slots forward
  // would hold a cap against calls that died with the old process.
  #buildSubagentAdmission(
    sessionId: SessionId,
    policy: SubagentPolicy | undefined,
  ): ClaudeSubagentAdmissionPort | undefined {
    if (policy === undefined || !policy.enabled) {
      return undefined;
    }
    return new ClaudeSubagentConcurrencyGate({
      sessionId,
      diagnostics: this.#diagnostics,
      maxConcurrent: policy.maxConcurrent,
    });
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
    // BAND, then SLOT, then listeners. The order is three separate claims.
    //
    // The band goes first because a listener registration can deliver a frame
    // re-entrantly, and a frame reaching the observer with no band would have to
    // be quarantined — refusing a frame from the very channel this method is in
    // the middle of adopting. Built before the slot for the same reason it is
    // built before `#bindSessionThread`: a frame arriving in that window names
    // an unregistered thread, so the router HOLDS it, and the binding below
    // releases it. Held-then-released is a delivery; quarantined is not.
    //
    // The slot goes before the listeners, reversing an earlier ordering. That
    // ordering existed so a throwing `onTurnTerminal` would leave the slot unset
    // for the caller's adoption guard to clean up — but it also left a window in
    // which the channel was registered and the slot was not yet live, so the
    // identity gate below refused frames from the channel it had just adopted.
    // The window is closed by writing the slot first and RESTORING the previous
    // slot value if a listener registration throws, which reaches the same
    // end-state by an explicit rollback rather than by an ordering that has to
    // be re-derived to be understood.
    const previousSlot = this.#sessionSlots.get(live.sessionId);
    const bandExistedBefore = this.#routingBands.has(live.sessionId);
    const band = this.#ensureRoutingBand(live.sessionId);
    this.#sessionSlots.set(live.sessionId, { state: "live", session: live });
    try {
      this.#registerLiveSessionHooks(band, live);
    } catch (error) {
      // Restores rather than deletes. The previous value is the CALLER's claim
      // — an `establishing` arm whose own settle path decides what EMPTY or
      // LIVE means for this leg — and deleting it would publish an EMPTY slot
      // that a rewind's predecessor-restore could no longer identify as its own.
      if (previousSlot === undefined) {
        this.#sessionSlots.delete(live.sessionId);
      } else {
        this.#sessionSlots.set(live.sessionId, previousSlot);
      }
      // Only a band THIS call created is released. A rewind adopts a successor
      // into a session whose band is already carrying the predecessor's
      // registers, and dropping those on a failed adoption would zero a session
      // that is about to be restored and keep running.
      if (!bandExistedBefore) {
        this.#routingBands.delete(live.sessionId);
      }
      throw error;
    }
    // T3.18. Released only on a registration that SUCCEEDED, so a failed
    // adoption cannot lift a refusal the failed leg never replaced. The
    // quarantine names a BINDING, not an identifier: a fresh channel now answers
    // for this session id, so the refusal a prior trip installed has outlived
    // the process it condemned.
    this.#providerBindingQuarantine.releaseSession(live.sessionId);
  }

  // The listener half of registration, separated so the slot rollback above has
  // exactly one thing to guard.
  #registerLiveSessionHooks(band: ClaudeSessionRoutingBand, live: LiveClaudeSession): void {
    // Claude serializes turns per session, so "a terminal arrived on this
    // channel" identifies the run without the transport naming it: the route
    // pointing at this session IS the run that just ended. Registered here, the
    // one place both establishment paths converge on.
    //
    // Retiring routes only — never the slot. The session stays LIVE and startable
    // after a turn ends; it is the RUN that is over.
    const retireOnTurnTerminal = (terminalFrame: unknown): void => {
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
      // T3.18, BEFORE the retirement. The tripwire is keyed by run id, and
      // `#retireRunRoutes` is what empties the map those ids are read from — so
      // ruling after retiring would rule on nothing and let every swallowed turn
      // through.
      this.#ruleTextNeutralizationTripwire(live.sessionId, terminalFrame);
      this.#retireRunRoutes(live.sessionId);
    };
    live.channel.onTurnTerminal(retireOnTurnTerminal);
    // Registered beside the terminal hook and for the same reason: this is the
    // one place both establishment paths converge on. Identity-gated the same
    // way — an undead channel that keeps emitting must not route frames into
    // whatever session occupies this slot NOW — and fail-closed on that gate,
    // because a frame from a channel the daemon no longer owns is precisely a
    // frame that must not project.
    live.channel.onInboundFrame((observation): ThreadFrameRoute => {
      if (!this.#isChannelCurrentlyBound(live.sessionId, live.channel)) {
        return {
          decision: "quarantined",
          reason:
            "frame arrived on a channel this session no longer holds; refused rather than projected into whichever session occupies the slot now",
        };
      }
      const boundBand = this.#routingBands.get(live.sessionId);
      if (boundBand === undefined) {
        // Fail-closed and unreachable by construction: registration builds the
        // band before this listener exists, and only a close releases it. Held
        // as a guard rather than an assertion because the alternative to an
        // answer here is projecting a frame no router ever classified.
        return {
          decision: "quarantined",
          reason:
            "frame arrived while this session held no routing band; refused rather than classified against a registry that does not exist",
        };
      }
      return this.#observeInboundFrame(
        boundBand,
        live.sessionId,
        live.providerSessionId,
        observation,
      );
    });
    // Base registers and the session's own thread identity, established before
    // any frame can be metered against them.
    this.#bindSessionThread(band, live.sessionId, live.providerSessionId, live.establishment);
    // Through the same accessor `closeSession` uses, so a close signalled while
    // this establishment was in flight finds its latch still set rather than
    // replaced by a fresh gate.
    this.#intendedCloseGateFor(live.sessionId);
  }

  /**
   * Is this channel the one currently BOUND to this session, in any state from
   * which the session can still continue?
   *
   * Wider than {@link ClaudeSessionLifecycle.#findLiveSession} on purpose, and
   * only for frame routing. A rewind holds an `establishing` slot for the whole
   * multi-second fork while the PREDECESSOR's process stays up and emitting; a
   * live-only gate quarantined every one of those frames, and a rewind that then
   * failed restored a session whose transcript had a hole in it for the length
   * of the attempt — which contradicts the non-destructive-on-failure property
   * the rewind path's own claim rests on.
   *
   * `closing` and `quarantined` deliberately stay refused. Those are the states
   * a channel is in when the daemon has decided to stop owning it, and a frame
   * from a process the daemon disowned is exactly the frame that must not
   * project. Run STARTING keeps the narrower live-only gate: a run may not begin
   * in a process that is coming up.
   */
  #isChannelCurrentlyBound(sessionId: SessionId, channel: ClaudeSessionChannel): boolean {
    const slot = this.#sessionSlots.get(sessionId);
    if (slot === undefined) {
      return false;
    }
    // Exhaustive over the union: a new state is a new arm the compiler forces a
    // routing decision for, rather than one silently defaulting to refused.
    switch (slot.state) {
      case "live":
        return slot.session.channel === channel;
      case "establishing":
        return slot.channel === channel;
      case "closing":
      case "quarantined":
        return false;
    }
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
    // No channel: a create or resume starts from EMPTY, so nothing is bound to
    // this session for the duration of the claim.
    this.#sessionSlots.set(sessionId, { state: "establishing", settled, channel: undefined });
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

  /**
   * Claims a LIVE slot for a rewind and restores the predecessor if the rewind
   * does not install a successor.
   *
   * Deliberately NOT `#withSessionSlotClaimed`. That helper clears the slot when
   * an establishment fails, which is right for create and resume — both start
   * from EMPTY, so clearing restores what was there. A rewind starts from LIVE,
   * so clearing would publish an EMPTY slot for a session whose process is still
   * running and startable: the next create would spawn a second process beside
   * it, and nothing would ever close the first.
   *
   * The restore is identity-checked against this call's own claim, so a
   * successful rewind (which overwrites the slot with its own LIVE arm) and a
   * concurrent close (which moves the slot on) are both left alone.
   */
  async #withRewindSlotClaimed(
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
    rewind: () => Promise<DriverRollbackResult>,
  ): Promise<DriverRollbackResult> {
    const rewinding = rewind();
    const settled = rewinding.then(
      () => undefined,
      () => undefined,
    );
    // The PREDECESSOR's channel stays bound for the whole claim. Its process is
    // still up and still emitting, and the frames it emits belong to this
    // session's transcript whether or not the fork beside it succeeds.
    this.#sessionSlots.set(sessionId, {
      state: "establishing",
      settled,
      channel: predecessor.channel,
    });
    try {
      return await rewinding;
    } finally {
      const slot = this.#sessionSlots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#sessionSlots.set(sessionId, { state: "live", session: predecessor });
      }
    }
  }

  // Drops every run route pointing at this session. Deliberately does NOT touch
  // the slot: route retirement and slot transition are separate concerns, and
  // fusing them is what previously let a close free the slot as a side effect of
  // clearing routes.
  /**
   * Rules the text-neutralization tripwire on a settling turn (T3.18).
   *
   * Claude serializes turns per session and its terminal frame names no run, so
   * the run that just ended is the one routed to this session — the same
   * identity argument `#retireRunRoutes` already runs on.
   *
   * ONE terminal settles ONE turn, so exactly one run may consume this
   * terminal's evidence: the oldest with a frame still awaiting settlement.
   * Ordering is taken over PENDING FRAMES, not over routes, because the two
   * sets genuinely differ — a run whose failed write was already ruled by
   * `#ruleFailedOpeningFrame` on the dead-channel arm keeps its route, so that
   * `findChannelForRun` refuses it loudly rather than answering `undefined`,
   * while its registration is long consumed. Ordering by route would let that
   * run consume the evidence a live one needed. Spreading one turn's evidence
   * across every correlated run is the masking this tripwire exists to prevent:
   * a good turn would vouch for text that never ran.
   *
   * Any FURTHER correlated run is ruled against no evidence at all, which trips
   * it. That is not a guess: `#retireRunRoutes` destroys every route for this
   * session on this same terminal, so a second correlated run's frame is, at
   * this moment, provably never going to be confirmed — text written to the
   * provider with no model turn attributable to it, which is exactly what the
   * refusal says. The driver does not create that state; this is what it does
   * if the state ever appears.
   *
   * One way that state now arises is worth naming: a frame RETAINED by
   * `#ruleFailedOpeningFrame` on the serviceable-channel arm stays pending, so
   * it holds position 0 here and a later run that wrote cleanly is ruled
   * against no evidence. The trip is then attributed to the wrong run. That is
   * the fail-closed direction and the deliberate price of retention — the
   * alternative is a silent pass on a frame whose delivery is in doubt — and
   * the session is quarantined and disposed either way.
   *
   * This band reads NO member of `terminalFrame`. It hands the value to the
   * normalizer's classifier — the module that owns frame content — and acts on
   * the classification alone.
   */
  #ruleTextNeutralizationTripwire(sessionId: SessionId, terminalFrame: unknown): void {
    const correlatedRunIds = [...this.#sessionIdByRunId]
      .filter(([, boundSessionId]) => boundSessionId === sessionId)
      .map(([runId]) => runId)
      .filter((runId) => this.#outboundFrameTripwire.hasPendingFrame(runId));
    if (correlatedRunIds.length === 0) {
      return;
    }
    const settlingClassification = classifyClaudeTurnEvidence(terminalFrame);
    let tripped = false;
    for (const [framePosition, runId] of correlatedRunIds.entries()) {
      const classification =
        framePosition === 0 ? settlingClassification : UNRECOGNIZED_TURN_EVIDENCE;
      const decision = this.#outboundFrameTripwire.settle(runId, classification);
      if (!decision.tripped) {
        continue;
      }
      if (!tripped) {
        tripped = true;
        // Quarantined FIRST, and on BOTH axes, so that a caller reacting
        // synchronously to the failure cannot reach the process that just
        // swallowed the text by either door. The run key alone is not enough:
        // `startRun` resolves a SESSION, so a run-keyed refusal would leave the
        // next run free to dispatch onto the same channel.
        this.#providerBindingQuarantine.disposeSession(sessionId);
      }
      this.#providerBindingQuarantine.disposeRun(runId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeTextNeutralizationRunFailure(decision),
      );
    }
    if (tripped) {
      this.#disposeQuarantinedSession(sessionId);
    }
  }

  /**
   * Tears down the channel a tripwire trip condemned (T3.18).
   *
   * Reuses `#disposeHeldChannel` rather than inventing a second teardown: this
   * is the same close every other disposal performs, so the slot transitions,
   * the retained-channel quarantine on a process that will not exit, and the
   * per-session band cleanup are the ones the rest of the driver already relies
   * on. The promised recovery is a fresh spawn, which is what a close makes
   * possible.
   *
   * Detached on purpose: the only caller runs inside a channel's synchronous
   * terminal listener, which must neither wait on a child's death nor be
   * unwound by one. The teardown is BEST-EFFORT and the refusal is not — the
   * quarantine entry is installed before this runs, so every later resolution
   * refuses whether or not the process actually exits.
   */
  #disposeQuarantinedSession(sessionId: SessionId): void {
    const live = this.#findLiveSession(sessionId);
    if (live === undefined) {
      return;
    }
    void this.#disposeHeldChannel(sessionId, live.channel).catch(() => {
      // Swallowed HERE and recorded THERE: a rejected dispose has already moved
      // the slot to `quarantined` with the channel retained, which is this
      // driver's own record of a process that would not exit and the handle a
      // later close retries through. Rethrowing would only surface as an
      // unhandled rejection out of a channel's terminal listener.
    });
  }

  // A throwing consumer must not become a second failure on top of the one being
  // reported: the run terminal is the guarantee, and losing it because a listener
  // threw would leave the swallowed turn with no record at all.
  #reportTextNeutralizationFailure(
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ): void {
    try {
      this.#onTextNeutralizationFailure(sessionId, runId, failure);
    } catch (error) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "text_neutralization_trip_report_failed",
        rawWireType: null,
        dispositionReason: describeFailure(error),
        details: { sessionId, runId, providerFailureDetail: failure.providerFailureDetail },
      });
    }
  }

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
