/**
 * The per-session state the Codex lifecycle keeps: the session record, its turn memories, the
 * lifecycle's dependencies, and the readers for frames it routes.
 */

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { ExecutionPostureService } from "../../../../policy/execution-posture-service.js";
import type { RunEngine } from "../../../../session/run/engine.js";
import type { PermissionAskPort } from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { CommandOutputPublisher } from "../../../port/command-output-publisher.js";
import type { ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import type { RuntimeBindingRebind } from "../../../runtime-binding-store.js";
import type { ToolServerRoute } from "../../../port/tool-server-route.js";
import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import type { ProviderCommandResolver } from "../../../spawned-version.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import {
  type ChildThreadAnnouncement,
  type RoutableProviderFrame,
  type ThreadFrameRouterConfig,
} from "../../../thread-frame-router.js";
import {
  type CumulativeAxisReadings,
  type CumulativeUsageReading,
  type MeteredUsageDelta,
  type UsageTokenAxis,
  type WindowTelemetry,
} from "../../../usage-delta-accountant.js";
import {
  CODEX_THREAD_STARTED_METHOD,
  deriveCodexChildThreadAnnouncement,
} from "../event-normalizer.js";
import type { CodexServerPromptPort } from "../commands.js";
import type { CodexDeliveryMemory } from "../delivery/memory.js";
import type { CodexInboundDispatchPort } from "../delivery/dispatch.js";
import type { CodexSessionServerRequestResponder } from "../server-requests.js";
import type { CodexCommandRunner, CodexServiceLauncher } from "../service/process.js";
import type { CodexHomeResolver } from "../service/registry.js";
import type { CodexService } from "../service/supervisor.js";
import type { CodexThreadPermissionProfiles } from "../thread/permission-profiles.js";
import type { CodexThreadSettings } from "../thread/settings.js";
import type { CodexDiagnosticSink, CodexScheduleTimeout } from "../transport/diagnostics.js";
import type { CodexServiceSocketConnector } from "../transport/socket.js";
import type { CodexSpawnContextResolver } from "./config.js";
import type { CodexSessionSlotState } from "./errors.js";
import { isPlainObject } from "../../../record-readers.js";
import type { DriverResumeResult } from "../../contract.js";
import type { DaemonTurnBindingResolver, ResumeRunParams } from "../../run-control.js";

/** Terminal `TurnStatus` values; `inProgress` is excluded so a live route is never retired. */
const CODEX_TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
]);

/**
 * Ceiling on interrupted runs whose terminals are still owed (see
 * `CodexSessionRecord.interruptedRunIdByTurnId`); refuses instead of pruning, since an evicted
 * entry loses its terminal.
 */
const CODEX_INTERRUPTED_ROUTE_MEMORY = 64;

/** Settled turn ids remembered per session (see `CodexSessionRecord.settledTurnIds`). */
const CODEX_SETTLED_TURN_MEMORY = 64;

/** What a turn was sent with, kept so a faster-model retry can send it again. */
interface CodexTurnInput {
  readonly texts: readonly string[];
  readonly clientMessageIds: readonly string[];
  readonly skill: CodexPickedSkill | undefined;
  /** The level the turn alone ran at, which a resend of the turn keeps. */
  readonly outputSpeedForTurn: string | undefined;
}

/** A skill the person picked for a turn, as Codex's skill input names it. */
export interface CodexPickedSkill {
  readonly name: string;
  readonly path: string;
}

