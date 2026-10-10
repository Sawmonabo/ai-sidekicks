/**
 * The lifecycle's dependencies and the per-session state it keeps: the live session, its
 * routing band, the slot it occupies, and the frame router configuration.
 */

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { StagedChangesWorktree } from "../../../../git/worktree/staged-changes.js";
import type { ExecutionPostureService } from "../../../../policy/execution-posture-service.js";
import type { RunEngine } from "../../../../session/run/engine.js";
import type { RunInboundDispatch } from "../../../../session/run/inbound.js";
import type { PermissionAskPort } from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import type { RuntimeBindingRebind } from "../../../runtime-binding-store.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import type {
  ClaudeAccountFolders,
  SessionEnvironmentRows,
  SpawnEnvPair,
} from "../../../spawn-env.js";
import {
  ThreadFrameRouter,
  type RoutableProviderFrame,
  type ThreadFrameRoute,
  type ThreadFrameRouterConfig,
} from "../../../thread-frame-router.js";
import {
  UsageDeltaAccountant,
  type CumulativeAxisReadings,
  type MeteredUsageDelta,
} from "../../../usage-delta-accountant.js";
import type { DriverResumeResult } from "../../contract.js";
import type { ClaudeAttachedAdvisor, ClaudeCommandChoices } from "./answered-commands.js";
import type { ClaudeDeadlineScheduler } from "./control-requests.js";
import type {
  ClaudeHandshakeDeclaration,
  ClaudeInboundFrameObservation,
  ClaudeInitializeDeclaration,
  ClaudeRunDispatchResolver,
  ClaudeProviderProcess,
  ClaudeSessionTransport,
  ClaudeSpawnBoundLegs,
} from "./transport.js";

/**
 * One provider session's `system/init` declaration, stamped with the provider session id it was
 * observed under. A rewind forks a new process behind the same `SessionId`, so reads check the
 * stamp and answer as unobserved rather than with the dead process's declaration.
 */
export interface ClaudeHeldHandshake {
  readonly providerSessionId: string;
  readonly declaration: ClaudeHandshakeDeclaration;
  /** Command names invocable over the programmatic transport: `slash_commands` only, uncapped. */
  readonly invocableCommandNames: ReadonlySet<string>;
}

/** A session's router and accountant, held together so no frame routes to an unmetered thread. */
export interface ClaudeSessionRoutingBand {
  readonly router: ThreadFrameRouter<ClaudeRoutableFrame>;
  readonly accountant: UsageDeltaAccountant;
}

/** What a session's process was spawned with, kept so a later run can be checked against it. */
export interface ClaudeSpawnBinding {
  // The complete posture, so every axis can be compared.
  readonly executionPosture: ExecutionPosture | undefined;
  readonly outputSchemaDigest: string | undefined;
}

/** Where and as whom one session's process runs, resolved by the daemon at every spawn. */
interface ClaudeSessionSpawnContext {
  /** The session's working folder, absolute. */
  readonly workingDirectory: string;
  readonly environmentRows: SessionEnvironmentRows | undefined;
  /** The account home the app manages, or `undefined` for the person's own Claude Code home. */
  readonly accountFolders: ClaudeAccountFolders | undefined;
  /** The agent's memory folder and its link, absolute; empty where the agent keeps none. */
  readonly memoryFolders: readonly string[];
  /**
   * The session's own advisor model as last stored, each change `/advisor` made included, or
   * `null` when it is off; never the app's default once the session exists.
   */
  readonly advisorModel: string | null;
  /**
   * The session's own output style as last stored, each change `/output-style` made included, or
   * `null` where it chose none and Claude Code's own setting holds.
   */
  readonly outputStyle: string | null;
}

/** Resolves a session's spawn context, wired by the daemon. */
export interface ClaudeSpawnContextResolver {
  resolveSpawnContext(
    sessionId: SessionId,
    providerAccountId: string | undefined,
  ): Promise<ClaudeSessionSpawnContext>;
}

/**
 * The run engine's own operations the driver calls: the start of a turn the daemon starts on a
 * session itself, the end of a turn whose process ended on its own, and the comparison of a run's
 * settled output speed with the level it asked for.
 */
export type ClaudeRunEnginePort = Pick<
  RunEngine,
  "startDaemonTurn" | "endTurnOnProcessExit" | "recordSettledOutputSpeed"
>;

/**
 * Where every delivery from a Claude Code process goes, in the order its binding delivered it:
 * rows, run moves, child runs, markers, asks and session notices.
 */
export type ClaudeInboundDispatchPort = Pick<RunInboundDispatch, "dispatch">;

/** Opens the temporary worktree a staged review runs in; wired by the daemon's git service. */
export interface ClaudeStagedChangesSource {
  /** Throws when the folder is no git working tree or the worktree cannot be made. */
  openStagedWorktree(workingDirectory: string): Promise<StagedChangesWorktree>;
}

