// The Claude driver's session and run lifecycle: `createSession`, `resumeSession`, `startRun`,
// `interruptRun` and `closeSession`. The other driver operations live in sibling modules.
//
// A resume must never silently replace the provider session under the same canonical run:
// - `DriverResumeResult`'s `failed` arm carries no `bindingId`, so failed and resumed cannot mix.
// - It counts as `resumed` only when the transport reports the session id the handle names
//   (Claude starts a fresh session when the recorded working directory changed).
// - Every refused attachment is disposed before `failed` is returned.
//
// Provider-process concerns sit behind the injected `ClaudeSessionTransport` and
// `ClaudeSessionChannel` ports: this module spawns nothing and reads no environment variable, so
// it cannot leak a `CLAUDE_CODE_OAUTH_TOKEN`. Errors here carry a registered `driver.*` code.

import {
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DriverAuthProbeResultSchema,
  DriverResumeResultSchema,
  ForkConversationResultSchema,
  ProviderCommandEntrySchema,
  ProviderOutputSpeedStateSchema,
  type CallbackToolInvocation,
  type DriverTranscriptReplayResult,
  type ReplayTranscriptParams,
  type CallbackToolResult,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCompactionResult,
  type DriverResumeResult,
  type ForkConversationResult,
  type ExecutionPosture,
  type InterruptRunParams,
  type ListProviderCommandsParams,
  type McpServerStatusProducer,
  type ProviderCommandEntry,
  type ProviderCommandListResult,
  type ProviderOutputSpeedState,
  type ProviderSessionHandle,
  type RecoveryCondition,
  type ResumeSessionParams,
  type ForkConversationParams,
  type RunId,
  type SessionCallbackTool,
  type SessionId,
  type StartRunParams,
  type SubagentDefinition,
  type SubagentPolicy,
} from "@ai-sidekicks/contracts";
import { createHash } from "node:crypto";

import { PendingCompactionRegistry, type CompactionWaitScheduler } from "../../compaction-wait.js";
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
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type SpawnEnvPair,
} from "../../spawn-env.js";
import {
  classifyProviderRequestFailure,
  mayReattemptAfterDefinitelyUnsent,
  type ProviderRequestFailureObservation,
} from "../../transcript/failure-mapping.js";
import {
  assertReplayReconstituted,
  PostReplayAssertionFailedError,
  ReplayTargetLedger,
  type PostReplayVerdict,
  type ReplayTargetAbandonmentCause,
  type ReplayTargetReadback,
  type ReplayTargetReadbackReader,
  type SeededTranscriptFrame,
} from "../../transcript/replay-assertion.js";

import {
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  RuntimeBindingQuarantine,
  UNRECOGNIZED_TURN_EVIDENCE,
  composeSupersededDeliveryRunFailure,
  composeTextNeutralizationRunFailure,
  type CallerDeclaredFrameOrigin,
  type OutboundTextFrame,
  type TextNeutralityMechanismGrade,
  type TextNeutralizationRunFailure,
} from "../outbound-frame.js";
import {
  CLAUDE_DRIVER_NAME,
  type ClaudeTranscriptReplayReading,
  type ClaudeTranscriptReplaySurfaceReader,
  type ClaudeTranscriptSeedOutcome,
  type ClaudeTranscriptSeedingSurface,
} from "./capabilities.js";
import {
  CLAUDE_SUBAGENT_START_SIGNAL,
  ClaudeTerminalEmissionGate,
  classifyClaudeFrameFamilyForRouting,
  classifyClaudeTurnEvidence,
  normalizeClaudeSubagentLifecycle,
  type ClaudeSubagentLifecycleSignal,
} from "./event-normalizer.js";
import { mintUuidV7 } from "../../../ids/uuid-v7.js";

// A refused attach hides the previous leg's work; consumers treat it as `irreversible`.
const CLAUDE_RESUME_SPAN_CLASSIFICATION = "unclassifiable" as const;

const UNDESCRIBED_FAILURE_DETAIL =
  "The Claude provider transport failed the resume with no describable detail.";

/**
 * How long a user-triggered compaction waits for typed evidence before it is reported failed; the
 * provider is never canceled and a late boundary frame keeps its ordinary route.
 */
export const CLAUDE_COMPACTION_WAIT_MS: number = 120_000;

// Bare name: `system/init` lists `slash_commands` without the leading slash.
const CLAUDE_COMPACTION_COMMAND_NAME = "compact";

const CLAUDE_COMPACTION_COMMAND_TEXT = `/${CLAUDE_COMPACTION_COMMAND_NAME}`;

// A literal here, not a parameter: the `driver_command` origin is exempt from the text-
// neutralization tripwire, so a caller-supplied value would let user words through.
const CLAUDE_COMPACTION_FRAME_ORIGIN = "driver_command";

/** One outbound user-authored text frame; nominal, so only the frame writer can produce one. */
export type ClaudeUserTextFrame = OutboundTextFrame;

/**
 * How far a failed `sendUserText` got; `indeterminate` is anything at or after the hand-off, since
 * a partial line can be read as a whole message.
 */
export type ClaudeUserTextDelivery = "unsent" | "indeterminate";

/**
 * The settled outcome of one `sendUserText`, reported rather than thrown: a rejection cannot tell
 * "nothing left" from "the bytes are gone and the turn may be running".
 */
export type ClaudeUserTextWriteAttempt =
  | { readonly settled: "written" }
  | {
      readonly settled: "failed";
      readonly delivery: ClaudeUserTextDelivery;
      readonly cause: unknown;
    };

// `refusalShape` is never supplied: the provider answers a turn, never the write.
function observeClaudeUserTextFailure(
  delivery: ClaudeUserTextDelivery,
): ProviderRequestFailureObservation {
  return { delivery: delivery === "unsent" ? "unsent" : "indeterminate" };
}

// `cancel` is not a control-request subtype in the pinned registry, so a cancel rides
// `cancelQueued` on `interrupt`; the transport realizes it per `interrupt_cancel_queued_v1`.
interface ClaudeInterruptControlRequest {
  readonly subtype: "interrupt";
  readonly cancelQueued: boolean;
}

/** The control requests a channel can send; closed so an unrouted subtype cannot typecheck. */
export type ClaudeControlRequest = ClaudeInterruptControlRequest;

/** The settled `control_response` payload; a typed refusal is feature-detected at call time. */
export type ClaudeControlResponse =
  | { readonly subtype: "success"; readonly response?: Record<string, unknown> | undefined }
  | { readonly subtype: "error"; readonly error: string };

/** Why a channel is being torn down, so the transport can tell an intended close from a crash. */
export type ClaudeChannelDisposalReason =
  | "session_closed"
  | "spawn_identity_diverged"
  | "resume_identity_diverged"
  | "resume_result_invalid"
  // Anything that failed between the transport handing over a live channel and its registration;
  // the provider did nothing wrong.
  | "establishment_failed";

/** One frame's cumulative token readings; the driver differences them, the transport must not. */
interface ClaudeCumulativeUsageObservation {
  /** The turn the metered frame itself names, or `null` where it names none. */
  readonly namedTurnId: string | null;
  readonly cumulative: CumulativeAxisReadings;
  /** The wire's own per-turn figure where one exists; a cross-check only. */
  readonly declaredPerTurn?: CumulativeAxisReadings | null;
}

/** The `system/init` declaration, verbatim and whole; the cap applies to the composed reply. */
export interface ClaudeHandshakeDeclaration {
  /** `slash_commands` — interactively invocable, names WITHOUT a leading `/`. */
  readonly slashCommands: readonly string[];
  readonly skills: readonly string[];
  /** Run in the provider's terminal UI, not invocable here; kept out of `invocableCommandNames`. */
  readonly terminalSlashCommands: readonly string[];
  readonly fastModeState: string | null;
  readonly fastModeDisabledReason: string | null;
}

/** The only evidence that admits `applied`; `boundaryPosition` is `null` if none is named. */
interface ClaudeCompactionBoundaryObservation {
  readonly boundaryPosition: number | null;
}

/** The routing-relevant facts of one inbound stream frame, not the frame itself. */
export interface ClaudeInboundFrameObservation {
  /** The composed `type/subtype` wire kind, verbatim and untrusted. */
  readonly frameKind: string;
  /** The provider-attributed subagent id, or `null` for a frame on the session's own thread. */
  readonly subagentId: string | null;
  readonly cumulativeUsage: ClaudeCumulativeUsageObservation | null;
  readonly subagentLifecycle: ClaudeSubagentLifecycleSignal | null;
  /** The `system/init` declaration; it rides the ordinary observation so routing always sees it. */
  readonly handshake: ClaudeHandshakeDeclaration | null;
  readonly compactionBoundary: ClaudeCompactionBoundaryObservation | null;
}

/** One live Claude provider process, already handshaken through `system/init`. */
export interface ClaudeSessionChannel {
  readonly providerSessionId: string;

  /**
   * Whether no further `onTurnTerminal` can arrive (not merely that the process exited); a channel
   * that can deliver none must say `true`. `false` is the safe default: it costs one slot.
   */
  readonly isClosed: boolean;

  /**
   * Writes one frame. Report a failure as a `failed` attempt, not a rejection: only the transport
   * knows whether it came before the first byte, and a rejection is treated as `indeterminate`.
   */
  sendUserText(frame: ClaudeUserTextFrame): Promise<ClaudeUserTextWriteAttempt>;

  sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse>;

  /**
   * Registers the turn-terminal observer (replacing any earlier one); the transport invokes it for
   * a terminal stream frame of this session's turn. It retires the run route, since interrupt is
   * channel-level and a late one would land on the next turn.
   */
  onTurnTerminal(listener: (terminalFrame: unknown) => void): void;

  /**
   * Registers the inbound-frame observer (replacing any earlier one). The transport calls it for
   * every frame before its own consumer and delivers only DELIVER routes (`project`,
   * `route-connection-scoped`, `carve-out-interactive-request`); else a child's output would land
   * in the parent's timeline.
   */
  onInboundFrame(observer: (observation: ClaudeInboundFrameObservation) => ThreadFrameRoute): void;

  /**
   * Tears the provider process down; supervision (signals, exit confirmation, orphan sweep) is the
   * transport's, and a rejecting `dispose` must keep supervising. A rejected session-bound channel
   * stays quarantined and the next `closeSession` retries it; a refused foreign-id channel is
   * dropped, and only the refusal text reports the rejection.
   */
  dispose(reason: ClaudeChannelDisposalReason): Promise<void>;
}

/**
 * The spawn-bound legs shared by create, resume and rewind. A resume is a fresh spawn, so a leg
 * omitted there would be shed (a posture-less relaunch runs unsandboxed).
 */
export interface ClaudeSpawnBoundLegs {
  readonly sessionId: SessionId;
  readonly admittedCostCapUsdMicros: number | undefined;
  readonly executionPosture: ExecutionPosture | undefined;
  readonly callbackTools: SessionCallbackTool[] | undefined;
  /** The policy as realized: unmediatable definitions are withheld and `maxDepth` is clamped. */
  readonly subagentPolicy: SubagentPolicy | undefined;
  /** Definitions withheld from `subagentPolicy`, with reasons; observability only. */
  readonly withheldSubagentDefinitions: readonly ClaudeWithheldSubagentDefinition[];
  /** The `--settings` sandbox document composed from `executionPosture`, not per transport. */
  readonly sandboxSettings: ClaudeSandboxSettings | undefined;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly onCallbackToolCall:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  /**
   * The daemon-hosted MCP server serving the admitted `callbackTools`; the transport realizes it as
   * `--mcp-config` and maps invocations back via `registryNamesByProviderName`. Present only with
   * `onCallbackToolCall`.
   */
  readonly callbackToolServer: ClaudeCallbackMcpServerDescriptor | undefined;
  /** Serializes beyond-cap subagent tool calls; `undefined` without an enabled subagent policy. */
  readonly subagentAdmission: ClaudeSubagentAdmissionPort | undefined;
  readonly onMcpServerStatus: McpServerStatusProducer | undefined;
  /**
   * Variables the child must carry (for this CLI, the auto-update opt-out), applied last and never
   * shed, or a provider build could replace itself mid-session and invalidate the recorded version.
   */
  readonly mandatedEnvironment: readonly SpawnEnvPair[];
  /** The requested output-speed level; spawn-bound because the provider settles it at start. */
  readonly outputSpeed: string | undefined;
}

