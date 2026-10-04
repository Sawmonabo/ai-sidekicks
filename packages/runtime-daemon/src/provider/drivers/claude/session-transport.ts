/**
 * The seam between the Claude session lifecycle and the process that runs a session: the frames it
 * writes, the control requests it sends, the channel it observes, and the requests that open,
 * resume, rewind or probe a session.
 */

import type {
  ExecutionPosture,
  RunId,
  SessionCallbackTool,
} from "@ai-sidekicks/contracts/provider-driver";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import { type ThreadFrameRoute } from "../../thread-frame-router.js";
import { type CumulativeAxisReadings } from "../../usage-delta-accountant.js";
import {
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type SpawnEnvPair,
} from "../../spawn-env.js";
import { type OutboundTextFrame } from "../../outbound-frame.js";
import { CLAUDE_DRIVER_NAME } from "./capabilities.js";
import { type ClaudeSubagentLifecycleSignal } from "./event-normalizer.js";
import type {
  ClaudeSubagentAdmissionPort,
  ClaudeWithheldSubagentDefinition,
} from "./subagent-policy.js";
import type { ClaudeCallbackMcpServerDescriptor, ClaudeSandboxSettings } from "./spawn-settings.js";
import type {
  CallbackToolInvocation,
  CallbackToolResult,
  McpServerStatusProducer,
  StartRunParams,
  SubagentPolicy,
} from "../../provider-driver.js";

/** Bare name: `system/init` lists `slash_commands` without the leading slash. */
export const CLAUDE_COMPACTION_COMMAND_NAME = "compact";

/** The slash command that asks the provider to compact its context. */
export const CLAUDE_COMPACTION_COMMAND_TEXT: string = `/${CLAUDE_COMPACTION_COMMAND_NAME}`;

/**
 * A literal here, not a parameter: the `driver_command` origin is exempt from the text-
 * neutralization tripwire, so a caller-supplied value would let user words through.
 */
export const CLAUDE_COMPACTION_FRAME_ORIGIN = "driver_command";

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
export interface ClaudeProviderProcess {
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
  sendUserText(frame: OutboundTextFrame): Promise<ClaudeUserTextWriteAttempt>;

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
   * in the parent's transcript.
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
  /** The session's model, passed as `--model` on every spawn. */
  readonly model: string;
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
  readonly channel: ClaudeProviderProcess;
}

/**
 * An attachment produced by a resume or a rewind, carrying the position the process landed at: for
 * a rewind, where the fork landed, not the requested position.
 */
export interface ClaudeResumedSessionAttachment extends ClaudeSessionAttachment {
  // Required, so a transport cannot report a resume it cannot evidence.
  readonly sessionPosition: number;
}

/** A usable credential found by the zero-turn auth probe; the negative outcomes throw. */
export interface ClaudeAuthProbeReading {
  /**
   * Non-PII diagnostics only, never credential material or an account email; bounded by the driver.
   */
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

/** One composition for the spawn legs and the auth probe, so the two cannot drift. */
export function composeClaudeMandatedEnvironment(): readonly SpawnEnvPair[] {
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
   * `CLAUDE_*` and `CLAUDECODE*` are stripped and configuration comes through `--settings`, not
   * `~/.claude`, so ambient developer config cannot reach the agent and two sessions on one node
   * cannot read each other's settings. `mandatedEnvironment` is applied last, replacing
   * same-named entries. This holds for `resumeSession` and `rewindSession`. A determinate
   * logged-out failure throws `ClaudeAuthenticationRequiredError` (the only route to
   * `reauth-required`), any other failure throws something else.
   */
  spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment>;
  /** Re-attaches to an existing provider session, with `spawnSession`'s auth-failure obligation. */
  resumeSession(request: ClaudeSessionResumeRequest): Promise<ClaudeResumedSessionAttachment>;
  /**
   * Forks the session at a rewind target. Separate from `resumeSession` because a resume landing on
   * a different session id is a failure while a rewind landing on the same id is one; it carries
   * `spawnSession`'s obligations.
   */
  rewindSession(request: ClaudeSessionRewindRequest): Promise<ClaudeResumedSessionAttachment>;
  /**
   * The zero-turn authentication probe; reaching a working `system/init` is the evidence (no
   * authless probe exists, measured). The transport spends no turn, leaks no credential material,
   * tears down what it starts on every path, carries `request.mandatedEnvironment`, and throws
   * `ClaudeAuthenticationRequiredError` for a determinate logged-out reading, else any other error.
   */
  probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading>;
}

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
 * text-neutralization trip disposed: `undefined` ("no channel bound") would invite a retry into a
 * process that swallowed the user's words.
 */
export interface ClaudeRunProcessLookup {
  findProcessForRun(runId: RunId): ClaudeProviderProcess | undefined;
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