/** Everything the lifecycle keeps for one live Codex session. */
export interface CodexSessionRecord {
  readonly sessionId: SessionId;
  /**
   * The service the conversation is loaded on; a move onto a new provider build replaces it in
   * place, as a fork replaces `threadId`.
   */
  service: CodexService;
  /**
   * The thread this session is bound to. Only a fork changes it, in place, because in-flight
   * closures hold this record and check the slots still map to it.
   */
  threadId: string;
  /**
   * The runtime binding whose resume handle names `threadId`, rewritten as soon as a fork answers
   * so a resume after a daemon restart opens the fork: the binding of the run last started here,
   * or the one a resume minted. `undefined` until the daemon names one.
   */
  bindingId: string | undefined;
  /** The account the conversation runs on, `undefined` on the node's default home. */
  readonly providerAccountId: string | undefined;
  /**
   * This thread's turn ids, oldest first; `MoveSessionToForkParams.position` N is
   * `turnBoundaries[N - 1]`. Read back from the thread on resume and fork, appended at each
   * accepted `turn/start`. Uncapped: evicting the head would re-map every later ordinal.
   */
  readonly turnBoundaries: string[];
  /** The turn each of the person's messages started, by the message's id, for an undo's cut. */
  readonly turnIdByClientMessageId: Map<string, string>;
  /**
   * What every start, resume and fork of the thread carries, the settings as chosen; replaced when
   * the model, the window or the permission level moves, so a resume after a crash sends the
   * current ones.
   */
  threadSettings: CodexThreadSettings;
  /**
   * Whether the conversation still owes a fork onto a config `threadSettings` changed, since a
   * level's config keys and the window reach a conversation only through a start, resume or fork.
   * Cleared as a fork's request is composed; a turn never starts while it is set.
   */
  isConfigForkOwed: boolean;
  /**
   * The conversations forks moved the session off before it had a binding, oldest first; the
   * binding of its first run records them, emptying this.
   */
  readonly leftThreadIdsAwaitingBinding: string[];
  /**
   * The session's level and roots as they stand now: the posture it was established at, its level
   * moved by each live level change. A turn the daemon starts itself runs at it.
   */
  executionPosture: ExecutionPosture;
  /**
   * The permission profile Codex last reported for `threadId` and those asked for since, against
   * which each `thread/settings/updated` is checked for a drift.
   */
  permissionProfiles: CodexThreadPermissionProfiles;
  /**
   * Build or Plan as the person last set it on this record, sent again after every resume and
   * every move to another service, so a conversation in Plan never comes back in Build.
   */
  sessionMode: SessionMode;
  /**
   * The output-speed level the carriers last asked for: the session's at establishment, then each
   * accepted turn's. A run carrying none, and a fork, ask for it again, each resolved afresh
   * against the model's tier list.
   */
  outputSpeedRequest: string | undefined;
  /**
   * The tier the thread declared on its establishment reply, replaced by each
   * `thread/settings/updated` for this thread. Held for the binding's life and written nowhere.
   */
  declaredOutputSpeed: ProviderOutputSpeedState | undefined;
  /**
   * The reasoning effort the conversation runs at, as Codex last reported it on an establishment
   * reply or `thread/settings/updated`; a mode move sends it back, since one without it resets it.
   */
  reasoningEffort: string | null;
  /**
   * Accepted turns, by turn id, whose run has yet to report the tier it settled at; each entry
   * leaves on its settlement, at the latest on the turn's `turn/completed`.
   */
  readonly unsettledOutputSpeedRuns: Map<string, CodexUnsettledOutputSpeedRun>;
  /**
   * Every live turn, keyed by turn id, newest last. Turn-keyed because a run can hold several
   * live turns; a run-keyed map would lose the first one's terminal route.
   */
  readonly runIdByActiveTurnId: Map<string, RunId>;
  /**
   * Turn ids whose terminal was ingested, newest last, so a turn that ended before its
   * `turn/start` answer was read gets no live route and an interrupt holds no entry for it.
   * Written for every terminal, never consumed; pruned oldest-first to `CODEX_SETTLED_TURN_MEMORY`.
   */
  readonly settledTurnIds: Set<string>;
  /**
   * Runs whose route an interrupt retired before their turn's terminal arrived, keyed by that
   * turn id: `turn/interrupt` resolves on acceptance, and the later `turn/completed` is the
   * interrupt's outcome for that run. Not a live route. Bounded by refusal at
   * `CODEX_INTERRUPTED_ROUTE_MEMORY`, never eviction; released when the terminal arrives.
   */
  readonly interruptedRunIdByTurnId: Map<string, RunId>;
  /**
   * The newest steer sent on the conversation, settled either way; the next steer is sent once it
   * settles, so steers reach Codex one at a time in the order they were handed over.
   */
  lastSteerSend: Promise<void>;
  /** Runs asked to pause whose turn has a step in flight, by that turn's id. */
  readonly pauseRunIdByTurnId: Map<string, RunId>;
  /**
   * Runs whose turn was interrupted to pause them, by that turn's id: its interrupted terminal is
   * the pause taking effect, never the run's end.
   */
  readonly pausedRunIdByInterruptedTurnId: Map<string, RunId>;
  /**
   * Continues asked for while a pause's interrupt was on its way, by the run: the interrupted
   * turn's end starts the next turn instead of reporting the pause.
   */
  readonly continuesAwaitingPause: Map<RunId, ResumeRunParams>;
  /** What each live turn was sent with, by turn id; each leaves with its turn's terminal. */
  readonly turnInputByTurnId: Map<string, CodexTurnInput>;
  /** What this record's deliveries remember between frames. */
  readonly delivery: CodexDeliveryMemory;
}