/** The request to start a provider process for a new session. */
export interface ClaudeSessionSpawnRequest extends ClaudeSpawnBoundLegs {
  // Pinned by the driver as `--session-id`; not the daemon's `SessionId`, since a relaunch spawns a
  // second process for the same session and a reused id would collide with the leg shutting down.
  readonly providerSessionId: string;
  readonly config: Record<string, unknown>;
}

/** The request to re-attach to an existing provider session by its resume handle. */
export interface ClaudeSessionResumeRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string;
}

/**
 * A conversation rewind: `--resume-session-at <message-uuid>` with `--fork-session`, carrying the
 * spawn-bound legs because a fork is a fresh process. The transport resolves `targetPosition` to
 * the message uuid (throwing on a position naming no boundary), runs the fork from the identical
 * cwd (a change makes Claude start a fresh session), and never uses `--rewind-files`, which
 * restores only Write and Edit.
 */
export interface ClaudeSessionRewindRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string;
  readonly targetPosition: number;
}

/** A live provider process the transport attached, with its announced session id. */
export interface ClaudeSessionAttachment {
  // Announced on `system/init`; compared with the requested id, never assumed to match.
  readonly providerSessionId: string;
  readonly channel: ClaudeSessionChannel;
}

/** An attachment produced by a resume, carrying the position it resumed at. */
export interface ClaudeResumedSessionAttachment extends ClaudeSessionAttachment {
  // Required, so a transport cannot report a resume it cannot evidence.
  readonly sessionPosition: number;
}

/** A completed rewind; `sessionPosition` is where the fork landed, not the requested position. */
export interface ClaudeRewoundSessionAttachment extends ClaudeSessionAttachment {
  readonly sessionPosition: number;
}

/** A usable credential found by the zero-turn auth probe; the negative outcomes throw. */
export interface ClaudeAuthProbeReading {
  /** Non-PII diagnostics only, never credential material or a seat email; bounded by the driver. */
  readonly detail?: string | undefined;
}

/** What the auth probe's spawn must carry: standalone, since a probe binds to no session. */
export interface ClaudeAuthProbeRequest {
  /**
   * Required: the probe recurs, so an unsuppressed one could update the installation under the
   * readings admission relies on.
   */
  readonly mandatedEnvironment: readonly SpawnEnvPair[];
}

// One composition for the spawn legs and the auth probe, so the two cannot drift.
function composeClaudeMandatedEnvironment(): readonly SpawnEnvPair[] {
  return buildProviderSpawnEnv({
    driverName: "claude",
    // Empty: this side holds no curated environment; the transport composes these pairs over its
    // base.
    baseEnv: [],
    // Host semantics: the transport compares names under the same rule.
    hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
  });
}

/** The provider-process port: spawn, resume and rewind a session, and probe authentication. */
export interface ClaudeSessionTransport {
  /**
   * Whether this transport writes `--mcp-config` for `callbackToolServer`. Required so it is never
   * decided by omission: `false` withholds the registry rather than expose tools nothing delivers.
   */
  readonly realizesCallbackToolRegistration: boolean;

  /**
   * Starts a provider process for a new session. The child environment is constructed, never
   * inherited: the curated base plus run-provisioned variables, minus the names denied by the
   * request's own `sandboxSettings.credentialPolicyRef` (never a policy from an earlier spawn).
   * `CLAUDE_*` and `CLAUDECODE*` are stripped, and configuration comes through `--settings`, not
   * `~/.claude`. `mandatedEnvironment` is applied last, replacing same-named entries. This holds
   * for `resumeSession` and `rewindSession`. A determinate logged-out failure throws
   * `ClaudeAuthenticationRequiredError` (the only route to `reauth-required`), any other failure
   * throws something else.
   */
  spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment>;
  /** Re-attaches to an existing provider session, with `spawnSession`'s auth-failure obligation. */
  resumeSession(request: ClaudeSessionResumeRequest): Promise<ClaudeResumedSessionAttachment>;
  /**
   * Forks the session at a rewind target. Separate from `resumeSession` because a resume landing on
   * a different session id is a failure while a rewind landing on the same id is one; it carries
   * `spawnSession`'s obligations.
   */
  rewindSession(request: ClaudeSessionRewindRequest): Promise<ClaudeRewoundSessionAttachment>;
  /**
   * The zero-turn authentication probe; reaching a working `system/init` is the evidence (no
   * authless probe exists, measured). The transport spends no turn, leaks no credential material,
   * tears down what it starts on every path, carries `request.mandatedEnvironment`, and throws
   * `ClaudeAuthenticationRequiredError` for a determinate logged-out reading, else any other error.
   */
  probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading>;
}

/** A constant, not a port member: the opening text is the user's own message. */
const RUN_OPENING_FRAME_ORIGIN: CallerDeclaredFrameOrigin = "human_text";

/** The daemon-owned facts `startRun` needs that `StartRunParams` lacks. */
export interface ClaudeRunDispatch {
  readonly sessionId: SessionId;
  readonly openingText: string;
}

/** Resolves a run's dispatch facts (wired by the daemon), or `undefined` when it has none. */
export interface ClaudeRunDispatchResolver {
  resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined>;
}

/**
 * The read `ClaudeInterventionDispatcher` needs. It throws for a run whose binding a
 * text-neutralization trip disposed: `undefined` ("no channel yet") would invite a retry into a
 * process that swallowed the user's words.
 */
export interface ClaudeRunChannelLookup {
  findChannelForRun(runId: RunId): ClaudeSessionChannel | undefined;
}

/** Why the driver refused to service a session or run operation. */
export type ClaudeSessionUnavailableReason =
  | "session_already_live"
  | "session_id_pin_diverged"
  | "no_live_session"
  | "no_live_run"
  | "run_already_dispatched"
  | "session_turn_in_flight"
  | "run_dispatch_unresolved"
  | "execution_posture_mismatch"
  | "output_schema_unbound"
  | "output_schema_mismatch"
  | "provider_account_unusable"
  | "provider_account_ambiguous";

const SESSION_UNAVAILABLE_MESSAGES: Readonly<Record<ClaudeSessionUnavailableReason, string>> = {
  session_already_live:
    "A live Claude session is already bound to this session; create would orphan it.",
  session_id_pin_diverged:
    "The spawned Claude process announced a session id other than the pinned one.",
  no_live_session: "No live Claude session is bound to this session.",
  no_live_run: "No live Claude session is bound to this run.",
  run_already_dispatched:
    "This run's opening frame is already on the wire and its turn has not settled.",
  session_turn_in_flight:
    "Another run's frame is still pending on this Claude session; its turn has not settled.",
  run_dispatch_unresolved: "The daemon resolved no Claude dispatch for this run.",
  execution_posture_mismatch:
    "The run's execution posture does not match the posture the Claude session was spawned with.",
  output_schema_mismatch:
    "The run's output schema differs from the schema the Claude session was spawned with.",
  output_schema_unbound:
    "The run requires schema-constrained output but the Claude session was spawned without a schema.",
  // `unusable`: one source arrived malformed. `ambiguous`: two well-formed sources disagree.
  provider_account_unusable:
    "The request named a provider account that is present but empty; an account was meant to be bound and none was.",
  provider_account_ambiguous:
    "Two resolvers name different provider accounts for this Claude session.",
};

/** The structured fields of a `ClaudeSessionUnavailableError`. */
export interface ClaudeSessionUnavailableFields {
  readonly driverId: string;
  readonly reason: ClaudeSessionUnavailableReason;
  readonly sessionId: SessionId | undefined;
  readonly runId: RunId | undefined;
}

/** The optional session, run and free-text detail attached to a refusal. */
export interface ClaudeSessionUnavailableContext {
  readonly sessionId?: SessionId | undefined;
  readonly runId?: RunId | undefined;
  readonly detail?: string | undefined;
}

/**
 * Every driver-side refusal to service a session or run operation. It rides the registered
 * `driver.unavailable` (503), and `reason` carries the finer distinction.
 */
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

/** The structured fields of a `ClaudeControlRequestRefusedError`. */
export interface ClaudeControlRequestRefusedFields {
  readonly driverId: string;
  readonly subtype: ClaudeControlRequest["subtype"];
  readonly providerError: string;
}

/**
 * A control request the running dispatcher refused. A refusal arrives as a typed
 * `control_response` error (registry membership is not availability), so it rides the registered
 * `driver.capability_unsupported` (400).
 */
export class ClaudeControlRequestRefusedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: ClaudeControlRequestRefusedFields;

  constructor(subtype: ClaudeControlRequest["subtype"], providerError: string) {
    super(`The Claude CLI refused the ${subtype} control request.`);
    this.name = "ClaudeControlRequestRefusedError";
    this.fields = { driverId: CLAUDE_DRIVER_NAME, subtype, providerError };
  }
}

// Thrown when a replay against a build with a seeding surface fails; its own class because the
// closed `reason` union of `ClaudeSessionUnavailableError` has no member for it.
class ClaudeTranscriptReplayFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTranscriptReplayFailedError";
  }
}

/** Converts a rejecting readback reader into the `unreadable` arm, as the seam's contract says. */
async function readReplayTargetSafely(
  read: ReplayTargetReadbackReader,
  targetProviderSessionId: string,
): Promise<ReplayTargetReadback> {
  try {
    return await read(targetProviderSessionId);
  } catch (error: unknown) {
    return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// Parses one exported transcript frame for the Claude replay leg, failing closed: skipping an
// unreadable frame would be an undeclared loss that falsifies the `applied` arm's loss list.
function readRenderedTranscriptFrameForClaudeReplay(frame: unknown): SeededTranscriptFrame {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw new ClaudeTranscriptReplayFailedError(
      "A transcript frame handed to the Claude replay leg was not an object.",
    );
  }
  const candidate = frame as Record<string, unknown>;
  const position = candidate["position"];
  const role = candidate["role"];
  const segments = candidate["segments"];
  if (typeof position !== "number" || !Number.isInteger(position)) {
    throw new ClaudeTranscriptReplayFailedError(
      "A transcript frame handed to the Claude replay leg carried no integer position.",
    );
  }
  if (role !== "user" && role !== "assistant") {
    throw new ClaudeTranscriptReplayFailedError(
      `A transcript frame at position ${String(position)} carried the unrecognized role "${String(role)}".`,
    );
  }
  if (!Array.isArray(segments)) {
    throw new ClaudeTranscriptReplayFailedError(
      `The transcript frame at position ${String(position)} carried no segment list.`,
    );
  }
  const bodyParts: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "object" || segment === null || Array.isArray(segment)) {
      throw new ClaudeTranscriptReplayFailedError(
        `The transcript frame at position ${String(position)} carried a segment that was not an object.`,
      );
    }
    const kind = (segment as Record<string, unknown>)["kind"];
    if (kind === "text" || kind === "reasoning") {
      const text = (segment as Record<string, unknown>)["text"];
      if (typeof text !== "string") {
        throw new ClaudeTranscriptReplayFailedError(
          `A "${String(kind)}" segment of the transcript frame at position ${String(position)} carried no text.`,
        );
      }
      if (text.length > 0) {
        bodyParts.push(text);
      }
      continue;
    }
    if (kind === "tool_call" || kind === "tool_result") {
      continue;
    }
    // An unrecognized kind refuses, so a new canonical kind fails loudly.
    throw new ClaudeTranscriptReplayFailedError(
      `The transcript frame at position ${String(position)} carried an unsupported segment kind "${String(kind)}"; refusing to seed a frame this driver cannot represent.`,
    );
  }
  return { position, role, text: bodyParts.join("\n\n") };
}

