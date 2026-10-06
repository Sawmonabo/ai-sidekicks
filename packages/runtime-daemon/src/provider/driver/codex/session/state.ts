/**
 * The per-session state the Codex lifecycle keeps: the session record, the buffer of turn evidence
 * that arrived before its run, the lifecycle options, and the readers for frames it routes.
 */

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { RunOutputSpeedSettledListener } from "../../../declared-output-speed.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import {
  type ChildThreadAnnouncement,
  type RoutableProviderFrame,
  type SubagentLifecycleEmission,
  type ThreadFrameRouterConfig,
} from "../../../thread-frame-router.js";
import {
  type CumulativeAxisReadings,
  type CumulativeUsageReading,
  type MeteredUsageDelta,
} from "../../../usage-delta-accountant.js";
import { type CredentialEnvPolicy } from "../../../spawn-env.js";
import {
  CODEX_THREAD_STARTED_METHOD,
  deriveCodexChildThreadAnnouncement,
} from "../event-normalizer.js";
import {
  type TextNeutralityMechanismGrade,
  type TextNeutralizationRunFailure,
  type TurnEvidenceClass,
  type TurnEvidenceClassification,
} from "../../../outbound-frame.js";
import type { CodexAppServerConnection, CodexConnectionOptions } from "../app-server-connection.js";
import type { CodexSessionConfig } from "./config.js";
import type { CodexModelCatalogExchange } from "../capabilities.js";
import { type CodexSessionSlotState } from "./errors.js";
import type { CodexSessionServerRequestResponder } from "../server-requests.js";
import { isPlainObject } from "../../../record-readers.js";
import type { SubagentPolicy } from "../../contract.js";

/** Terminal `TurnStatus` values; `inProgress` is excluded so a live route is never retired. */
export const CODEX_TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
]);

/** Turn evidence buffered per session (see `startRun`); bounded so it cannot leak. */
const CODEX_BUFFERED_TURN_EVIDENCE_LIMIT = 64;

/**
 * Ceiling for that buffer while a `turn/start` is in flight and nothing may be evicted; past it
 * the session is torn down rather than discard evidence.
 */
const CODEX_BUFFERED_TURN_EVIDENCE_CEILING = CODEX_BUFFERED_TURN_EVIDENCE_LIMIT * 4;

/**
 * Ceiling on interrupted runs whose terminals are still owed (see
 * `CodexSessionRecord.interruptedRunIdByTurnId`); refuses instead of pruning, since an evicted
 * entry loses its terminal.
 */
const CODEX_INTERRUPTED_ROUTE_MEMORY = 64;

/**
 * Settled turn ids remembered while no steer is in flight (see
 * `CodexSessionRecord.settledTurnIds`); eviction is safe only then, since absence means a terminal
 * is still owed.
 */
const CODEX_SETTLED_TURN_MEMORY = 64;

/** Settled-turn memory ceiling while a `turn/steer` is in flight; past it the session refuses. */
const CODEX_SETTLED_TURN_MEMORY_CEILING = CODEX_SETTLED_TURN_MEMORY * 4;