/**
 * How a session's thread bases its usage registers. The resume arm names the thread whose
 * prior-emitted sum it bases on, which after a rewind is not the new forked thread.
 */
export type CodexUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

/** Records that a turn's terminal was ingested, pruning the oldest past the memory's bound. */
export function rememberSettledTurn(record: CodexSessionRecord, turnId: string): void {
  const memory = record.settledTurnIds;
  memory.delete(turnId);
  memory.add(turnId);
  while (memory.size > CODEX_SETTLED_TURN_MEMORY) {
    const oldest = memory.values().next();
    if (oldest.done === true) {
      break;
    }
    memory.delete(oldest.value);
  }
}

/**
 * Retains an interrupted run's turn correlation for its coming terminal; false (session-fatal)
 * at the ceiling. Never evicts: every entry is still owed its terminal, and an evicted one
 * would leave that terminal reaching no run.
 */
export function rememberInterruptedRun(
  record: CodexSessionRecord,
  turnId: string,
  runId: RunId,
): boolean {
  const memory = record.interruptedRunIdByTurnId;
  if (!memory.has(turnId) && memory.size >= CODEX_INTERRUPTED_ROUTE_MEMORY) {
    return false;
  }
  memory.delete(turnId);
  memory.set(turnId, runId);
  return true;
}

/**
 * Whether a turn runs or is starting on the session, or one Codex started by itself is opening its
 * run, so input the daemon sends would fold into it rather than start a turn of its own. The
 * opening of `openingTurnId` itself does not count, for the run that opening starts.
 */
export function isTurnInFlight(record: CodexSessionRecord, openingTurnId?: string): boolean {
  const opening = record.delivery.selfStartedTurnOpening;
  return (
    record.runIdByActiveTurnId.size > 0 ||
    record.delivery.startingTurnRunIds.length > 0 ||
    (opening !== undefined && opening.turnId !== openingTurnId)
  );
}

/** The newest live turn a run holds on one session, or `undefined`; interventions land there. */
export function newestActiveTurnForRun(
  record: CodexSessionRecord,
  runId: RunId,
): string | undefined {
  let newest: string | undefined;
  for (const [turnId, routedRunId] of record.runIdByActiveTurnId) {
    if (routedRunId === runId) {
      newest = turnId;
    }
  }
  return newest;
}

/**
 * The run whose turn is active on one session record, or `null` unless every live turn belongs
 * to one run. Record-scoped: a resume installs a fresh record under the same session id.
 */
export function soleActiveRunIdIn(record: CodexSessionRecord): RunId | null {
  let soleActiveRunId: RunId | null = null;
  for (const runId of record.runIdByActiveTurnId.values()) {
    if (soleActiveRunId === null) {
      soleActiveRunId = runId;
      continue;
    }
    if (soleActiveRunId !== runId) {
      return null;
    }
  }
  return soleActiveRunId;
}

/** A session slot held for the duration of one in-flight lifecycle transition. */
export interface CodexSessionTransition {
  readonly kind: CodexSessionTransitionKind;
  /** Settlement of the transition; rejections are swallowed so a waiter does not inherit them. */
  readonly settled: Promise<void>;
}

/** The slot states a transition can publish: all but `live`, which is what a settled record is. */
export type CodexSessionTransitionKind = Exclude<CodexSessionSlotState, "live">;