/**
 * Thrown when a replay cannot be served (no surface reader bound, or the build's probe refused);
 * thrown rather than returned as `degraded`, which is the memo deliverer's.
 */
export class ClaudeTranscriptReplayUnsupportedError extends Error {
  constructor(reason: string) {
    super(
      `The installed Claude build exposes no prior-turn seeding surface this driver can drive: ${reason}`,
    );
    this.name = "ClaudeTranscriptReplayUnsupportedError";
  }
}

/**
 * Thrown by a transport for an expired or missing credential; the only route to `reauth-required`.
 * Rides `driver.not_authenticated`.
 */
export class ClaudeAuthenticationRequiredError extends Error {
  readonly code = "driver.not_authenticated" as const;
  readonly fields: { readonly driverId: string };

  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthenticationRequiredError";
    this.fields = { driverId: CLAUDE_DRIVER_NAME };
  }
}

// `name` and `message` may be accessors and a throwing getter would throw inside the caller's
// catch; a non-string falls through, since stringifying could put a credential-bearing `toString`
// in a durable row.
function readErrorStringProperty(error: Error, property: "message" | "name"): string | undefined {
  try {
    const value: unknown = error[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

// Renders a thrown value as one operator-safe line; total, since every caller is a `catch` block.
// It never serializes an arbitrary value (no `String(error)` fallback): `providerFailureDetail` is
// persisted and could leak spawn configuration or credentials.
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

// `wireFreeFormString` needs 1..MAX characters, one non-whitespace character and no NUL; trim
// before truncating.
function sanitizeFailureDetail(detail: string): string {
  const trimmed = detail.replaceAll("\0", "").trim();
  if (trimmed.length === 0) {
    return UNDESCRIBED_FAILURE_DETAIL;
  }
  return trimmed.length <= DRIVER_FAILURE_DETAIL_MAX_LEN
    ? trimmed
    : trimmed.slice(0, DRIVER_FAILURE_DETAIL_MAX_LEN);
}

// Builds a probe result without throwing; a detail the strict envelope refuses is dropped, since
// `status` carries the decision.
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

// Names the evidence, not a credential source the probe did not report.
const CLAUDE_AUTH_PROBE_REACHED_DETAIL = "the provider answered the zero-turn auth probe";

function classifyRecoveryCondition(error: unknown): RecoveryCondition {
  return error instanceof ClaudeAuthenticationRequiredError ? "reauth-required" : "recovery-needed";
}

// The `ExecutionPosture` axes a spawn realizes, in mismatch-report order; `startRun` refuses a run
// differing on any (see `#assertSpawnBoundRealization`). Enumerated from the contract type, not
// sampled: a skipped axis would admit a run into a process whose sandbox differs from its posture.
// Set axes compare order-insensitively, scalars strictly.
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
  // Read through the widened view: `credentialPolicyRef` is `never` on `trusted`, and
  // `profileName` is optional.
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

// Order-insensitive but multiplicity-sensitive: a duplicated root is a different declaration.
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

// Stable serialization: keys sorted recursively, array order kept (it is meaningful in JSON
// Schema, e.g. `prefixItems`). `undefined` keys are dropped, as `JSON.stringify` drops them.
function canonicalizeJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    // Code-unit order, not `localeCompare`: the digest must not depend on the host locale.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeJsonValue(entryValue)}`)
    .join(",")}}`;
}

// A boolean "is one bound?" would admit a run with schema B into a process spawned with schema A.
function digestOutputSchema(outputSchema: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJsonValue(outputSchema)).digest("hex");
}

// Supervised postures never let commands run outside the sandbox: every non-`trusted` posture runs
// with the always-armed permission prompt, and the daemon's prompt tool adjudicates every call.
const CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS = false;

/** The subagent depth ceiling this driver clamps to; a policy asking for less gets less. */
export const CLAUDE_SUBAGENT_MAX_DEPTH_CEILING: number = 5;

// Permission modes under which a subagent's tool calls still pass the daemon's permission prompt;
// a mode that skips it or is unknown cannot be held at the boundary. An absent mode inherits the
// session's always-armed prompt.
const CLAUDE_BOUNDARY_MEDIATABLE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "plan",
]);

/** Why one subagent definition was withheld from the spawn. */
interface ClaudeWithheldSubagentDefinition {
  readonly name: string;
  readonly reason: string;
}

/** A subagent policy split into what this driver will spawn and what it refused. */
interface ClaudeSubagentPolicyRealization {
  readonly policy: SubagentPolicy;
  readonly withheld: readonly ClaudeWithheldSubagentDefinition[];
}

// Admits the definitions this driver can mediate at the daemon boundary and withholds the rest;
// `maxDepth` is clamped, not refused, since depth can be met partially and a definition cannot.
function realizeClaudeSubagentPolicy(policy: SubagentPolicy): ClaudeSubagentPolicyRealization {
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

/** Fails the waiters of a session whose process is going away; both teardown paths call it. */
function disposeSubagentAdmission(legs: ClaudeSpawnBoundLegs): void {
  legs.subagentAdmission?.dispose();
}

/** Releases one held subagent slot. Idempotent: a double release frees one slot. */
export type ClaudeSubagentSlotRelease = () => void;

/** One queued admission, retained so a disposal can name who it abandoned. */
interface ClaudeSubagentSlotWaiter {
  readonly subagentId: string;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

/**
 * The port the transport awaits before dispatching a subagent-originated tool call. The daemon
 * enforces `maxConcurrent` at the tool-call boundary, since the provider documents no cap. The
 * release from `admit` must be called when the call settles, on every path; there is no timeout
 * (reclaiming on a guess could exceed the cap), and `admit` rejects once its session is disposed.
 */
export interface ClaudeSubagentAdmissionPort {
  admit(subagentId: string): Promise<ClaudeSubagentSlotRelease>;
  /** Fails every waiter. Called when the guarded session is disposed. */
  dispose(): void;
}

/**
 * Holds beyond-cap subagent tool calls at the daemon boundary, in arrival order.
 * `observeLiveSubagentCount` only reports a breach the gate cannot hold (subagents that call no
 * tool) as a diagnostic, never a failed run.
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
    // A cap below one would deadlock every call, so it floors at one; `enabled: false` builds no
    // gate.
    this.#maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  }

  /** Slots currently held. Exposed for the breach comparison and for tests. */
  get heldSlotCount(): number {
    return this.#heldSlotCount;
  }

  get waitingCallCount(): number {
    return this.#waiters.length;
  }

  /** Takes a slot, waiting in arrival order when all are held. Rejects once disposed. */
  async admit(subagentId: string): Promise<ClaudeSubagentSlotRelease> {
    this.#assertLive(subagentId);
    if (this.#heldSlotCount < this.#maxConcurrent) {
      // Take the slot in the same synchronous step as the test; after an `await` a second caller
      // would read the old count.
      this.#heldSlotCount += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        this.#waiters.push({ subagentId, resolve, reject });
      });
      // The releasing call handed its slot over without decrementing, so the count already includes
      // this admission; re-incrementing here would open a window for a third caller.
      this.#assertLive(subagentId);
    }
    let released = false;
    return () => {
      // Idempotent: a transport releasing on both a success path and a `finally` must not free two.
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

  /** Fails every waiter and later admission; held slots stay, their releases are in flight. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // Drain by splice, not iterate-then-clear: a rejection handler that re-enters `admit` must
    // find an empty queue, not one being walked.
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

  /** Records the live subagent count observed; one diagnostic per new ceiling, not a stream. */
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

/** The server every callback tool is served under; the provider namespaces tools by server. */
export const CLAUDE_CALLBACK_MCP_SERVER_NAME: string = "sessions";

/** Why the registry is withheld: the bound transport does not write the `--mcp-config` for it. */
export const CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL: string =
  "the bound Claude transport declares it does not realize the callback-tool --mcp-config registration, so no invocation could arrive; the registry is withheld rather than offered undeliverable";

/**
 * Composes the provider-facing name `mcp__<server>__<tool>`. It is never parsed back, since a tool
 * name containing the separator would be ambiguous; the descriptor carries a reverse map instead.
 */
export function composeClaudeProviderToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** The daemon-hosted ephemeral MCP server one session's callback tools ride. */
export interface ClaudeCallbackMcpServerDescriptor {
  readonly serverName: string;
  /** The admitted registry, in registration order and de-duplicated by name. */
  readonly tools: readonly SessionCallbackTool[];
  /** Provider-facing name -> registry name. */
  readonly registryNamesByProviderName: ReadonlyMap<string, string>;
}

/** Builds the MCP descriptor for a registry; duplicate names collapse last-wins, like the host. */
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
 * The `--settings` sandbox document one posture composes to. The transport resolves
 * `credentialPolicyRef` into `permissions.deny` `Read` rules beside the environment scrub.
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
 * Composes the sandbox settings document for a posture. `failIfUnavailable` is `true` on every
 * arm: a sandboxed posture must refuse to start rather than run unsandboxed.
 */
export function composeClaudeSandboxSettings(posture: ExecutionPosture): ClaudeSandboxSettings {
  const sandboxed = posture.mode !== "trusted";
  return {
    sandbox: {
      enabled: sandboxed,
      failIfUnavailable: true,
      allowUnsandboxedCommands: sandboxed ? CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS : true,
      filesystem: {
        // Empty, not omitted: an omitted list asks for the provider's default.
        allowWrite: posture.mode === "readonly-sandboxed" ? [] : posture.writableRoots,
      },
      // `full` omits the restriction, since an empty list means the opposite; `none` is empty.
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
 * One provider session's `system/init` declaration, stamped with the provider session id it was
 * observed under. A rewind forks a new process behind the same `SessionId`, so reads check the
 * stamp and answer "not yet observed" rather than with the dead process's declaration.
 */
interface ClaudeHeldHandshake {
  readonly providerSessionId: string;
  readonly declaration: ClaudeHandshakeDeclaration;
  /** Command names invocable over the programmatic transport: `slash_commands` only, uncapped. */
  readonly invocableCommandNames: ReadonlySet<string>;
}

/** A session's router and accountant, held together so no frame routes to an unmetered thread. */
interface ClaudeSessionRoutingBand {
  readonly router: ThreadFrameRouter<ClaudeRoutableFrame>;
  readonly accountant: UsageDeltaAccountant;
}

interface ClaudeSpawnBinding {
  readonly admittedCostCapUsdMicros: number | undefined;
  // The complete posture, so every axis can be compared.
  readonly executionPosture: ExecutionPosture | undefined;
  readonly outputSchemaDigest: string | undefined;
}

interface LiveClaudeSession {
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly channel: ClaudeSessionChannel;
  readonly spawnBinding: ClaudeSpawnBinding;
  /**
   * The legs this process was spawned with. A rewind respawns from these; re-deriving would guess,
   * and a guess that omits the posture relaunches the session unsandboxed.
   */
  readonly spawnBoundLegs: ClaudeSpawnBoundLegs;
  /**
   * Usage base: zero for `fresh`, else the prior-emitted cumulative sum for `resume`, which after
   * a rewind is keyed by the predecessor's id because the fork announces a new one.
   */
  readonly establishment: ClaudeUsageEstablishment;
  /**
   * The provider account the daemon admitted this process against, or `null` when none was named.
   * Held opaque and captured at establishment because the live registry can move; a rewind
   * inherits it. See {@link ClaudeSessionLifecycleDependencies.readBoundProviderAccountId}.
   */
  readonly admittedProviderAccountId: string | null;
}

/** Usage base-establishment arm; the resume arm must name the thread whose sum it bases on. */
type ClaudeUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

// One canonical session's slot state. Absence from `#sessionSlots` is EMPTY, the only state where
// a create or resume may proceed. One registry holds every state so a slot mid-disposal never
// reads as EMPTY. Arms with an in-flight transition carry a `settled` promise that never rejects.
type ClaudeSessionSlot =
  // A create, resume or rewind is bringing a process up. Ends live, or EMPTY on failure.
  // `channel` is the predecessor's on a rewind, so its frames stay attributable during the fork.
  | {
      readonly state: "establishing";
      readonly settled: Promise<void>;
      readonly channel: ClaudeSessionChannel | undefined;
    }
  // A process is up and may accept runs. The only startable state.
  | { readonly state: "live"; readonly session: LiveClaudeSession }
  // `dispose` is in flight. Ends EMPTY on resolve, QUARANTINED on reject.
  | { readonly state: "closing"; readonly settled: Promise<void> }
  // `dispose` rejected: the process is still alive and this channel is the only handle anyone
  // holds on it. Retained until a later close disposes it.
  | { readonly state: "quarantined"; readonly channel: ClaudeSessionChannel };

/**
 * Whether the provider-account member is present but empty, a wiring fault the caller refuses
 * (create throws, resume returns `failed`). Folding it to `null` would hide it; carrying it would
 * let two accountless bindings compare equal.
 */
function isUnusableAdmittedProviderAccountId(requested: string | undefined): boolean {
  return requested !== undefined && requested.length === 0;
}

function readAdmittedProviderAccountId(requested: string | undefined): string | null {
  return requested ?? null;
}

/** What a Claude session lifecycle needs from the daemon: the transport, sinks and id sources. */
export interface ClaudeSessionLifecycleDependencies {
  readonly transport: ClaudeSessionTransport;
  readonly runDispatchResolver: ClaudeRunDispatchResolver;
  /** The daemon-wide diagnostic band; required, since each fail-closed path owes a record. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * The daemon's prior-emitted cumulative token sums under `threadId`, which on a rewind is the
   * predecessor. `undefined` bases at zero; an unbound or throwing reader is recorded as a fault.
   */
  readonly readPriorEmittedUsage?:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  /** Receives each metered usage delta; the emission pipeline mints `usage_telemetry`. */
  readonly onMeteredUsage?: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  /** Text-neutrality grade (default `emulated`), injectable for a `native` upgrade. */
  readonly textNeutralityMechanismGrade?: TextNeutralityMechanismGrade | undefined;
  /** Correlation minting for outbound text frames. Injectable for tests. */
  readonly mintOutboundFrameCorrelationId?: (() => string) | undefined;
  /**
   * Receives the run terminal a text-neutralization trip produces. Required: a trip raises no
   * JSON-RPC error, so without it a neutralized turn ends with no terminal an operator can read.
   */
  readonly onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  /**
   * Reads the installed build's transcript-replay surface, the source of the `transcript_replay`
   * flag. Absent means every replay refuses, as no published build has a seeding surface.
   */
  readonly transcriptReplaySurfaceReader?: ClaudeTranscriptReplaySurfaceReader | undefined;
  /** Receives each child's `subagent.started`/`subagent.completed` pair, its only timeline mark. */
  readonly onSubagentLifecycle?:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  /**
   * Receives the routing decision for a frame released from a hold, when no observer call can
   * answer for it. Only `carve-out-usage` and `suppress-child-transcript` occur; interactive
   * requests are connection-scoped and never held.
   */
  readonly onReleasedFrameRoute?:
    | ((
        sessionId: SessionId,
        observation: ClaudeInboundFrameObservation,
        route: ThreadFrameRoute,
      ) => void)
    | undefined;
  // The provider session id pinned at spawn (`--session-id`); the CLI accepts any valid UUID.
  readonly mintProviderSessionId?: (() => string) | undefined;
  // The opaque session-binding handle the `resumed` arm carries; the default needs no database.
  readonly mintBindingId?: (() => string) | undefined;
  /** Schedules the compaction bound; an unref'd timer by default, injectable to skip the wait. */
  readonly compactionWaitScheduler?: CompactionWaitScheduler | undefined;
  /**
   * The daemon account registry's answer, cross-checking the account captured at establishment:
   * the record wins over a silent port, differing accounts refuse the call, and `null` is stamped
   * when neither names one (the routing check treats `null` as matching nothing).
   */
  readonly readBoundProviderAccountId?: ((sessionId: SessionId) => string | null) | undefined;
}

/**
 * One observed Claude frame as the thread-frame router sees it. Claude frames carry no thread id,
 * so `threadId` is the subagent identity or else the provider session id; never `null`, which
 * would quarantine every ordinary frame.
 */
interface ClaudeRoutableFrame extends RoutableProviderFrame {
  readonly threadId: string;
  /** The observation this frame was built from, so a released hold can still be metered. */
  readonly observation: ClaudeInboundFrameObservation;
}

/**
 * The router's bounds. The hold covers a subagent's frames arriving ahead of its `SubagentStart`;
 * the short timeout means a frame held longer names a child never announced.
 */
const CLAUDE_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});