/** A session whose provider process is running, with the legs it was spawned with. */
export interface LiveClaudeSession {
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly channel: ClaudeProviderProcess;
  readonly spawnBinding: ClaudeSpawnBinding;
  /**
   * The legs this process was spawned with. A rewind respawns from these; re-deriving would guess,
   * and a guess that omits the posture relaunches the session unsandboxed.
   */
  readonly spawnBoundLegs: ClaudeSpawnBoundLegs;
  /**
   * The posture the session runs at now: the spawn's, until a live level move replaces it. A
   * relaunch spawns at this one.
   */
  executionPosture: ExecutionPosture | undefined;
  /** Whether the session's next turns build or plan; a fresh process builds. */
  sessionMode: SessionMode;
  /**
   * The session's advisor model now, or `null` when it is off: the spawn's, until `/advisor`
   * changes it. Every process started for the session carries this one.
   */
  advisorModel: string | null;
  /**
   * The session's own output style now, or `null` where it chose none and Claude Code's own
   * setting holds: the spawn's, until `/output-style` changes it. Every process started for the
   * session carries this one.
   */
  outputStyle: string | null;
  /**
   * The model the session runs on now: the spawn's, until Claude Code switches it for the rest of
   * the session. A relaunch and a fork pass this one as `--model`.
   */
  runningModel: string;
  /** What the process's `initialize` reply declared. */
  readonly initialize: ClaudeInitializeDeclaration;
  /**
   * The style descriptions and advisors Claude Code offers, read by the control-only process run
   * beside the first spawn on the session's model and reused for every later session on it, kept
   * across a rewind; never rejects, an unreadable reading holding why.
   */
  readonly commandChoices: Promise<ClaudeCommandChoices>;
  /**
   * The advisor Claude Code says it attaches to this process's requests, read after the spawn and
   * after every advisor change; an answer names no advisor this says will not attach.
   */
  attachedAdvisor: ClaudeAttachedAdvisor;
  /**
   * The output-speed level this process last accepted with `apply_flag_settings`, or `undefined`
   * when it accepted none. A rewind applies it to the forked process; a run asking for it sends
   * nothing.
   */
  appliedOutputSpeed: string | undefined;
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
export type ClaudeUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

/**
 * One canonical session's slot state. Absence from `#sessionSlots` is EMPTY, the only state where
 * a create or resume may proceed. One registry holds every state so a slot mid-disposal never
 * reads as EMPTY. Arms with an in-flight transition carry a `settled` promise that never rejects.
 */
export type ClaudeSessionSlot =
  // A create, resume or rewind is bringing a process up. Ends live, or EMPTY on failure.
  // `channel` is the predecessor's on a rewind, so its frames stay attributable during the fork.
  | {
      readonly state: "establishing";
      readonly settled: Promise<void>;
      readonly channel: ClaudeProviderProcess | undefined;
    }
  // A process is up and may accept runs. The only startable state.
  | { readonly state: "live"; readonly session: LiveClaudeSession }
  // `dispose` is in flight. Ends EMPTY on resolve, QUARANTINED on reject.
  | { readonly state: "closing"; readonly settled: Promise<void> }
  // `dispose` rejected: the process is still alive and this channel is the only handle anyone
  // holds on it. Retained until a later close disposes it.
  | { readonly state: "quarantined"; readonly channel: ClaudeProviderProcess };

/**
 * Whether the provider-account member is present but empty, a wiring fault the caller refuses
 * (create throws, resume returns `failed`). Folding it to `null` would hide it; carrying it would
 * let two accountless bindings compare equal.
 */
export function isUnusableAdmittedProviderAccountId(requested: string | undefined): boolean {
  return requested !== undefined && requested.length === 0;
}

/** The provider account id a session declares, or null when none was requested. */
export function readAdmittedProviderAccountId(requested: string | undefined): string | null {
  return requested ?? null;
}

/** What a Claude session lifecycle needs from the daemon: the transport, sinks and id sources. */
export interface ClaudeSessionLifecycleDependencies {
  readonly transport: ClaudeSessionTransport;
  /** The login shell's environment captured at the daemon's start, every spawn's base. */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  readonly spawnContext: ClaudeSpawnContextResolver;
  /** Resolves the curated credential list a posture names into the paths every spawn denies. */
  readonly credentialPolicy: Pick<ExecutionPostureService, "resolveCredentialPolicy">;
  readonly runDispatchResolver: ClaudeRunDispatchResolver;
  readonly runEngine: ClaudeRunEnginePort;
  readonly inbound: ClaudeInboundDispatchPort;
  /**
   * The approval pipeline's intake of the permission asks the run engine admitted; until it is
   * registered an ask stays pending at Claude Code.
   */
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  /** The questions card's intake; until it is registered a question stays pending. */
  readonly questions: PortRegistration<QuestionPort>;
  /** The approval service's intake of the blocks Claude Code's reviewer made at Reviewed. */
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  /** Opens the temporary worktree a review of the staged changes runs in. */
  readonly stagedChanges: ClaudeStagedChangesSource;
  /**
   * Receives the result of each resume the driver starts itself, after a process ended on its own
   * or on a provider build change, so the daemon records the binding it minted or the failure.
   */
  readonly onSessionRelaunched: (sessionId: SessionId, result: DriverResumeResult) => void;
  /**
   * Points the session's binding at the session a rewind forked, so a later resume opens that one,
   * and records in the same write the session it left. Rejects when it was not recorded.
   */
  readonly rebindRuntimeBinding: (rebind: RuntimeBindingRebind) => Promise<void>;
  /** The operating system the daemon runs on, chosen where the daemon is composed. */
  readonly operatingSystem: ProviderOperatingSystem;
  /**
   * Schedules a restart wait and answers its cancel; an unref'd timer by default, injectable to
   * skip the wait.
   */
  readonly restartScheduler?: ClaudeDeadlineScheduler | undefined;
  /** The clock the crash window reads, in milliseconds; `Date.now` by default. */
  readonly now?: (() => number) | undefined;
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
  /**
   * Receives the routing decision for a frame released from a hold, when no observer call can
   * answer for it. Only `carve-out-usage` and `child-transcript` occur; interactive
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
export interface ClaudeRoutableFrame extends RoutableProviderFrame {
  readonly threadId: string;
  /** The observation this frame was built from, so a released hold can still be metered. */
  readonly observation: ClaudeInboundFrameObservation;
}

/**
 * The router's bounds. The hold covers a subagent's frames arriving ahead of its `SubagentStart`;
 * the short timeout means a frame held longer names a child never announced.
 */
export const CLAUDE_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});