/**
 * A run whose turn the driver lost before Codex settled it, a resume superseding it or the
 * service it ran on going away: whether its words reached the model was never established.
 */
export interface CodexLostRunFailure {
  readonly eventType: "run.failed";
  readonly failureCategory: "provider failure";
  readonly recoveryCondition: "recovery-needed";
  readonly providerFailureDetail: string;
}

/**
 * The run engine's own operations the driver calls: the run of a turn the daemon starts itself, the
 * end of a turn whose service process ended on its own, and the comparison of a run's settled
 * output speed with the level it asked for.
 */
export type CodexRunEnginePort = Pick<
  RunEngine,
  "startDaemonTurn" | "endTurnOnProcessExit" | "recordSettledOutputSpeed"
>;

/** Construction inputs for the lifecycle manager. */
export interface CodexLifecycleOptions {
  /**
   * Resolves the Codex command afresh at every service start, along the service's environment, so
   * a restart runs what the command names now.
   */
  readonly providerCommand: ProviderCommandResolver;
  /** The login shell's environment captured at the daemon's start, every service's base. */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  /** The operating system the daemon runs on, chosen where the daemon is composed. */
  readonly operatingSystem: ProviderOperatingSystem;
  readonly homes: CodexHomeResolver;
  readonly spawnContext: CodexSpawnContextResolver;
  /** Resolves the curated credential list a posture names into the paths every level denies. */
  readonly credentialPolicy: Pick<ExecutionPostureService, "resolveCredentialPolicy">;
  /** Where the daemon serves the session's tool servers; unregistered, it reaches none. */
  readonly toolServerRoute: PortRegistration<ToolServerRoute>;
  /** More `-c` switches for every service the daemon starts. */
  readonly additionalConfigOverrides?: readonly string[] | undefined;
  readonly launchProcess?: CodexServiceLauncher | undefined;
  readonly runCommand?: CodexCommandRunner | undefined;
  readonly connectSocket?: CodexServiceSocketConnector | undefined;
  /** The transport's diagnostic channel; separate from `diagnostics`, the daemon-wide band. */
  readonly reportDiagnostic: CodexDiagnosticSink;
  /** The daemon-wide diagnostic band; required, since each fail-closed path owes a record. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly scheduleTimeout?: CodexScheduleTimeout | undefined;
  /** The clock the crash window reads, in milliseconds; `Date.now` by default. */
  readonly now?: (() => number) | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly turnStartTimeoutMs?: number | undefined;
  /** Mints `DriverResumeResult.bindingId`; supply the store's minter in the daemon. */
  readonly newBindingId?: (() => string) | undefined;
  /** Answers callback tool calls with session and run identity attached; absent, they refuse. */
  readonly answerCallbackToolCall?: CodexSessionServerRequestResponder | undefined;
  readonly runEngine: CodexRunEnginePort;
  /** The binding a turn the daemon starts itself (a review, a goal, `Allow once`) runs on. */
  readonly daemonTurnBindings: DaemonTurnBindingResolver;
  /**
   * Where every delivery from a Codex conversation goes, in the order its frames arrived: rows,
   * run moves, child runs, markers, live states, asks and session notices.
   */
  readonly inbound: CodexInboundDispatchPort;
  /**
   * The approval pipeline's intake of the permission asks the run engine admitted; until it is
   * registered an ask stays pending at Codex.
   */
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  /** The questions card's intake; until it is registered a question stays pending. */
  readonly questions: PortRegistration<QuestionPort>;
  /** The approval service's intake of the blocks Codex's own reviewer made at Reviewed. */
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  /** The daemon's tool-server client's prompts for the `/` list; absent, the list has none. */
  readonly serverPrompts: PortRegistration<CodexServerPromptPort>;
  /** The running-commands stream's live output; absent, a command's output is dropped. */
  readonly commandOutput: PortRegistration<CommandOutputPublisher>;
  /** The address the daemon's hook programs reach it on; absent, services run no hooks. */
  readonly hookEndpoint: string | undefined;
  /**
   * The daemon's folder for helper role files, absolute: each session's files go in a folder of
   * its own under it, removed when the session is deleted.
   */
  readonly helperRolesFolder: string;
  /**
   * Receives the result of each resume the driver starts itself, after its service came back or
   * moved to a new build, so the daemon records the binding it minted and the conversation it
   * names, or the failure.
   */
  readonly onSessionRelaunched: (sessionId: SessionId, result: DriverResumeResult) => void;
  /**
   * Points a binding at the conversation its session is on after a fork, so a later resume opens
   * that one, and records in the same write each conversation the session left. Rejects when it
   * was not recorded.
   */
  readonly rebindRuntimeBinding: (rebind: RuntimeBindingRebind) => Promise<void>;
  /**
   * Receives the run terminal for a run whose turn the driver lost. Required: no terminal frame
   * can end that run, so without it the run would never end.
   */
  readonly onLostRunFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: CodexLostRunFailure,
  ) => void;
  /** Orders the sessions a recovered service resumes, the one on screen first. */
  readonly orderRecovery?: ((sessionIds: readonly SessionId[]) => SessionId[]) | undefined;
  /**
   * The daemon's prior-emitted cumulative token sums for one thread, used to base a native resume.
   * Optional because the sums live in the event record this module never reads; unbound, a resume
   * bases at zero, re-meters the whole total once, and reports a diagnostic.
   */
  readonly readPriorEmittedUsage?:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  /** Receives each metered per-turn usage delta; the emission pipeline mints the envelope. */
  readonly onMeteredUsage?: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  /**
   * Receives how full the session's own conversation is after each request Codex reports, for the
   * context meter; the emission pipeline mints the envelope. Helpers' readings never arrive here.
   */
  readonly onContextWindowReading?:
    | ((sessionId: SessionId, reading: CodexContextWindowReading) => void)
    | undefined;
}