/** Everything the lifecycle keeps for one live Codex session. */
export interface CodexSessionRecord {
  readonly sessionId: SessionId;
  readonly connection: CodexAppServerConnection;
  /**
   * The thread this session is bound to. Only `forkConversation` changes it, in place, because
   * in-flight closures hold this record and check `#sessions` still maps to it.
   */
  threadId: string;
  /**
   * This thread's turn ids, oldest first; `ForkConversationParams.position` N is
   * `turnBoundaries[N - 1]`. Seeded from `thread.turns` on resume and fork, appended at each
   * accepted `turn/start`. Uncapped: evicting the head would re-map every later ordinal.
   */
  readonly turnBoundaries: string[];
  /** The posture re-sent as each turn's `sandboxPolicy` when its `StartRunParams` declare none. */
  readonly executionPosture: ExecutionPosture | undefined;
  /**
   * The person's own workspace network setting, from a thread reply whose realized sandbox is the
   * workspace one; echoed on each workspace turn's `sandboxPolicy`. Replaced in place by
   * `forkConversation`, as `threadId` is.
   */
  providerNetworkAccess: boolean | undefined;
  /**
   * The model a turn runs on when its run names none: the session's at establishment, then each
   * accepted turn's, since a turn's model is a thread setting from that turn on.
   */
  model: string;
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
   * Accepted turns, by turn id, whose run has yet to report the tier it settled at; each entry
   * leaves on its settlement, at the latest on the turn's `turn/completed`.
   */
  readonly unsettledOutputSpeedRuns: Map<string, CodexUnsettledOutputSpeedRun>;
  /** The subagent policy, re-sent on `thread/fork` so the new thread keeps its caps. */
  readonly subagentPolicy: SubagentPolicy | undefined;
  /**
   * The config this process was launched with. A resume reuses its `cwd` and `env` but
   * re-derives `credentialEnvPolicy` from its own posture, inheriting this one only when it
   * states none (see `CodexSpawnPosture.composeResumeSpawnConfig`).
   */
  readonly spawnConfig: CodexSessionConfig;
  /**
   * Every live turn, keyed by turn id, newest last. Turn-keyed because a run can hold several
   * live turns; a run-keyed map would lose the first one's terminal route.
   */
  readonly runIdByActiveTurnId: Map<string, RunId>;
  /**
   * Turn evidence that arrived before any route pointed at its turn; insertion-ordered, capped
   * (`CODEX_BUFFERED_TURN_EVIDENCE_LIMIT`), consumed by `startRun`, which rules the tripwire on the
   * evidence itself (an id alone would report a zero-turn interception as a completed turn).
   */
  readonly bufferedTurnEvidence: Map<string, BufferedTurnEvidence>;
  /**
   * `turn/start` requests awaiting an answer. At zero nothing can claim evidence: only the start
   * handed the turn id claims it, and the provider never reuses a turn id.
   */
  inFlightTurnStarts: number;
  /**
   * Turn ids whose terminal was ingested, newest last, so `steerRun` can ask whether an
   * acknowledged turn has ended. Written for every terminal, never consumed; pruned to
   * `CODEX_SETTLED_TURN_MEMORY` only while `inFlightSteers` is zero.
   */
  readonly settledTurnIds: Set<string>;
  /** `turn/steer` requests awaiting an answer; a count, as each live turn steers on its own. */
  inFlightSteers: number;
  /**
   * Runs whose route an interrupt retired before their turn's terminal arrived, keyed by that
   * turn id: `turn/interrupt` resolves on acceptance, and the tripwire is ruled on the later
   * `turn/completed`. Not a live route. Bounded by refusal at `CODEX_INTERRUPTED_ROUTE_MEMORY`,
   * never eviction; released when the terminal is ruled.
   */
  readonly interruptedRunIdByTurnId: Map<string, RunId>;
}

/**
 * What was observed about a turn before any correlated frame was re-keyed onto it. The
 * tripwire is ruled on both parts: a `notLoaded` terminal alone cannot restate the observations.
 */
interface BufferedTurnEvidence {
  readonly observations: Set<TurnEvidenceClass>;
  /** The settling classification, once this turn's terminal has arrived. */
  terminal: TurnEvidenceClassification | undefined;
}

/**
 * How a session's thread bases its usage registers. The resume arm names the thread whose
 * prior-emitted sum it bases on, which after a rewind is not the new forked thread.
 */
export type CodexUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

/**
 * Gets or creates a turn's entry in the bounded evidence buffer, or returns `null` when it can
 * neither evict nor grow, which is session-fatal. While a `turn/start` is in flight nothing is
 * evicted (one synchronous drain can outrun the waiting `startRun` continuation, and dropping
 * its terminal would report a swallowed opening as a completed turn) and the memory may grow to
 * `CODEX_BUFFERED_TURN_EVIDENCE_CEILING`. With none in flight, oldest-first eviction is free.
 */
export function bufferTurnEvidence(
  record: CodexSessionRecord,
  turnId: string,
): BufferedTurnEvidence | null {
  const memory = record.bufferedTurnEvidence;
  const existing = memory.get(turnId);
  if (
    existing === undefined &&
    record.inFlightTurnStarts > 0 &&
    memory.size >= CODEX_BUFFERED_TURN_EVIDENCE_CEILING
  ) {
    // Only a turn not already held is refused; dropping a held one would make the refusal the loss.
    return null;
  }
  const buffered = existing ?? { observations: new Set(), terminal: undefined };
  memory.delete(turnId);
  memory.set(turnId, buffered);
  if (record.inFlightTurnStarts === 0) {
    while (memory.size > CODEX_BUFFERED_TURN_EVIDENCE_LIMIT) {
      const oldest = memory.keys().next();
      if (oldest.done === true) {
        break;
      }
      memory.delete(oldest.value);
    }
  }
  return buffered;
}