/** Drives Claude sessions over a `ClaudeSessionTransport`, with per-session slot and metering. */
export class ClaudeSessionLifecycle implements ClaudeRunChannelLookup {
  readonly #transport: ClaudeSessionTransport;
  readonly #runDispatchResolver: ClaudeRunDispatchResolver;
  readonly #mintProviderSessionId: () => string;
  readonly #mintBindingId: () => string;
  // Every session's slot. Create and resume refuse on a non-EMPTY slot instead of chaining, since
  // a session realized under another posture is what `#assertSpawnBoundRealization` prevents;
  // close chains. Claims read and write with no await between, so check-then-act is atomic.
  readonly #sessionSlots: Map<SessionId, ClaudeSessionSlot> = new Map();
  readonly #sessionIdByRunId: Map<RunId, SessionId> = new Map();
  // The producer half of the intended-close signal, signaled at the top of `closeSession` and
  // consumed at the terminal-emission boundary in `event-normalizer.ts`. Keyed beside the slot map
  // because the intent must be recordable while the slot holds no live session.
  readonly #terminalEmissionGates: Map<SessionId, ClaudeTerminalEmissionGate> = new Map();
  // A session's router and accountant, in one map so they are created and released together.
  readonly #routingBands: Map<SessionId, ClaudeSessionRoutingBand> = new Map();
  readonly #readPriorEmittedUsage:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  readonly #onMeteredUsage: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  // The writer composes all provider-bound text; the tripwire correlates each frame with the turn
  // that settles it; the quarantine holds bindings a trip disposed.
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine: RuntimeBindingQuarantine = new RuntimeBindingQuarantine();
  readonly #onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  readonly #transcriptReplaySurfaceReader: ClaudeTranscriptReplaySurfaceReader | undefined;
  /** Burned replay targets, keyed by the provider-side conversation's session id. */
  readonly #replayTargets: ReplayTargetLedger = new ReplayTargetLedger();
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
   * The `system/init` declaration of each live session, never persisted; stamped with the provider
   * session id (see {@link ClaudeHeldHandshake}) and discarded with the session.
   */
  readonly #handshakeBySession: Map<SessionId, ClaudeHeldHandshake> = new Map();
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #readBoundProviderAccountId: ((sessionId: SessionId) => string | null) | undefined;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeSessionLifecycleDependencies) {
    this.#transport = dependencies.transport;
    this.#runDispatchResolver = dependencies.runDispatchResolver;
    this.#diagnostics = dependencies.diagnostics;
    this.#readPriorEmittedUsage = dependencies.readPriorEmittedUsage;
    this.#onMeteredUsage = dependencies.onMeteredUsage;
    this.#onSubagentLifecycle = dependencies.onSubagentLifecycle;
    this.#transcriptReplaySurfaceReader = dependencies.transcriptReplaySurfaceReader;
    this.#onReleasedFrameRoute = dependencies.onReleasedFrameRoute;
    this.#mintProviderSessionId = dependencies.mintProviderSessionId ?? mintUuidV7;
    this.#mintBindingId = dependencies.mintBindingId ?? mintUuidV7;
    this.#readBoundProviderAccountId = dependencies.readBoundProviderAccountId;
    this.#pendingCompactions = new PendingCompactionRegistry(
      dependencies.compactionWaitScheduler ??
        ((callback: () => void, delayMs: number): (() => void) => {
          const timer = setTimeout(callback, delayMs);
          // Unref'd so a pending wait never keeps the daemon alive; shutdown is a binding loss.
          timer.unref();
          return (): void => {
            clearTimeout(timer);
          };
        }),
    );
    this.#onTextNeutralizationFailure = dependencies.onTextNeutralizationFailure;
    this.#outboundTextFrameWriter = new OutboundTextFrameWriter({
      // `emulated` at the pinned build: its input intercepts command-shaped text (measured).
      mechanismGrade: dependencies.textNeutralityMechanismGrade ?? "emulated",
      mintCorrelationId: dependencies.mintOutboundFrameCorrelationId,
    });
    // Built here because the predicate reads a field declared later. A session is retired when it
    // holds no slot or a trip quarantined it; the slot map is checked, not `#findLiveSession`,
    // since a session mid-establishment or mid-close may still have frames to rule.
    this.#outboundFrameTripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey: string): boolean =>
        !this.#sessionSlots.has(scopeKey as SessionId) ||
        this.#runtimeBindingQuarantine.isSessionDisposed(scopeKey),
    });
  }

  /**
   * Spawns a new provider process for `params.sessionId` and registers it. Throws
   * `ClaudeSessionUnavailableError` when the slot is held or the provider account is empty;
   * throwing is the only failure channel.
   */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Fail closed, not replace: an existing channel has its own posture, cap and schema.
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
    // Before the spawn, so a request without a billing identity never reaches a process.
    if (isUnusableAdmittedProviderAccountId(params.providerAccountId)) {
      throw new ClaudeSessionUnavailableError("provider_account_unusable", {
        sessionId: params.sessionId,
      });
    }
    const pinnedProviderSessionId = this.#mintProviderSessionId();
    // Built once and retained: a fork relaunches from the legs this process launched under.
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

    // Every exit here registers or disposes the channel, or the slot frees around a running
    // process. The window can throw: `#buildSpawnBinding` digests a caller-supplied schema (cyclic
    // ones throw) and `#registerLiveSession` calls the transport's `onTurnTerminal`.
    try {
      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: this.#buildSpawnBinding(params),
        spawnBoundLegs: spawnBoundLegs,
        establishment: { mode: "fresh" },
        // Captured, not resolved, so the enumeration reports the account this process runs under.
        admittedProviderAccountId: readAdmittedProviderAccountId(params.providerAccountId),
      });
    } catch (error) {
      // Re-throw the original cause: `createSession` has no degraded arm to carry a wrapper.
      await this.#disposeRefusedChannel(attachment.channel, "establishment_failed");
      throw error;
    }

    // Claude resumes by session id (`--resume <session-id>`), so the handle is that id.
    return {
      providerSessionId: attachment.providerSessionId,
      resumeHandle: attachment.providerSessionId,
    };
  }

  /** Resumes a provider session by its handle; every failure returns through the `failed` arm. */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Resuming beside a live channel would leave two processes for one canonical session, and an
    // in-flight establishment belongs to a caller with different spawn-bound legs.
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
    // Before the spawn and through `failed`: a raw rejection would reach a caller with no arm.
    if (isUnusableAdmittedProviderAccountId(params.providerAccountId)) {
      return this.#buildResumeFailure(
        "recovery-needed",
        "ResumeSessionParams.providerAccountId is present but empty; an account was meant to be bound and none was.",
      );
    }
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

    // Identity gate. Claude answers a resume it cannot honor (a working-directory mismatch is
    // documented) by starting a fresh session under its own id, which must not be adopted.
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

    // Every exit until registration registers or disposes the channel. The window can throw (the
    // binding minter, `#buildSpawnBinding`'s schema digest, the transport's `onTurnTerminal`), and
    // resume's failure channel is the `failed` arm, so a throw must not escape.
    let validatedResumeResult: DriverResumeResult;
    try {
      const resumed: DriverResumeResult = {
        status: "resumed",
        bindingId: this.#mintBindingId(),
        sessionPosition: attachment.sessionPosition,
      };
      // An out-of-contract `resumed` arm is a provider failure: `recovery-needed`, not a throw.
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
        // The identity gate guarantees this is the thread the daemon has been emitting against.
        establishment: { mode: "resume", priorEmittedThreadId: attachment.providerSessionId },
        // No record to reconcile: a resume only proceeds on an EMPTY slot (`#describeSlotHolder`).
        admittedProviderAccountId: readAdmittedProviderAccountId(params.providerAccountId),
      });
    } catch (error) {
      const disposalNote = await this.#disposeRefusedChannel(
        attachment.channel,
        "establishment_failed",
      );
      // `recovery-needed`, not `reauth-required`: adoption failed after a resume that succeeded.
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

    // Before the live-session lookup so the cause survives: a trip disposes the channel, and the
    // lookup would then report `no_live_session`, which invites a retry into the process that
    // swallowed the user's words. A fresh spawn releases the quarantine.
    this.#runtimeBindingQuarantine.assertSessionAttachable(dispatch.sessionId);

    const live = this.#findLiveSession(dispatch.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    this.#assertSpawnBoundRealization(params, live);

    // One pending opening frame per run key: a second would be ruled `UNRECOGNIZED_TURN_EVIDENCE`
    // and trip the session. Not keyed on the run route, which a dead-channel ruling keeps while
    // the run may re-dispatch.
    if (this.#outboundFrameTripwire.hasPendingFrame(params.runId)) {
      throw new ClaudeSessionUnavailableError("run_already_dispatched", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    // Claude's settling envelope carries no run id, so a terminal's classification can be credited
    // to only one run per session. Refused before anything is composed, so the caller may
    // re-dispatch once the turn settles.
    if (this.#outboundFrameTripwire.hasPendingFrameInScope(dispatch.sessionId)) {
      throw new ClaudeSessionUnavailableError("session_turn_in_flight", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    // Only a definitely-unsent write is retried; the shared classifier decides, as for Codex.
    for (let dispatchAttemptsMade = 1; ; dispatchAttemptsMade += 1) {
      const frame = this.#registerOpeningDispatch(dispatch, params);
      const attempt = await this.#attemptFrameWrite(live.channel, frame);
      if (attempt.settled === "written") {
        return;
      }
      // Ruled before the retry decision: the ruling releases the frame's registration, and a
      // second registered frame on one run key would trip the tripwire.
      this.#ruleFailedOpeningFrame({
        sessionId: dispatch.sessionId,
        runId: params.runId,
        channel: live.channel,
        frame,
        delivery: attempt.delivery,
      });
      const disposition = classifyProviderRequestFailure(
        observeClaudeUserTextFailure(attempt.delivery),
      ).disposition;
      // Only `unsent` is re-sent, as the one positive claim that the provider saw nothing.
      // `reconcile-ambiguous-delivery` has no readback here, so the turn fails instead.
      if (
        disposition !== "retry-definitely-unsent" ||
        !mayReattemptAfterDefinitelyUnsent(dispatchAttemptsMade)
      ) {
        throw attempt.cause;
      }
    }
  }

  /**
   * Composes one run-opening frame, admits it to the tripwire and binds the run route. Every
   * attempt repeats all three, since an unregistered frame is unwatched.
   */
  #registerOpeningDispatch(
    dispatch: ClaudeRunDispatch,
    params: StartRunParams,
  ): ClaudeUserTextFrame {
    // Composed only here, so neutralization sits on the only path to the wire. The origin is a
    // literal, not a `ClaudeRunDispatch` member: `driver_command` would deliver bytes verbatim and
    // exempt the turn from the tripwire.
    const frame = this.#outboundTextFrameWriter.compose({
      text: dispatch.openingText,
      origin: RUN_OPENING_FRAME_ORIGIN,
    });
    // Registered before the route is bound so a refusal mutates nothing: a leftover route would
    // let an interrupt stop an older turn. A refusal aborts before the write; a capacity refusal
    // is unreachable behind `startRun`'s session guard and kept fail-closed.
    this.#outboundFrameTripwire.register({
      scopeKey: dispatch.sessionId,
      joinKey: params.runId,
      frameRole: "turn-opening",
      frame,
    });
    // Bound before the write: an interrupt may race the text on the wire and must find a route.
    this.#sessionIdByRunId.set(params.runId, dispatch.sessionId);
    return frame;
  }

  /**
   * Writes one composed frame, turning a transport rejection into a failed attempt. A rejection
   * carries no claim about the bytes, so it is `indeterminate`, never `unsent`.
   */
  async #attemptFrameWrite(
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
   * Decides what a failed opening frame is owed by how far its bytes got. A channel that dies later
   * without settling is not ruled here, which would trip every clean shutdown mid-turn.
   */
  #ruleFailedOpeningFrame(ruling: {
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly channel: ClaudeSessionChannel;
    readonly frame: ClaudeUserTextFrame;
    readonly delivery: ClaudeUserTextDelivery;
  }): void {
    if (ruling.delivery === "unsent") {
      // The route goes unless a sibling frame on this run is pending: a stale route lets Claude's
      // channel-scoped interrupt stop an older turn, but deleting it under a pending frame would
      // hide that frame from `#ruleTextNeutralizationTripwire`.
      this.#outboundFrameTripwire.forgetFrame(ruling.frame);
      if (!this.#outboundFrameTripwire.hasPendingFrame(ruling.runId)) {
        this.#sessionIdByRunId.delete(ruling.runId);
      }
      return;
    }
    // Kept for the turn's own terminal, since the provider may have intercepted the text as a
    // client-side command. It claims the session's next terminal first, so a trip may name the
    // wrong run; the session is quarantined either way.
    if (!ruling.channel.isClosed) {
      return;
    }
    // Dead channel: no terminal will arrive, so rule the frame here, frame-scoped. The route stays
    // so `findChannelForRun` refuses instead of answering `undefined`, which invites a retry.
    const decision = this.#outboundFrameTripwire.settleFrame(
      ruling.frame,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (!decision.tripped) {
      return;
    }
    // Same order as the settlement path: the session first, so a caller reacting synchronously to
    // the run failure cannot reach the condemned process.
    this.#runtimeBindingQuarantine.disposeSession(ruling.sessionId);
    this.#runtimeBindingQuarantine.disposeRun(ruling.runId, ruling.sessionId);
    this.#reportTextNeutralizationFailure(
      ruling.sessionId,
      ruling.runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(ruling.sessionId);
  }

  /**
   * Zero-turn authentication probe; never throws. `ClaudeAuthenticationRequiredError` is
   * `unauthenticated`, any other throw `indeterminate`. It claims no session slot.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    try {
      // Carries the mandated environment like every other spawn, so the probe cannot update the
      // installation underneath the readings.
      const reading = await this.#transport.probeAuth({
        mandatedEnvironment: composeClaudeMandatedEnvironment(),
      });
      return buildAuthProbeResult(
        "authenticated",
        reading.detail ?? CLAUDE_AUTH_PROBE_REACHED_DETAIL,
      );
    } catch (cause) {
      // Typed, not sniffed from the message, which provider rewording would break.
      return buildAuthProbeResult(
        cause instanceof ClaudeAuthenticationRequiredError ? "unauthenticated" : "indeterminate",
        describeFailure(cause),
      );
    }
  }

  /**
   * Sends the CLI's `interrupt` control request for the run's channel. Throws
   * `ClaudeSessionUnavailableError` when the run has no live channel and
   * `ClaudeControlRequestRefusedError` when the CLI refuses.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const channel = this.findChannelForRun(params.runId);
    if (channel === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId: params.runId });
    }
    // `params.reason` is not forwarded: the pinned CLI's `interrupt` request has no reason member.
    // A refusal throws, since returning would claim an interrupt that did not happen.
    const response = await channel.sendControlRequest({
      subtype: "interrupt",
      cancelQueued: false,
    });
    if (response.subtype === "error") {
      throw new ClaudeControlRequestRefusedError("interrupt", response.error);
    }
  }

  /**
   * Forks the provider conversation at a recorded message, leaving the original and the files on
   * disk untouched (`--rewind-files` covers only Write/Edit). An `applied` result carries a fresh
   * `bindingId` for the new provider session; a failed rewind restores the predecessor.
   */
  async forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      // Thrown, not degraded: `degraded` is for a driver that could act and reported a fallback.
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
    params: ForkConversationParams,
    predecessor: LiveClaudeSession,
  ): Promise<ForkConversationResult> {
    const rewoundSpawnBoundLegs: ClaudeSpawnBoundLegs = {
      // The predecessor's own legs, re-realized verbatim; any other source relaunches under a
      // configuration nobody chose.
      ...predecessor.spawnBoundLegs,
      // A fresh gate: every subagent the old gate held a slot for died with the process.
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
      // The predecessor is untouched, so a retry is safe. Degraded, not thrown: the caller has a
      // fallback arm.
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-refused: ${sanitizeFailureDetail(describeFailure(error))}`,
      });
    }

    // A rewind answering with the id it was given did not fork, so the lineage would be wrong.
    if (attachment.providerSessionId === predecessor.providerSessionId) {
      // Disposing the predecessor's own channel would kill the session about to be restored.
      const disposalNote =
        attachment.channel === predecessor.channel
          ? ""
          : await this.#disposeRefusedChannel(attachment.channel, "resume_identity_diverged");
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-not-forked: the provider answered with session ${attachment.providerSessionId} rather than a fork.${disposalNote}`,
      });
    }

    // Every exit here either registers the new channel or disposes it: an escaping throw would
    // orphan the forked process while the claim restores the predecessor.
    let validatedRollbackResult: ForkConversationResult;
    try {
      const applied = {
        status: "applied" as const,
        sessionPosition: attachment.sessionPosition,
        bindingId: this.#mintBindingId(),
      };
      const validated = ForkConversationResultSchema.safeParse(applied);
      if (!validated.success) {
        const disposalNote = await this.#disposeRefusedChannel(
          attachment.channel,
          "resume_result_invalid",
        );
        return ForkConversationResultSchema.parse({
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
        // Bases like a resume, keyed on the predecessor's id (the only one spend was emitted
        // under); a zero base would re-meter earlier turns. If the provider's counter restarts on
        // `--fork-session` (unmeasured), deltas floor at zero and a diagnostic is recorded.
        establishment: { mode: "resume", priorEmittedThreadId: predecessor.providerSessionId },
        // Inherited: a fork continues the run already admitted, and re-reading the registry could
        // re-bill a session the daemon never re-admitted.
        admittedProviderAccountId: predecessor.admittedProviderAccountId,
      });
    } catch (error) {
      const disposalNote = await this.#disposeRefusedChannel(
        attachment.channel,
        "establishment_failed",
      );
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-adoption-failed: ${sanitizeFailureDetail(describeFailure(error))}${disposalNote}`,
      });
    }

    // After adoption commits, outside the try (a failed adoption keeps a running predecessor
    // correlated). The sweep runs before route retirement, which empties `#sessionIdByRunId`.
    // Frames fail rather than drop, so an undelivered run never looks delivered.
    this.#failSupersededDeliveries(params.sessionId);
    this.#retireRunRoutes(params.sessionId);
    // Usually a no-op (the sweep consumed the registrations); the only budget release here.
    this.#outboundFrameTripwire.forgetScope(params.sessionId);

    // Released after the successor is installed, so every earlier failure path is non-destructive.
    // A disposal failure does not fail the fork.
    disposeSubagentAdmission(predecessor.spawnBoundLegs);
    // The predecessor is going away, so its armed compaction waits can never see their evidence.
    // None exist for the successor: this method holds the rewind slot claim, and `compactContext`
    // needs a settled live slot.
    this.#pendingCompactions.releaseBinding(params.sessionId);
    await this.#disposeRefusedChannel(predecessor.channel, "session_closed");
    return validatedRollbackResult;
  }

  /**
   * Triggers a context compaction by sending the provider's `/compact` as a `driver_command`
   * frame. Refuses `command_absent` unless the binding lists the command, since that origin skips
   * the tripwire; `applied` needs the typed compaction frame. Throws with no live session.
   */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }

    // The held enumeration, matched by stamp: stricter than the composed entries'
    // `(driverName, providerAccountId)` pair, which would refuse every accountless session.
    const held = this.#heldHandshakeFor(params.sessionId, live.providerSessionId);
    if (held === undefined || !held.invocableCommandNames.has(CLAUDE_COMPACTION_COMMAND_NAME)) {
      // No prompt-based fallback: a model summary spends a turn and produces no boundary.
      return { status: "refused", reason: "command_absent" };
    }

    // Armed before dispatch so a fast compaction is not lost; any early exit withdraws it.
    const wait = this.#pendingCompactions.arm(params.sessionId, CLAUDE_COMPACTION_WAIT_MS);
    let attempt: ClaudeUserTextWriteAttempt;
    try {
      // Not registered with the tripwire: a pending frame would make `startRun` refuse until a
      // terminal that never comes.
      const frame = this.#outboundTextFrameWriter.compose({
        text: CLAUDE_COMPACTION_COMMAND_TEXT,
        // A literal: a forwarded value could carry user words under the tripwire exemption.
        origin: CLAUDE_COMPACTION_FRAME_ORIGIN,
      });
      attempt = await this.#attemptFrameWrite(live.channel, frame);
    } catch (cause) {
      // Withdraw first, or the armed timer outlives the caller. Composition calls an injected
      // minter that may throw; rethrown, since nothing was refused or dispatched.
      wait.abandon();
      throw cause;
    }
    if (attempt.settled === "failed") {
      // `provider_error` for both deliveries: this frame opens no turn, so the driver cannot say a
      // compaction happened. Withdrawn, not settled: settling is per key and would report this
      // failure to a concurrent waiter.
      wait.abandon();
      // The delivery rides the diagnostic: `unsent` never reached the provider, while
      // `indeterminate` may have been applied with the acknowledgement lost.
      this.#diagnostics.emit({
        provider: "claude",
        kind: "compaction_wait_terminal",
        rawWireType: null,
        dispositionReason: sanitizeFailureDetail(describeFailure(attempt.cause)),
        details: {
          sessionId: params.sessionId,
          terminal: "provider_error",
          delivery: attempt.delivery,
        },
      });
      return { status: "failed", reason: "provider_error" };
    }

    const observed = await wait.settled;
    if (observed.terminal === "observed") {
      return { status: "applied", boundaryPosition: observed.boundaryPosition };
    }
    // Only the two non-observed terminals are recorded; an applied compaction is ordinary success.
    this.#diagnostics.emit({
      provider: "claude",
      kind: "compaction_wait_terminal",
      rawWireType: null,
      dispositionReason:
        observed.terminal === "wait_expired"
          ? "the declared compaction bound elapsed with no typed compaction frame; a later boundary still projects"
          : "the provider binding was lost while a compaction wait was armed",
      details: { sessionId: params.sessionId, terminal: observed.terminal },
    });
    return { status: "failed", reason: observed.terminal };
  }

  /**
   * Enumerates the provider's command and skill surface for one binding from the held handshake,
   * with terminal slash commands carried as `scope: "terminal"`. The cap trims this reply only
   * (`complete: false` plus a diagnostic); before the handshake it answers empty and complete.
   */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }
    const binding = {
      driverName: CLAUDE_DRIVER_NAME,
      // The record is primary, the registry port a cross-check; `null` is stated, not synthesized.
      providerAccountId: this.#resolveStampedProviderAccountId(params.sessionId, live),
    };
    const held = this.#heldHandshakeFor(params.sessionId, live.providerSessionId);
    // Before the handshake (it rides a turn the user may not have made) answer empty, not refuse.
    const declared =
      held === undefined
        ? []
        : this.#composeProviderCommandEntries(params.sessionId, held.declaration, binding);
    const admitted = declared.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    if (admitted.length < declared.length) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "provider_command_entries_truncated",
        rawWireType: null,
        dispositionReason:
          "the provider published more command and skill entries than one group admits; the tail is dropped from this reply and the held enumeration is unchanged",
        details: {
          sessionId: params.sessionId,
          declaredEntryCount: declared.length,
          admittedEntryCount: admitted.length,
        },
      });
    }
    return await Promise.resolve({
      bindings: [
        {
          runId: this.#soleLiveRunOn(params.sessionId),
          binding,
          entries: admitted,
          complete: admitted.length === declared.length,
        },
      ],
    });
  }

  /**
   * Picks the provider account an enumeration's binding is stamped with. Throws when the account
   * registry names a different account than the admitted one; a `null` registry answer is silence.
   */
  #resolveStampedProviderAccountId(sessionId: SessionId, live: LiveClaudeSession): string | null {
    const admitted = live.admittedProviderAccountId;
    const registered = this.#readBoundProviderAccountId?.(sessionId) ?? null;
    if (admitted === null) {
      return registered;
    }
    if (registered === null || registered === admitted) {
      return admitted;
    }
    throw new ClaudeSessionUnavailableError("provider_account_ambiguous", {
      sessionId,
      detail: `The session was admitted against provider account ${admitted} while the daemon's account registry reports ${registered}; the enumeration is routed by that identity, so neither resolver may silently win.`,
    });
  }

  /**
   * The output-speed state the provider declared, or `undefined` before it has: the handshake rides
   * a turn-bearing exchange that create and resume do not wait for. A declaration the contract's
   * bounds reject reads as absent, with a diagnostic; `cooldown` is carried as declared.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    const live = this.#findLiveSession(sessionId);
    if (live === undefined) {
      return undefined;
    }
    const held = this.#heldHandshakeFor(sessionId, live.providerSessionId);
    if (held === undefined) {
      return undefined;
    }
    const declared = held.declaration.fastModeState;
    if (declared === null) {
      return undefined;
    }
    const reason = held.declaration.fastModeDisabledReason;
    const parsed = ProviderOutputSpeedStateSchema.safeParse({
      declared,
      ...(reason === null ? {} : { reason }),
    });
    if (parsed.success) {
      return parsed.data;
    }
    this.#diagnostics.emit({
      provider: "claude",
      kind: "output_speed_state_rejected",
      rawWireType: null,
      dispositionReason:
        "the provider declared an output-speed state the contract's own bounds refuse; this binding reads as having no observation until it declares another",
      details: {
        sessionId,
        // The failing field and lengths, never the untrusted values.
        rejectedField: parsed.error.issues[0]?.path.join(".") ?? "",
        declaredLength: declared.length,
        reasonLength: reason === null ? null : reason.length,
      },
    });
    return undefined;
  }

  // Answers only for the process the declaration was read from. The stamp is redundant today
  // (registration clears the record and retired channels are refused first); it is a last guard.
  #heldHandshakeFor(
    sessionId: SessionId,
    providerSessionId: string,
  ): ClaudeHeldHandshake | undefined {
    const held = this.#handshakeBySession.get(sessionId);
    return held?.providerSessionId === providerSessionId ? held : undefined;
  }

  // Composed at read time so the held state stays what the provider said. Each entry is bounded by
  // the contract's entry schema (provider-supplied names may be empty, NUL-bearing or over-long); a
  // rejected entry is dropped alone, with a diagnostic, so one bad name cannot empty the palette.
  #composeProviderCommandEntries(
    sessionId: SessionId,
    declaration: ClaudeHandshakeDeclaration,
    binding: { driverName: string; providerAccountId: string | null },
  ): ProviderCommandEntry[] {
    const entries: ProviderCommandEntry[] = [];
    const admit = (candidate: ProviderCommandEntry): void => {
      const parsed = ProviderCommandEntrySchema.safeParse(candidate);
      if (parsed.success) {
        entries.push(parsed.data);
        return;
      }
      this.#diagnostics.emit({
        provider: "claude",
        kind: "provider_command_entry_rejected",
        rawWireType: null,
        dispositionReason:
          "the provider published a command or skill entry the contract's own bounds refuse; it is dropped from this reply and its siblings are unaffected",
        details: {
          sessionId,
          entryKind: candidate.kind,
          entryScope: candidate.scope ?? null,
          // The failing field and length, never the untrusted name.
          rejectedField: parsed.error.issues[0]?.path.join(".") ?? "",
          nameLength: candidate.name.length,
        },
      });
    };
    for (const name of declaration.slashCommands) {
      admit({ name, kind: "command", binding });
    }
    for (const name of declaration.skills) {
      admit({ name, kind: "skill", binding });
    }
    for (const name of declaration.terminalSlashCommands) {
      // A command in kind; `scope` records its terminal-only reach.
      admit({ name, kind: "command", scope: "terminal", binding });
    }
    return entries;
  }

  /**
   * The one run holding a live turn on this session, or `null` for none or several. No last-bound
   * fallback: it would name a retired run. The several-runs arm is unreachable while `startRun`
   * refuses a second dispatch; it stays fail-closed.
   */
  #soleLiveRunOn(sessionId: SessionId): RunId | null {
    let soleRunId: RunId | null = null;
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId !== sessionId) {
        continue;
      }
      if (soleRunId !== null) {
        return null;
      }
      soleRunId = runId;
    }
    return soleRunId;
  }

  /** Records one `system/init` declaration; the last wins, since the surface can change mid-run. */
  #observeHandshakeDeclaration(
    sessionId: SessionId,
    providerSessionId: string,
    declaration: ClaudeHandshakeDeclaration,
  ): void {
    this.#handshakeBySession.set(sessionId, {
      providerSessionId,
      declaration,
      invocableCommandNames: new Set(declaration.slashCommands),
    });
  }

  /**
   * Reconstitutes the canonical transcript into a fresh provider session, returning only after the
   * target's readback confirms it. Refuses on every published build: no stable prior-turn seeding
   * contract exists, so the capability probe answers `false` and the memo floor takes over.
   */
  async replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    const targetProviderSessionId: string = params.target.providerSessionId;
    this.#replayTargets.assertUsable(targetProviderSessionId);

    const readSurface: ClaudeTranscriptReplaySurfaceReader | undefined =
      this.#transcriptReplaySurfaceReader;
    if (readSurface === undefined) {
      throw new ClaudeTranscriptReplayUnsupportedError(
        "no transcript-replay surface reader is bound, so no build has been shown to carry one",
      );
    }
    const reading: ClaudeTranscriptReplayReading = await readSurface();
    if (!reading.supported) {
      // Nothing was written, so the caller may fall back to the memo floor.
      throw new ClaudeTranscriptReplayUnsupportedError(reading.reason);
    }
    const surface: ClaudeTranscriptSeedingSurface = reading.surface;

    const seeded: SeededTranscriptFrame[] = params.frames.map((frame) =>
      readRenderedTranscriptFrameForClaudeReplay(frame),
    );
    if (seeded.length === 0) {
      throw new ClaudeTranscriptReplayFailedError(
        "Refusing to replay an empty transcript: there is nothing to reconstitute, and a post-replay assertion over no frames confirms nothing.",
      );
    }

    // Freshness is read, not inferred: the post-replay assertion tolerates extra turns in a target.
    const priorContents: ReplayTargetReadback = await readReplayTargetSafely(
      surface.readBack,
      targetProviderSessionId,
    );
    if (priorContents.kind === "unreadable") {
      this.#abandonReplayTarget(targetProviderSessionId, "readback-unavailable");
      throw new ClaudeTranscriptReplayFailedError(
        `Replay target "${targetProviderSessionId}" could not be read before seeding (${priorContents.reason}), so its freshness is unknown; the target was abandoned.`,
      );
    }
    if (priorContents.turns.length > 0) {
      this.#abandonReplayTarget(targetProviderSessionId, "target-not-fresh");
      throw new ClaudeTranscriptReplayFailedError(
        `Refusing to replay into session "${targetProviderSessionId}": it already holds ${String(priorContents.turns.length)} turn(s), and a replay target must be fresh.`,
      );
    }

    for (const frame of seeded) {
      const outcome: ClaudeTranscriptSeedOutcome = await surface.seedFrame(
        targetProviderSessionId,
        frame,
      );
      if (outcome.delivery === "applied") {
        continue;
      }
      const cause: ReplayTargetAbandonmentCause =
        outcome.delivery === "ambiguous" ? "ambiguous-delivery" : "interior-refusal";
      this.#abandonReplayTarget(targetProviderSessionId, cause);
      throw new ClaudeTranscriptReplayFailedError(
        `Claude replay seeding stopped at transcript position ${String(frame.position)} (${outcome.delivery}: ${outcome.reason}); the target was abandoned and must not be reused.`,
      );
    }

    const readback: ReplayTargetReadback = await readReplayTargetSafely(
      surface.readBack,
      targetProviderSessionId,
    );
    const verdict: PostReplayVerdict = assertReplayReconstituted(seeded, readback);
    if (verdict.outcome === "refuted") {
      const cause: ReplayTargetAbandonmentCause =
        verdict.refutation === "target-unreadable" ? "readback-unavailable" : "assertion-refuted";
      this.#abandonReplayTarget(targetProviderSessionId, cause);
      throw new PostReplayAssertionFailedError(targetProviderSessionId, seeded.length, verdict);
    }

    // Retired on success too, so a second replay through the handle is refused as reuse.
    this.#replayTargets.consume(targetProviderSessionId);

    // Empty: an unrepresentable frame refuses in the parse above, so nothing is dropped silently.
    return { status: "applied", declaredLosses: [] };
  }

  // Records the burn in the ledger only; unlike the Codex driver it does not dispose the process,
  // whose handle the caller that established the session holds.
  #abandonReplayTarget(targetProviderSessionId: string, cause: ReplayTargetAbandonmentCause): void {
    this.#replayTargets.abandon(targetProviderSessionId, cause);
  }

  /**
   * Closes the session's channel, chaining behind any in-flight transition and retrying a
   * quarantined channel. Idempotent; rejects if the process will not exit.
   */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Latch first, so every terminal from here, including an in-flight establishment's, is a clean
    // shutdown.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();

    // Chains on any in-flight transition and re-reads: the slot may settle as live, empty or
    // quarantined.
    for (;;) {
      const slot = this.#sessionSlots.get(params.sessionId);
      // Idempotent: a double close is normal teardown; the latch set above goes so gates do not
      // pile up.
      if (slot === undefined) {
        this.#terminalEmissionGates.delete(params.sessionId);
        return;
      }
      // Exhaustive: a new slot state must decide whether close chains on it or acts on it.
      switch (slot.state) {
        case "establishing":
        case "closing":
          await slot.settled;
          continue;
        case "live":
          // Settled and occupied, so this call acts; everything up to the CLOSING write in
          // `#disposeHeldChannel` is synchronous, so no second closer sees this state.
          // Routes first: a route into a dying process would aim a later interrupt at a dead run.
          this.#retireRunRoutes(params.sessionId);
          // Not in `#retireRunRoutes`: its terminal-path caller has just ruled the tripwire.
          this.#outboundFrameTripwire.forgetScope(params.sessionId);
          // Before the await, like the routes: a subagent would wait on a slot in a dying process.
          disposeSubagentAdmission(slot.session.spawnBoundLegs);
          await this.#disposeHeldChannel(params.sessionId, slot.session.channel);
          return;
        case "quarantined":
          // Retry the retained channel, the only handle on a process that would not exit.
          await this.#disposeHeldChannel(params.sessionId, slot.channel);
          return;
      }
    }
  }

  // Holds the slot as CLOSING for the whole await, so it never reads EMPTY while a process is dying
  // and a concurrent create cannot spawn a replacement beside it.
  async #disposeHeldChannel(sessionId: SessionId, channel: ClaudeSessionChannel): Promise<void> {
    let markSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#sessionSlots.set(sessionId, { state: "closing", settled });
    // Pushed at the CLOSING write, before the await, so a waiting caller learns now; every close
    // path funnels through here.
    this.#pendingCompactions.releaseBinding(sessionId);
    try {
      await channel.dispose("session_closed");
      // CLOSING -> EMPTY.
      this.#sessionSlots.delete(sessionId);
      // The gate dies with its session; a later terminal names a run no slot can settle.
      this.#terminalEmissionGates.delete(sessionId);
      // Per-session routing state; a surviving router would answer the next session with a stale
      // thread registry.
      this.#routingBands.delete(sessionId);
      // A live read of a process that no longer exists; keeping it would be a stale registry.
      this.#handshakeBySession.delete(sessionId);
    } catch (error) {
      // CLOSING -> QUARANTINED: nothing else references the still-running process, so keep the
      // channel.
      this.#sessionSlots.set(sessionId, { state: "quarantined", channel });
      throw error;
    } finally {
      // After the state write on both paths, so a chainer resuming here sees the settled state.
      markSettled();
    }
  }

  /**
   * The live channel a run is bound to, or `undefined` when it has none yet. Throws if a tripwire
   * trip disposed the run's binding.
   */
  findChannelForRun(runId: RunId): ClaudeSessionChannel | undefined {
    // Refused, not `undefined`, which would read as "no channel yet" and invite a retry into the
    // same swallow; the refusal carries the run terminal's code.
    this.#runtimeBindingQuarantine.assertRunAttachable(runId);
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.#findLiveSession(sessionId)?.channel;
  }

  /**
   * The terminal-emission gate for one session, read live at each terminal because a gate captured
   * before a close would miss the latch the close sets.
   */
  terminalEmissionGateFor(sessionId: SessionId): ClaudeTerminalEmissionGate {
    return this.#intendedCloseGateFor(sessionId);
  }

  /**
   * The thread-frame router for one session, or `undefined` when it holds no routing band.
   * Non-creating: a get-or-create accessor would let a call after close resurrect a band.
   */
  frameRouterFor(sessionId: SessionId): ThreadFrameRouter<ClaudeRoutableFrame> | undefined {
    return this.#routingBands.get(sessionId)?.router;
  }

  /** The usage-delta accountant for one session, or `undefined` when it holds no routing band. */
  usageAccountantFor(sessionId: SessionId): UsageDeltaAccountant | undefined {
    return this.#routingBands.get(sessionId)?.accountant;
  }

  // Builds the session's routing band if it holds none; reached only from `#registerLiveSession`.
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
   * Binds a session's own thread into the band. Base registers come first, because a released usage
   * frame meters immediately and an unestablished thread refuses it; released frames are re-routed,
   * not shed, since a frame that raced the binding must not be lost.
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
   * Reads the daemon's own prior-emitted cumulative sum for one thread. Only the faulty arms (no
   * reader bound, or a reader that threw) are recorded; an `undefined` answer means nothing
   * emitted.
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
      // Recorded, not rethrown: this runs inside the adoption window, where a throw would orphan a
      // live provider process; over-metering is recoverable, an orphan is not.
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
   * Re-routes frames released from the router's pending-registration hold and hands each decision
   * to the released-frame consumer: no observer call is in flight to carry it back as a return
   * value. Applying the decision alone would drop the interactive request the carve-out keeps
   * reachable.
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
   * Routes one observed inbound frame and answers with the transport's decision. A `SubagentStart`
   * registers its child before the frame routes, or the frame would be held for its own
   * registration; a `SubagentStop` completes the child after, so the stop frame is still
   * suppressed.
   */
  #observeInboundFrame(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    providerSessionId: string,
    observation: ClaudeInboundFrameObservation,
  ): ThreadFrameRoute {
    const router = band.router;

    // Taps run beside the ordinary route: every frame still normalizes, so a compaction boundary
    // yields its `usage.context_compacted` row whether or not anyone waits. Only the session's own
    // thread counts; a child's handshake or compaction says nothing about the parent binding.
    if (observation.subagentId === null) {
      if (observation.handshake !== null) {
        this.#observeHandshakeDeclaration(sessionId, providerSessionId, observation.handshake);
      }
      if (observation.compactionBoundary !== null) {
        this.#pendingCompactions.observeBoundary(
          sessionId,
          observation.compactionBoundary.boundaryPosition,
        );
      }
    }

    const lifecycleSignal = observation.subagentLifecycle;
    if (lifecycleSignal !== null && lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
      const normalized = normalizeClaudeSubagentLifecycle(lifecycleSignal, providerSessionId);
      if (normalized.announcement !== null) {
        const registration = router.registerChildThread(normalized.announcement);
        if (registration.registered) {
          if (band.accountant.hasThread(registration.childThreadId)) {
            // A repeat announcement for a known child: re-establishing would zero its register and
            // double-count its spend, and a second `subagent.started` would duplicate its timeline
            // entry. Recorded, not returned on.
            this.#diagnostics.emit({
              provider: "claude",
              kind: "thread_duplicate_child_announcement",
              rawWireType: observation.frameKind,
              dispositionReason:
                "duplicate subagent announcement for an already-registered child; usage base retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            // A new provider thread starts at zero. Establishing now, not lazily, keeps the usage
            // carve-out reachable: the accountant refuses an unestablished thread.
            band.accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            this.#onSubagentLifecycle?.(sessionId, {
              eventType: "subagent.started",
              subagentId: normalized.subagentId,
              parentReference: normalized.parentToolUseId,
            });
          }
          // Released on both arms: a hold exists only for an unseen identity, and a conditional
          // release would tie the hold to a metering decision.
          this.#releaseHeldFrames(band, sessionId, registration.releasedFrames);
        }
      }
    }

    const frame: ClaudeRoutableFrame = {
      rawWireType: observation.frameKind,
      familyClass: classifyClaudeFrameFamilyForRouting(observation.frameKind, observation),
      // No thread id on this wire: the subagent identity is the child's, and its absence marks the
      // session's own thread.
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
        // Usage is metered ahead of suppression: a child's spend counts even though its content
        // does not.
        this.#meterObservedUsage(band, sessionId, frame);
        this.#completeChildOnStopSignal(band, sessionId, frame);
        return;
      case "suppress-child-transcript":
        this.#completeChildOnStopSignal(band, sessionId, frame);
        return;
      case "carve-out-interactive-request":
      case "held-pending-registration":
      case "quarantined":
        // The interactive ask travels on the decision, which every caller delivers, so a child's
        // ask reaches the parent's approval pipeline. The router already records held and
        // quarantined frames, so neither is a silent drop.
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

  /** Closes a child's `subagent.*` pair on its `SubagentStop`, its only close signal. */
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

  // Get-or-create, so the intent latch survives whichever of close and establishment reaches the
  // session first.
  #intendedCloseGateFor(sessionId: SessionId): ClaudeTerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new ClaudeTerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
  }

  // Only a live slot yields a session: no run may start in a process that is coming up, going down
  // or refusing to die.
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
        // Untrusted caller text, carried as data so an operator can see which definition was
        // withheld.
        details: { sessionId: params.sessionId, definitionName: withheldDefinition.name },
      });
    }
    const posture = params.executionPosture;
    const callbackToolServer = this.#resolveCallbackToolServer(params);
    return {
      sessionId: params.sessionId,
      admittedCostCapUsdMicros: params.admittedCostCapUsdMicros,
      executionPosture: posture,
      sandboxSettings: posture === undefined ? undefined : composeClaudeSandboxSettings(posture),
      // The registry offered is the one the descriptor serves, so a withholding sheds both.
      callbackTools: callbackToolServer === undefined ? undefined : [...callbackToolServer.tools],
      callbackToolServer,
      subagentPolicy: realizedSubagents?.policy,
      withheldSubagentDefinitions: realizedSubagents?.withheld ?? [],
      subagentAdmission: this.#buildSubagentAdmission(params.sessionId, realizedSubagents?.policy),
      outputSchema: params.outputSchema,
      onCallbackToolCall: params.onCallbackToolCall,
      onMcpServerStatus: params.onMcpServerStatus,
      // The shared composer, so this path and the auth probe cannot hold different opt-outs.
      mandatedEnvironment: composeClaudeMandatedEnvironment(),
      // Unvalidated: the static capability gate above this driver already refuses an unpublished
      // level.
      outputSpeed: params.outputSpeed,
    };
  }

  /**
   * Serves a callback-tool registry only when a dispatcher is bound to answer it: a withheld
   * registry costs the model no turns, unlike one served and then refused. Whether the model sees
   * it at all is the transport's declaration (`realizesCallbackToolRegistration`).
   */
  #resolveCallbackToolServer(
    params: CreateSessionParams | ResumeSessionParams,
  ): ClaudeCallbackMcpServerDescriptor | undefined {
    const requestedTools = params.callbackTools ?? [];
    if (requestedTools.length === 0) {
      return undefined;
    }
    // The driver cannot tell a host with no approval seam from an unbound dispatcher.
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
    if (!this.#transport.realizesCallbackToolRegistration) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "callback_tool_registry_withheld",
        rawWireType: null,
        dispositionReason: CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
        details: {
          sessionId: params.sessionId,
          reason: "transport-registration-unavailable",
          withheldToolCount: requestedTools.length,
        },
      });
      return undefined;
    }
    return composeClaudeCallbackMcpServer(requestedTools);
  }

  // One gate per spawn, not per session: a relaunch's subagents are new, and old slots would hold a
  // cap against calls that died with the old process.
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
      admittedCostCapUsdMicros: params.admittedCostCapUsdMicros,
      executionPosture: params.executionPosture,
      outputSchemaDigest: outputSchema === undefined ? undefined : digestOutputSchema(outputSchema),
    };
  }

  // Claude binds posture and output schema at spawn, so a run admitted against a different
  // realization needs a session-boundary relaunch, which is the daemon's decision: refuse instead.
  // Each check is keyed on what the run declares; declaring nothing on an axis leaves it free.
  #assertSpawnBoundRealization(params: StartRunParams, live: LiveClaudeSession): void {
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
    // Band, then slot, then listeners: listener registration can deliver a frame re-entrantly,
    // which needs a band to hold it and a slot for the identity gate to accept the adopted channel.
    // The previous slot is restored if a listener registration throws.
    const previousSlot = this.#sessionSlots.get(live.sessionId);
    const bandExistedBefore = this.#routingBands.has(live.sessionId);
    const band = this.#ensureRoutingBand(live.sessionId);
    this.#sessionSlots.set(live.sessionId, { state: "live", session: live });
    // Discarded where all establishment paths converge, before listeners register: a resume reuses
    // its predecessor's `providerSessionId`, so a surviving record would match. Fail-closed (none
    // survives today); not restored on rollback, since a failed adoption already disposed its
    // source.
    this.#handshakeBySession.delete(live.sessionId);
    try {
      this.#registerLiveSessionHooks(band, live);
    } catch (error) {
      // Restores rather than deletes: the previous value is the caller's `establishing` claim, and
      // deleting it would publish an EMPTY slot a rewind could not recognize.
      if (previousSlot === undefined) {
        this.#sessionSlots.delete(live.sessionId);
      } else {
        this.#sessionSlots.set(live.sessionId, previousSlot);
      }
      // Only a band this call created is released: a rewind's successor joins the predecessor's
      // band, and dropping it would zero registers about to be restored.
      if (!bandExistedBefore) {
        this.#routingBands.delete(live.sessionId);
      }
      throw error;
    }
    // Only after a successful registration, so a failed adoption cannot lift a refusal it never
    // replaced (the quarantine names a binding; a fresh channel now answers for this id).
    this.#runtimeBindingQuarantine.releaseSession(live.sessionId);
  }

  // The listener half of registration, separated so the slot rollback has one thing to guard.
  #registerLiveSessionHooks(band: ClaudeSessionRoutingBand, live: LiveClaudeSession): void {
    // Claude serializes turns per session, so the route pointing at this session is the run that
    // just ended. Only routes retire, never the slot.
    const retireOnTurnTerminal = (terminalFrame: unknown): void => {
      // Identity-gated: a disposed, quarantined or replaced channel can still fire (the driver
      // holds no kill), and an ungated listener would retire the routes of the slot's current
      // session. This also makes the listener a no-op during CLOSING.
      if (this.#findLiveSession(live.sessionId)?.channel !== live.channel) {
        return;
      }
      // Ruled before retirement: the tripwire is keyed by run id, and retirement empties the map
      // those ids come from.
      this.#ruleTextNeutralizationTripwire(live.sessionId, terminalFrame);
      this.#retireRunRoutes(live.sessionId);
    };
    live.channel.onTurnTerminal(retireOnTurnTerminal);
    // Identity-gated the same way, and fail-closed: a frame from a channel the daemon no longer
    // owns must not project.
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
        // Unreachable: the band is built before this listener exists and only a close releases it;
        // kept fail-closed rather than project a frame no router classified.
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
    // Base registers and the session's own thread identity, before any frame can be metered.
    this.#bindSessionThread(band, live.sessionId, live.providerSessionId, live.establishment);
    // Through the accessor `closeSession` uses, so a close signaled during establishment finds its
    // latch.
    this.#intendedCloseGateFor(live.sessionId);
  }

  /**
   * Whether this channel is bound to this session in any state the session can continue from.
   * Wider than `#findLiveSession`, for frame routing only: a rewind holds an `establishing` slot
   * while the predecessor keeps emitting, and refusing those frames would leave a transcript hole.
   */
  #isChannelCurrentlyBound(sessionId: SessionId, channel: ClaudeSessionChannel): boolean {
    const slot = this.#sessionSlots.get(sessionId);
    if (slot === undefined) {
      return false;
    }
    // Exhaustive: a new state forces a routing decision instead of defaulting to refused.
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

  // Names the current holder of a session slot for a refusal detail, or `undefined` when the slot
  // is free. One predicate, so the two entry points agree on what "taken" means.
  #describeSlotHolder(sessionId: SessionId): string | undefined {
    const slot = this.#sessionSlots.get(sessionId);
    if (slot === undefined) {
      return undefined;
    }
    // Exhaustive over the union: a new state must decide what a racing create sees.
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

  // Claims the slot synchronously, before `establish` is awaited, so no caller sees a free slot
  // while it spawns; releases the claim however it settles.
  async #withSessionSlotClaimed<TEstablished>(
    sessionId: SessionId,
    establish: () => Promise<TEstablished>,
  ): Promise<TEstablished> {
    const establishment = establish();
    // Rejection-swallowed: chainers await it only to sequence, and a stored rejecting promise would
    // go unhandled.
    const settled = establishment.then(
      () => undefined,
      () => undefined,
    );
    // No channel: a create or resume starts from EMPTY.
    this.#sessionSlots.set(sessionId, { state: "establishing", settled, channel: undefined });
    try {
      return await establishment;
    } finally {
      // A successful establishment has already overwritten the slot; only a failed one is cleared,
      // and only if the claim is ours.
      const slot = this.#sessionSlots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#sessionSlots.delete(sessionId);
      }
    }
  }

  /**
   * Claims a live slot for a rewind and restores the predecessor if it installs no successor.
   * Unlike `#withSessionSlotClaimed` it must not clear on failure: a rewind starts from live, and
   * an EMPTY slot for a running process would let the next create spawn a second one.
   */
  async #withRewindSlotClaimed(
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
    rewind: () => Promise<ForkConversationResult>,
  ): Promise<ForkConversationResult> {
    const rewinding = rewind();
    const settled = rewinding.then(
      () => undefined,
      () => undefined,
    );
    // The predecessor's channel stays bound: its process is still up and emitting frames that
    // belong to this session's transcript.
    this.#sessionSlots.set(sessionId, {
      state: "establishing",
      settled,
      channel: predecessor.channel,
    });
    try {
      return await rewinding;
    } finally {
      // Identity-checked, so a successful rewind or a concurrent close is left alone.
      const slot = this.#sessionSlots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#sessionSlots.set(sessionId, { state: "live", session: predecessor });
      }
    }
  }

  /**
   * Rules the text-neutralization tripwire on a settling turn. Claude's terminal frame names no
   * run, so only the oldest run with a pending frame consumes its evidence; any further correlated
   * run is ruled against none and trips, since retiring the routes means it can never be confirmed.
   */
  #ruleTextNeutralizationTripwire(sessionId: SessionId, terminalFrame: unknown): void {
    // Ordered by pending frames, not routes: a run ruled by `#ruleFailedOpeningFrame` on the
    // dead-channel arm keeps its route but has no registration, and must not consume live evidence.
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
      // `startRun` allows one pending frame per session, so positions past 0 are unreachable; kept
      // fail-closed, since crediting the real verdict to two runs would let a swallow ride a
      // sibling.
      const classification =
        framePosition === 0 ? settlingClassification : UNRECOGNIZED_TURN_EVIDENCE;
      const decision = this.#outboundFrameTripwire.settle(runId, classification);
      if (!decision.tripped) {
        continue;
      }
      if (!tripped) {
        tripped = true;
        // Quarantined first and on both axes, so a caller reacting synchronously cannot reach the
        // process that swallowed the text by either door.
        this.#runtimeBindingQuarantine.disposeSession(sessionId);
      }
      this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
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
   * Rules every frame a condemned binding leaves unsettled, fail closed, with
   * `UNRECOGNIZED_TURN_EVIDENCE`: `#ruleFailedOpeningFrame` is frame-scoped, so a sibling run's
   * frame would otherwise sit pending forever. Reported once per run, with the trip's cause.
   */
  #ruleAbandonedFramesFailClosed(sessionId: SessionId): void {
    const rulings = this.#outboundFrameTripwire.settleScope(sessionId, UNRECOGNIZED_TURN_EVIDENCE);
    for (const ruling of rulings) {
      if (!ruling.decision.tripped) {
        continue;
      }
      const runId = this.#runIdBoundToSession(ruling.joinKey, sessionId);
      if (runId === undefined || this.#runtimeBindingQuarantine.isRunDisposed(runId)) {
        continue;
      }
      this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeTextNeutralizationRunFailure(ruling.decision),
      );
    }
  }

  /**
   * Tears down the channel a tripwire trip condemned, through `#disposeHeldChannel`. Detached: the
   * only caller is a channel's synchronous terminal listener, which must not wait on a child's
   * death; the refusal still holds, since the quarantine entry is installed first.
   */
  #disposeQuarantinedSession(sessionId: SessionId): void {
    // Outside the liveness read: the frames are owed an answer whether or not a channel is left.
    this.#ruleAbandonedFramesFailClosed(sessionId);
    const live = this.#findLiveSession(sessionId);
    if (live === undefined) {
      return;
    }
    void this.#disposeHeldChannel(sessionId, live.channel).catch(() => {
      // Recorded there: a rejected dispose has already moved the slot to `quarantined` with the
      // channel retained for a later close. Rethrowing would be an unhandled rejection out of a
      // terminal listener.
    });
  }

  // A throwing consumer must not become a second failure: the run terminal is the guarantee, and
  // losing it would leave the swallowed turn with no record.
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

  /**
   * Fails the runs whose frames a rewind superseded before the provider settled them, so user text
   * that may not have reached the model never vanishes. No terminal can settle them (the
   * successor's hook is identity-gated). Not a trip and not quarantined: the runs keep their
   * interrupt controls.
   */
  #failSupersededDeliveries(sessionId: SessionId): void {
    const abandoned = this.#outboundFrameTripwire.abandonScope(sessionId);
    const reportedRunIds = new Set<RunId>();
    for (const frame of abandoned) {
      const runId = this.#runIdBoundToSession(frame.joinKey, sessionId);
      // The lookup only brands the join key as a run id; an unresolved key cannot occur.
      if (runId === undefined || reportedRunIds.has(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeSupersededDeliveryRunFailure(frame.detailOrigin),
      );
    }
  }

  /** The run a join key names, checked against the session it is bound to. */
  #runIdBoundToSession(joinKey: string, sessionId: SessionId): RunId | undefined {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === sessionId) {
        return runId;
      }
    }
    return undefined;
  }

  /** Drops every run route pointing at this session; the slot is untouched. */
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

  /**
   * Disposes a channel the driver refuses to adopt and returns a note for the refusal text. A
   * disposal error is not rethrown (it would hide the identity divergence) and nothing is retained
   * (a held slot would make create un-retryable); the transport takes ownership on `dispose`.
   */
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