/**
 * How full a conversation is, from one `thread/tokenUsage/updated`: the tokens in the window are
 * Codex's own count, the last request's total, and the window is the usable one Codex reports,
 * 95 % of the model's full window and following any override, never the catalog's size.
 */
interface CodexContextWindowReading {
  readonly threadId: string;
  /** The turn the report names, or `null` where it names none. */
  readonly turnId: string | null;
  readonly window: WindowTelemetry;
  /** Codex's own split of the last request's tokens; an axis it did not report is absent. */
  readonly breakdown: Readonly<Partial<Record<UsageTokenAxis, number>>>;
}

/** A run whose turn is accepted and whose settled output speed is not yet reported. */
interface CodexUnsettledOutputSpeedRun {
  readonly runId: RunId;
  /** Whether the turn changed the declared tier, so it settles on the notice that change sends. */
  readonly awaitsSettingsNotice: boolean;
}

/**
 * One inbound Codex notification as the thread-frame router sees it; `params` rides along so a
 * held frame still carries its content when its registration lands. `threadId` is the frame's
 * explicit thread member verbatim, `null` only when the frame omits one. A child's registration
 * is dispatched from the announcement's own members before the announcement is routed, so the
 * announcement never waits on its own registration.
 */
export interface CodexRoutableFrame extends RoutableProviderFrame {
  readonly params: unknown;
}

/**
 * The router's bounds. The hold covers one short race (child traffic ahead of its
 * `thread/started`), so its timeout is far below any human-visible latency.
 */
export const CODEX_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});

/**
 * The compaction-wait key: session and thread together, since a fork or superseding resume moves
 * the thread and a session-only key would settle on the replacement's `thread/compacted`.
 * NUL-joined because every bounded string on this leg rejects NUL.
 */
export function codexCompactionWaitKey(sessionId: SessionId, threadId: string): string {
  return `${sessionId}\u0000${threadId}`;
}

/**
 * Reads the thread identity a Codex frame carries, or `null` when unreadable (the router refuses
 * that fail-closed). Never throws: it runs inside the transport's `#ingest` drain.
 */