/**
 * Records that a turn's terminal was ingested; false (session-fatal) means the memory is full.
 * `turn/steer` reads absence as "still live", so with a steer in flight nothing is evicted and
 * the memory refuses at `CODEX_SETTLED_TURN_MEMORY_CEILING`; otherwise oldest-first pruning.
 */
export function rememberSettledTurn(record: CodexSessionRecord, turnId: string): boolean {
  const memory = record.settledTurnIds;
  if (
    !memory.has(turnId) &&
    record.inFlightSteers > 0 &&
    memory.size >= CODEX_SETTLED_TURN_MEMORY_CEILING
  ) {
    return false;
  }
  memory.delete(turnId);
  memory.add(turnId);
  if (record.inFlightSteers === 0) {
    while (memory.size > CODEX_SETTLED_TURN_MEMORY) {
      const oldest = memory.values().next();
      if (oldest.done === true) {
        break;
      }
      memory.delete(oldest.value);
    }
  }
  return true;
}

/**
 * Retains an interrupted run's turn correlation for its coming terminal; false (session-fatal)
 * at the ceiling. Never evicts: every entry is still owed its terminal, and an evicted one
 * would leave that terminal ruled against no run.
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
 * Resolves the credential policy for the posture a spawn states, per spawn and never cached.
 * `undefined` for a posture that carries a reference is a wiring fault: the spawn refuses.
 */
export type CodexCredentialEnvPolicyResolver = (
  posture: ExecutionPosture,
) => Promise<CredentialEnvPolicy | undefined>;

/** Construction inputs for the lifecycle manager. */
export interface CodexLifecycleOptions extends CodexConnectionOptions {
  /**
   * Spawn context for a cold resume and the auth probe; required, since a bare environment hides
   * the credential home and fails like a bad handle. Parse untyped input with
   * `parseCodexSessionConfig`. `thread/resume` restores the thread's own cwd, so `cwd` here is the
   * process's directory.
   */
  readonly resumeSpawnConfig: CodexSessionConfig;
  /**
   * Answers a spawn's credential policy from its posture. Required: a manager-wide fallback
   * cannot represent a per-session policy and would relaunch a tightened posture unreported.
   */
  readonly resolveCredentialEnvPolicy: CodexCredentialEnvPolicyResolver;
  /**
   * The live `model/list` read: `listModels()` answers from it, and a carried output-speed level is
   * resolved against the tier list it publishes for the model, standard where the list lacks it.
   */
  readonly modelCatalogExchange: CodexModelCatalogExchange;
  /** Mints `DriverResumeResult.bindingId`; supply the store's minter in the daemon. */
  readonly newBindingId?: (() => string) | undefined;
  /**
   * Answers routed server requests with session and run identity attached. The manager wraps it
   * per connection and overrides the transport-level `serverRequestResponder` with the wrapper.
   */
  readonly answerServerRequest?: CodexSessionServerRequestResponder | undefined;
  /**
   * This leg's declared text-neutrality parity grade, default `emulated`. Injected rather than
   * derived from the driver's name; the default stays `emulated` although the transport was
   * probed at the pin and does no client-side command parsing.
   */
  readonly textNeutralityMechanismGrade?: TextNeutralityMechanismGrade | undefined;
  /** Correlation minting for outbound text frames. Injectable for tests. */
  readonly mintOutboundFrameCorrelationId?: (() => string) | undefined;
  /**
   * Receives the run terminal a tripwire trip produces (producer-only). Required: a trip raises no
   * JSON-RPC error, so this is the only user-visible surface.
   */
  readonly onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  /**
   * The daemon-wide diagnostic band for policy facts such as `subagent_definition_disabled`;
   * required, and separate from `reportDiagnostic`, the transport channel.
   */
  readonly diagnostics: DriverDiagnosticsEmitter;
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
   * Receives the `subagent.started` / `subagent.completed` pair per provider-attributed child
   * thread; the child's only transcript presence.
   */
  readonly onSubagentLifecycle?:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  /**
   * Receives each run's settled declared tier: the thread's tier from the settings notice its
   * `turn/start` produced, or, where the turn left the tier alone, at the turn's first item.
   */
  readonly onRunOutputSpeedSettled?: RunOutputSpeedSettledListener | undefined;
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