export function readCodexFrameThreadId(method: string, params: unknown): string | null {
  const payload = isPlainObject(params) ? params : {};
  if (method === CODEX_THREAD_STARTED_METHOD) {
    const thread = isPlainObject(payload["thread"]) ? payload["thread"] : {};
    const threadId = thread["id"];
    return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
  }
  const threadId = payload["threadId"];
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

/**
 * Reads a `thread/started` child announcement, or `null` when the frame names no parent (the
 * session's own thread starting). Never throws, like {@link readCodexFrameThreadId}.
 */
export function readCodexChildThreadAnnouncement(params: unknown): ChildThreadAnnouncement | null {
  const payload = isPlainObject(params) ? params : {};
  const thread = isPlainObject(payload["thread"]) ? payload["thread"] : {};
  const threadId = thread["id"];
  const parentThreadId = thread["parentThreadId"];
  const threadSourceKind = thread["threadSourceKind"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  if (typeof parentThreadId !== "string" || parentThreadId.length === 0) {
    return null;
  }
  return deriveCodexChildThreadAnnouncement({
    threadId,
    parentThreadId,
    threadSourceKind: typeof threadSourceKind === "string" ? threadSourceKind : "",
  });
}

/**
 * Reads a `thread/tokenUsage/updated` frame into a cumulative reading, or `null` without a usable
 * thread identity or breakdown. Partial axes are admitted; the accountant refuses non-finite ones.
 */
export function readCodexCumulativeUsageReading(params: unknown): CumulativeUsageReading | null {
  const payload = isPlainObject(params) ? params : {};
  const threadId = payload["threadId"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  const turnId = payload["turnId"];
  // `tokenUsage` is the wire's member name (`total` cumulative, `last` per-turn); no alias is
  // accepted, so a wire rename cannot become a silent metering stop.
  const tokenUsage = payload["tokenUsage"];
  if (!isPlainObject(tokenUsage)) {
    return null;
  }
  const cumulative = readCodexTokenBreakdown(tokenUsage["total"]);
  if (cumulative === null) {
    return null;
  }
  const declaredPerTurn = readCodexTokenBreakdown(tokenUsage["last"]);
  return {
    threadId,
    namedTurnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null,
    cumulative,
    declaredPerTurn,
  };
}

/**
 * The usable window a `thread/tokenUsage/updated` frame reports (`modelContextWindow`), or `null`
 * where the frame carries none, as the wire allows.
 */
export function readCodexModelContextWindow(params: unknown): number | null {
  const window = isPlainObject(params) ? params["tokenUsage"] : undefined;
  const reported = isPlainObject(window) ? window["modelContextWindow"] : undefined;
  return typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0
    ? reported
    : null;
}

/**
 * Maps one Codex `TokenUsageBreakdown` onto the accountant's axes, or `null` for a non-object.
 * Absent axes stay absent: a fabricated zero would meter a negative delta on the next reading.
 */
function readCodexTokenBreakdown(value: unknown): CumulativeAxisReadings | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const readings: Record<string, number> = {};
  const wireNamesByAxis: Readonly<Record<string, string>> = {
    input: "inputTokens",
    cachedInput: "cachedInputTokens",
    cacheWriteInput: "cacheWriteInputTokens",
    output: "outputTokens",
    reasoningOutput: "reasoningOutputTokens",
    total: "totalTokens",
  };
  for (const [axis, wireName] of Object.entries(wireNamesByAxis)) {
    const reading = value[wireName];
    if (typeof reading === "number") {
      readings[axis] = reading;
    }
  }
  return Object.keys(readings).length === 0 ? null : (readings as CumulativeAxisReadings);
}

/** Whether a `turn/completed` status ends the turn, by the set route retirement also uses. */
export function readCodexTerminalTurnStatus(params: unknown): boolean {
  const payload = isPlainObject(params) ? params : {};
  const turn = isPlainObject(payload["turn"]) ? payload["turn"] : {};
  const status = turn["status"];
  return typeof status === "string" && CODEX_TERMINAL_TURN_STATUSES.has(status);
}

/** The turn a `turn/completed` ends, or `null` when its status is not terminal or it names none. */
export function readCodexTerminalTurnId(params: unknown): string | null {
  if (!readCodexTerminalTurnStatus(params)) {
    return null;
  }
  const payload = isPlainObject(params) ? params : {};
  const turn = isPlainObject(payload["turn"]) ? payload["turn"] : {};
  const turnId = turn["id"];
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}
