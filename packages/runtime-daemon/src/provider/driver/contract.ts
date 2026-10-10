// The normalized surface every provider driver implements, so the session engine never sees
// provider-native types. Only the daemon reads these shapes; the ones a client or
// another contract also reads (run ids, capability flags, interventions, execution posture, models
// and modes) are in `@ai-sidekicks/contracts`.
//
// Trust boundaries decide which shapes are Zod schemas and which are plain TypeScript:
//   - The `ProviderDriver` params are built by the daemon in-process, so they are plain types.
//   - The capability and handle returns are built by the driver, which normalizes provider output
//     at its own boundary; this layer does not re-parse them. The persisted `resumeHandle` is
//     bounded where it is written.
//   - Schemas guard what parses untrusted provider output: the result envelopes and the
//     driver-normalized seam shapes (callback-tool invocation, MCP server status). Both are
//     `.strict()`: an unknown key is a protocol or driver bug.
//
// The contract carries no remote-authority handle or control-plane dispatch shape, so a driver may
// call a remote provider API behind these methods while execution authority stays with the local
// runtime.

import {
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type ExecutionPosture,
  type ProviderMode,
  type ProviderModel,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { type McpServerStatus } from "@ai-sidekicks/contracts/mcp/server";
import {
  type ApplyInterventionParams,
  type DriverInterventionResult,
  type InterruptRunParams,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import {
  type ProviderToolMetadata,
  type SessionCallbackTool,
} from "@ai-sidekicks/contracts/provider/driver/tools";
import {
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_FALLBACK_ACTION_MAX_LEN,
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
} from "@ai-sidekicks/contracts/provider/driver/length-limits";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import {
  RecoveryConditionSchema,
  type RecoveryCondition,
} from "@ai-sidekicks/contracts/provider/driver/recovery";
import { wireFreeFormString } from "@ai-sidekicks/contracts/free-form-string";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import { z } from "zod";

import type { RewindConversationParams, RewindConversationResult } from "./rewind.js";
import type {
  AnswerProviderChoiceParams,
  AnswerProviderChoiceResult,
  FasterModelRetryOutcome,
  FasterModelRetryParams,
  OverrideDenialParams,
  PauseRunParams,
  ResumeRunParams,
  WithdrawQueuedMessageParams,
  WithdrawQueuedMessageResult,
} from "./run-control.js";
import type {
  AnswerSessionCommandParams,
  AskSideQuestionParams,
  ProviderBuildChange,
  ProviderCommandsListener,
  PurgeSessionParams,
  StartReviewParams,
  SessionCommandAnswer,
  SubscribeProviderCommandsParams,
  UpdatePermissionLevelParams,
  UpdateSessionModeParams,
} from "./session-control.js";

// ---- ProviderDriver ----

/**
 * The normalized operations every provider driver implements for the daemon. The daemon-injected
 * callbacks (`onCallbackToolCall`, `onMcpServerStatus`) are `CreateSessionParams` members, not
 * operations.
 */
export interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  // Gated on `session_fork`: an undeclared flag refuses with `driver.capability_unsupported`
  // before dispatch. `degraded` is the outcome of a driver that was invoked and reported its
  // fallback.
  moveSessionToFork(params: MoveSessionToForkParams): Promise<MoveSessionToForkResult>;
  // Gated on `rollback`, refused before dispatch like `moveSessionToFork`. Cuts the bound
  // conversation in place and never touches files; a running turn is stopped first.
  rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  // Not gated. `Allow once` on a block the provider's own reviewer made at Reviewed, carried by
  // the provider's own means: it reaches a running turn at once and starts a turn when none runs,
  // and retries nothing itself. Called only for a block the driver reported as one a person may
  // overrule.
  overrideDenial(params: OverrideDenialParams): Promise<void>;
  // Not gated, on the lead run or a provider subagent's child run. The pause stops the run after
  // the step in flight by the provider's own hooks, or a boundary interrupt where it has none; the
  // continue goes on from where it stopped with nothing repeated, delivering the waiting messages.
  // Each resolves once the provider has the request. The run engine writes `pausing` and
  // `running` itself; the driver delivers `paused` as a `run_lifecycle` delivery only once its hold
  // has taken effect, and never `running`. A resume before the pause took effect drops the pause,
  // and no `paused` follows.
  pauseRun(params: PauseRunParams): Promise<void>;
  resumeRun(params: ResumeRunParams): Promise<void>;
  // Gated on `steer`. Takes back a steer the provider has not read yet; edit is withdraw and send
  // again.
  withdrawQueuedMessage(params: WithdrawQueuedMessageParams): Promise<WithdrawQueuedMessageResult>;
  // Not gated. Answers a choice the provider holds the run on; a provider that never asks one
  // answers `not_pending`.
  answerProviderChoice(params: AnswerProviderChoiceParams): Promise<AnswerProviderChoiceResult>;
  // Not gated. Stops the held turn and sends its message again on the named model, adding no row;
  // a provider that never holds a turn for a safety check answers `rejected`.
  retryTurnOnFasterModel(params: FasterModelRetryParams): Promise<FasterModelRetryOutcome>;
  // Not gated and required of every driver: moves the live session to another permission level
  // from its next request, never by relaunch.
  updatePermissionLevel(params: UpdatePermissionLevelParams): Promise<void>;
  // Gated on `resume`. Starts a session whose provider process ended and stayed down, and resumes
  // it as `resumeSession` does; where one process serves several sessions, it restarts that
  // process and resumes every conversation it held.
  restartSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  // Not gated and required of every driver: moves every live session onto the provider build that
  // replaced the running one, each when its running reply ends or at once while idle.
  moveToProviderBuild(change: ProviderBuildChange): Promise<void>;
  // Not gated and required of every driver: deletes the provider's own copy of each conversation
  // the session opened, from every account home it ran in. A conversation that fails to delete
  // throws after the rest were tried.
  purgeSession(params: PurgeSessionParams): Promise<void>;
  // Both goal operations are gated on `session_goals`, like `moveSessionToFork`. A provider that
  // did not take the goal answers `degraded` rather than throwing an opaque failure.
  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult>;
  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
  // Not capability-gated and required of every driver: a zero-turn authentication probe. No flag
  // exists for it, so a driver cannot opt out by silence.
  probeAuth(): Promise<DriverAuthProbeResult>;
  // Gated on `context_compaction`. Compacts the bound session's provider-side context on user
  // request only, settling on the provider's typed compaction evidence and never on the request
  // being accepted (a provider may answer with an empty acknowledgement or not at all).
  // There is no prompt-injected emulation: a driver that cannot compact declares the flag `false`.
  // The wait ends at the driver's declared per-binding bound or when the binding stops being
  // live; a compaction frame that arrives after settlement still normalizes as an unsolicited one.
  compactContext(params: CompactContextParams): Promise<DriverCompactionResult>;
  // Gated on `provider_commands`. A live read of the provider's own slash-command and skill
  // enumeration for the bound session, held as driver-session state and discarded with it (not
  // persisted or cached). Every entry carries the `(driverName, providerAccountId)` it was read
  // under; the daemon enforces the routing invariant on that pair.
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandListResult>;
  // The output-speed state the provider last declared for the session's live binding, verbatim,
  // for a driver declaring `output_speed`; `undefined` with no live binding or no declaration yet,
  // which means unread, never off. A synchronous read of state the driver already holds, never a
  // request, and never the requested level, which may differ.
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined;
  // Moves the session between Build and Plan from its next turn.
  updateSessionMode(params: UpdateSessionModeParams): Promise<void>;
  /**
   * Not gated and required of every driver: answers, before any run is made, a command whose
   * provider command would change more than this session, applying it to the session alone; a
   * driver with no such command answers `{answered: false}` for every text.
   *
   * @consumedBy the composer's send path
   */
  answerSessionCommand(params: AnswerSessionCommandParams): Promise<SessionCommandAnswer>;
  // Asks a side question on a throwaway copy of the conversation; resolves once it is asked.
  askSideQuestion(params: AskSideQuestionParams): Promise<void>;
  // Starts the provider's own review; resolves once it has started.
  startReview(params: StartReviewParams): Promise<void>;
  // Follows the session's live command list: the listener gets the current list and each change
  // until the returned function is called. Gated on `provider_commands`.
  subscribeProviderCommands(
    params: SubscribeProviderCommandsParams,
    listener: ProviderCommandsListener,
  ): () => void;
  // Stops every provider process and service this driver started, as a deliberate stop; the
  // daemon calls it once while it stops. Never stops a service the person runs themselves.
  shutdown(): Promise<void>;
}

/**
 * The `fallbackAction` of a steer a driver does not deliver natively: the daemon queues the steer
 * text and interrupts the running turn.
 */
export const STEER_FALLBACK_ACTION = "queue_and_interrupt";

/**
 * The refusal code of a session created on a larger window its model's catalog does not offer at
 * that figure now: the request was made against a catalog that has since changed.
 */
export const LARGER_WINDOW_UNAVAILABLE_CODE = "driver.larger_window_unavailable";

/** A provider's model-list reply that could not be read as a catalog (a provider fault). */
export class ModelCatalogUnreadableError extends Error {
  /** `replyName` names the provider and its request, such as `Codex model/list`. */
  constructor(replyName: string, detail: string) {
    super(`${replyName} reply is not a readable model catalog: ${detail}`);
    this.name = "ModelCatalogUnreadableError";
  }
}

// ---- Method parameters and returns ----

/** What the daemon hands a driver to open a session: config, spawn-bound legs and callbacks. */
export interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
  // The session's model. A provider that takes it at process start applies `switch_default` on its
  // usage-credits prompt to this session alone, never to the account's saved default; a provider
  // that takes the model per turn reads it there.
  model: string;
  // The larger window the session chose for its model, in tokens, as recorded when it was picked;
  // `undefined` runs the model's default window. A provider whose model id names the window refuses
  // a defined figure.
  largerWindow: number | undefined;
  // The legs below are spawn-bound: a leg that binds at process spawn and receives nothing here
  // launches without it. Per-run carriers are `StartRunParams`; `ResumeSessionParams` repeats
  // these because resume is a fresh spawn.
  executionPosture?: ExecutionPosture | undefined;
  // The agent's accepted output-speed level, gated on `output_speed`. The driver sends it on its
  // own carrier when the process starts and never refuses it: a level the session's model does
  // not list (`ProviderModel.outputSpeedLevels`, else the driver's static `outputSpeedLevels`)
  // runs at standard, and only the person's request is validated, above the driver. Requested is
  // not granted: the provider's declared state is observed as binding-held
  // `ProviderOutputSpeedState`, and neither value is rewritten into the other.
  outputSpeed?: string | undefined;
  // Gated on `callback_tools`. A driver may host the registry as a daemon-hosted ephemeral MCP
  // server, where the tools surface under that server's name.
  callbackTools?: SessionCallbackTool[] | undefined;
  // Gated on the `subagents` flag.
  subagentPolicy?: SubagentPolicy | undefined;
  // Gated on `mcp`. Every tool server the session can reach, each switched on or off by the
  // person; the driver hands the provider each one as an entry on the daemon's route.
  toolServers?: readonly SessionToolServer[] | undefined;
  // Gated on `structured_output`. A normalized JSON Schema constraining the final output, for a
  // provider that binds it per session; one that binds it per turn reads
  // `StartRunParams.outputSchema`.
  outputSchema?: Record<string, unknown> | undefined;
  // The provider account this leg is admitted against; omitted, the leg spawns against the node's
  // default for that provider. Opaque to the driver, which receives an already-constructed spawn
  // environment: pinning the account's credential home into it and denying ambient credential
  // names are obligations of the spawn path, not something this member carries or a driver does.
  //
  // Server-resolved and server-stamped: a client-supplied value is an input to resolution, never
  // the recorded outcome. Spawn-bound because a run's paying account is fixed for its lifetime;
  // resume re-realizes it from the durable record instead of re-resolving the current default.
  providerAccountId?: string | undefined;
  // Daemon-injected dispatcher, gated on `callback_tools`. The driver calls it for each provider
  // callback-tool request and answers the provider with the result, so no invocation goes
  // unanswered. The daemon's host routes every call through the Cedar approval pipeline.
  onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  // Daemon-injected MCP server-status sink, pre-bound to this leg's identity (session id and the
  // store-minted binding id) at spawn, so a driver cannot misattribute or spoof another leg's rows
  // and needs no id it lacks for the init census it emits during `createSession`.
  onMcpServerStatus?: McpServerStatusProducer | undefined;
}

/**
 * What the daemon hands a driver to resume a session in a fresh process; it repeats the
 * spawn-bound legs of `CreateSessionParams`.
 */
export interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
  // The session's current model, supplied by the caller rather than read from `spawn_config`: a
  // model switch after the spawn moves the session, so the spawn-time value would be stale.
  model: string;
  // The session's recorded larger window, sent as recorded whatever the catalog offers now; refused
  // as on create by a provider whose model id names the window.
  largerWindow: number | undefined;
  // Build or Plan, which the resumed provider runs in from its first turn.
  mode: SessionMode;
  // Resume is a fresh process spawn, so every spawn-bound member of `CreateSessionParams` must be
  // re-realized here or the resumed leg silently sheds it: a posture-less resume relaunches
  // unsandboxed, a schema-less one unconstrained. The data legs are rebuilt by the daemon from the
  // durable `runtime_bindings.spawn_config` written at every spawn, never from the original client
  // request; the two function legs are re-injected at every spawn, as functions are never stored.
  executionPosture?: ExecutionPosture | undefined;
  // A speed-less resume relaunches at the provider's default while `agents.output_speed` still
  // records the person's accepted mode. The state the relaunched process declares is observed as
  // binding-held state, not returned on `DriverResumeResult` (see `ProviderOutputSpeedState`).
  outputSpeed?: string | undefined;
  callbackTools?: SessionCallbackTool[] | undefined;
  subagentPolicy?: SubagentPolicy | undefined;
  toolServers?: readonly SessionToolServer[] | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  // Read back from the durable `spawn_config` record, never re-resolved: resolving "whichever
  // account is default now" would move a live run's spend onto an account it was not admitted
  // against. Same opacity rule as on `CreateSessionParams`.
  providerAccountId?: string | undefined;
  // An omitted rebind would strand provider callback-tool requests unanswered on
  // the resumed leg.
  onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  // Re-injected census sink, pre-bound to the resumed leg's identity; the leg re-emits its init
  // census through it.
  onMcpServerStatus?: McpServerStatusProducer | undefined;
}

/** What the daemon hands a driver to start one run: its id, agent config, and per-run options. */
export interface StartRunParams {
  runId: RunId;
  agentConfig: Record<string, unknown>;
  // Optionals are `?: T | undefined`, not bare `?: T`, under `exactOptionalPropertyTypes`: the
  // package idiom, which keeps an interface aligned with a schema's inferred type.
  conversationHistory?: unknown[] | undefined;
  // The agent's accepted output-speed level, sent on each run as `executionPosture` is, and
  // resolved like `CreateSessionParams.outputSpeed`. A provider that applies the mode between
  // turns sends it before this run's turn only when it differs from the one the process last
  // applied; a provider that takes it per turn sends it as this turn's setting. Absent, the process
  // stays on the level it holds.
  outputSpeed?: string | undefined;
  // A level for this run's turn alone, resolved like `outputSpeed`, which the agent's level does not
  // follow: the next run carries the agent's own level again.
  outputSpeedForTurn?: string | undefined;
  // The per-run effective posture, the same object the daemon stamps on `run.running`. A provider
  // that takes posture per turn realizes it there; a provider that binds posture at spawn
  // realizes it at session boundaries, and a mid-session change there resolves by session
  // relaunch, never a silent partial application.
  executionPosture?: ExecutionPosture | undefined;
  // Per-turn schema-constrained final output; a provider that binds it at spawn reads
  // `CreateSessionParams.outputSchema` instead. Gated on `structured_output`.
  outputSchema?: Record<string, unknown> | undefined;
}

/** Answers one interactive request a driver raised on a run; `response` is provider-shaped. */
export interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

/** Asks a driver to close one session. */
export interface CloseSessionParams {
  sessionId: SessionId;
}

/**
 * Driver-constructed return of `createSession` and `resumeSession`; both fields are opaque
 * provider-owned blobs. `resumeHandle` is bounded (non-empty, length, NUL-reject) where it is
 * persisted to `runtime_bindings.resume_handle`, not re-parsed here.
 */
export interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
}

// ---- Length caps ----

// Caps on provider output only the daemon parses, applied through `wireFreeFormString`, which
// rejects empty, whitespace-only, NUL and over-max values and never truncates. The caps another
// contract also reads are in `@ai-sidekicks/contracts`.

/**
 * Max length of `DriverAuthProbeResult.detail`, a short account or plan descriptor; a rejection
 * loses only descriptive text, never the probe `status` that carries the admission decision.
 */
const DRIVER_AUTH_DETAIL_MAX_LEN = 512;
/** Max length of `CallbackToolInvocation.toolCallId`, an opaque provider correlation id. */
export const DRIVER_TOOL_CALL_ID_MAX_LEN = 256;

/** The fixed sentence every `driver.capability_unsupported` refusal carries. */
export const DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE =
  "Requested capability is not supported by the driver";

// ---- Capabilities ----

/**
 * The provider CLI version as the spawned process reports it in-band, never from a launcher
 * symlink that may name a different build. `rawVersion` is the printed version, always;
 * `parsedVersion` is its canonical parse, present only when it parses. Every version runs, parsed
 * or not; nothing refuses on it.
 */
export interface DriverCliVersionReport {
  rawVersion: string;
  parsedVersion?: string | undefined;
}

/** Rebuilds a stored report from its two columns; a NULL parse is a version that did not parse. */
export function readCliVersionColumns(
  rawVersion: string,
  parsedVersion: string | null,
): DriverCliVersionReport {
  return parsedVersion === null ? { rawVersion } : { rawVersion, parsedVersion };
}

/**
 * Return of `ProviderDriver.getCapabilities()`: the flag matrix, the tool declarations as the
 * provider made them (normalized at the daemon's hydration seam) and the CLI version.
 */
export interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  // Required: every capability report carries the printed provider version.
  // It describes this reading rather than a capability, so it rides this wrapper and is not part
  // of the stored capability snapshot.
  cliVersion: DriverCliVersionReport;
  // Present and total over the flag set on a live driver read; absent when the result was rebuilt
  // by `DriverCapabilitiesWriter.hydrate()` from the durable cache, which stores flag values and
  // not provenance. Absence means "cache reconstruction", never "unknown provenance": a consumer
  // that needs provenance re-reads the driver. Not part of the stored snapshot or the
  // client-facing `driver.listCapabilities` payload.
  detectionSource?: Record<DriverCapabilityFlag, CapabilityDetectionSource>;
  // The output-speed value vocabulary for a driver whose provider publishes no per-model set:
  // present iff `capabilities.flags.output_speed` is `true` and the driver declares a static set.
  // Declared from the per-driver table because that provider reports the mode's state but lists no
  // modes; a provider that lists them per model publishes them on `ProviderModel.outputSpeedLevels`
  // instead. Absent or empty, with no per-model set, the axis is unsettable and a person's request
  // for a level refuses. Unlike `detectionSource` it survives `hydrate()`, so the durable cache
  // needs no column for it.
  outputSpeedLevels?: string[] | undefined;
}

/**
 * How one flag's value was arrived at on a reading: `probed` by a zero-turn probe whose negative
 * control still refused, or `static` from the driver's own table, used only where no admissible
 * probe exists. A bare union because nothing iterates it at runtime; per-driver totality is a
 * compile-time `Record` in `capability/probe.ts`.
 */
export type CapabilityDetectionSource = "static" | "probed";

// ---- Resume ----

/**
 * Return of `ProviderDriver.resumeSession()`, parsed from untrusted provider output. Discriminated
 * on `status` so a failed resume cannot pose as a successful one: `failed` carries a
 * `RecoveryCondition` and `providerFailureDetail` and has no `bindingId`, and a failed resume must
 * never silently create a replacement provider session under the same run. The `resumed` arm's
 * required `sessionPosition` is the driver's normalized monotonic position (a turn or event
 * ordinal, as in `MoveSessionToForkResult`); the daemon compares it with its recorded position,
 * which catches a provider answering a resume with a fresh session (as on a working-directory
 * mismatch). Its `resumeHandle` names the conversation the session runs on now, for the daemon to
 * record on the binding: the handle it was given, or a new one where the provider continued the
 * conversation in a new thread, as Codex does by forking it. Timestamps live on
 * `runtime_bindings.updated_at`.
 */
export type DriverResumeResult =
  | {
      status: "resumed";
      bindingId: string;
      sessionPosition: number;
      resumeHandle: string;
    }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      providerFailureDetail: string;
    };
/** Validates a {@link DriverResumeResult}; both arms are `.strict()`. */
export const DriverResumeResultSchema: z.ZodType<DriverResumeResult, DriverResumeResult> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resumed"),
        // Opaque and machine-generated, but persisted into `runtime_bindings`, so the
        // `wireFreeFormString` guards (non-blank, no NUL) defend a stored untrusted value against
        // storage and log-injection hazards. The cap is sized for a short session-binding handle.
        bindingId: wireFreeFormString(DRIVER_BINDING_ID_MAX_LEN, "DriverResumeResult.bindingId"),
        // Shape only (integer >= 0), as in `MoveSessionToForkResultSchema`. Comparing the position
        // with the daemon's recorded one, and reconciling a mismatch, need session state this shape
        // does not carry, so they belong to the daemon.
        sessionPosition: z.number().int().min(0),
        // Bounded where it is persisted, as the create's handle is.
        resumeHandle: z.string().min(1),
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        // References the shared parser so a new condition reaches this carrier by construction.
        recoveryCondition: RecoveryConditionSchema,
        // The cap is generous so a verbose detail (wrapped upstream stack trace or nested-cause
        // chain) is not suppressed. A value past it is pathological; a driver treats a result that
        // fails this schema as a provider failure and surfaces `recovery-needed`, so the signal
        // survives a parse rejection here.
        providerFailureDetail: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "DriverResumeResult.providerFailureDetail",
        ),
      })
      .strict(),
  ]);

/**
 * Fits failure text to `providerFailureDetail`'s rules (1..MAX characters, one non-whitespace
 * character, no NUL): NULs are dropped and the text trimmed before it is truncated, and text left
 * empty becomes the driver's `emptyFallback`.
 */
export function boundFailureDetail(detail: string, emptyFallback: string): string {
  const trimmed = detail.replaceAll("\0", "").trim();
  if (trimmed.length === 0) {
    return emptyFallback;
  }
  return trimmed.length > DRIVER_FAILURE_DETAIL_MAX_LEN
    ? trimmed.slice(0, DRIVER_FAILURE_DETAIL_MAX_LEN)
    : trimmed;
}

// ---- Moving a session onto a fork ----

/**
 * Params of `moveSessionToFork` (gated on `session_fork`): fork the provider conversation at a
 * recorded `position` (the driver's normalized monotonic session position, a turn or event
 * ordinal) and move the session onto the fork; touches no files. `bindingId` is the leg key: a
 * run has many bindings (a capped or posture relaunch mints a new one), so `sessionId` cannot name
 * the target leg. The daemon resolves the run's live binding at dispatch; clients address the run,
 * not the leg.
 */
export interface MoveSessionToForkParams {
  sessionId: SessionId;
  position: number;
  bindingId: string;
}

/**
 * Return of `ProviderDriver.moveSessionToFork()`, parsed from untrusted provider output.
 * Discriminated on `status` like `DriverResumeResult`: `sessionPosition` is required on `applied`
 * and absent from `degraded`, so a fork without a confirmed position is unrepresentable. The schema
 * bounds shape only (integer >= 0); domain checks need session state and belong to the daemon.
 * An applied fork has already rewritten the session's own binding to the new conversation.
 */
export type MoveSessionToForkResult =
  | { status: "applied"; sessionPosition: number }
  | { status: "degraded"; fallbackAction?: string | undefined };
/** Validates a {@link MoveSessionToForkResult}; both arms are `.strict()`. */
export const MoveSessionToForkResultSchema: z.ZodType<
  MoveSessionToForkResult,
  MoveSessionToForkResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      sessionPosition: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("degraded"),
      fallbackAction: wireFreeFormString(
        DRIVER_FALLBACK_ACTION_MAX_LEN,
        "MoveSessionToForkResult.fallbackAction",
      ).optional(),
    })
    .strict(),
]);

// ---- Session goals ----

/**
 * What a goal operation did: `applied` when the provider took it, `degraded` when it did not, with
 * the fallback the driver took instead. A success carries no fallback.
 */
export type DriverGoalResult =
  | { status: "applied" }
  | { status: "degraded"; fallbackAction?: string | undefined };

/**
 * Params of `setSessionGoal` (gated on `session_goals`). `goalText` is the condition the person
 * typed after `/goal`, sent to the agent the command targets. Durable truth is the
 * `session.goal_updated` and `session.goal_cleared` events, so driver-held state is never the
 * recovery source and neither operation returns the goal it applied. A resume never sets the goal
 * again, because both providers keep a conversation's goal across one. `bindingId` is the leg key,
 * as on `MoveSessionToForkParams`: the goal goes to the target agent's live binding. `runId` rides
 * along for context and telemetry.
 */
export interface SetSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
  goalText: string;
}

/** Params of `clearSessionGoal` (gated on `session_goals`); addresses one live binding. */
export interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
}

// ---- Authentication probe ----

/**
 * Return of the zero-turn `probeAuth` (not capability-gated), parsed from untrusted provider
 * output. `indeterminate` (probe surface unavailable or unparseable) counts as not authenticated
 * for admission (fail closed) yet stays distinguishable from `unauthenticated`, so the person can
 * tell probe health from credential state; a boolean would lose that. Run admission against a
 * driver not probing `authenticated` refuses as `driver.not_authenticated` before any turn is
 * spent. Mid-run credential expiry is a different surface: typed auth-failure signals map to the
 * `reauth-required` recovery condition.
 */
export interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  // Knowingly PII-bearing: a provider-reported account or plan descriptor whose observed shape is
  // a plan name plus an account email. Transient diagnostics for the person only: never persist it
  // or carry it on an event without a PII classification and the erasure that obliges. Admission
  // reads `status` for the decision and this field only to tell the person why, so dropping it
  // loses diagnostics, never correctness.
  detail?: string | undefined;
}
/** Validates a {@link DriverAuthProbeResult}; strict. */
const DriverAuthProbeResultSchema: z.ZodType<DriverAuthProbeResult, DriverAuthProbeResult> = z
  .object({
    status: z.enum(["authenticated", "unauthenticated", "indeterminate"]),
    detail: wireFreeFormString(
      DRIVER_AUTH_DETAIL_MAX_LEN,
      "DriverAuthProbeResult.detail",
    ).optional(),
  })
  .strict();

/**
 * Builds a probe result without throwing. `detail` is bounded to the auth cap and dropped if the
 * envelope still refuses it, since `status` carries the decision.
 */
export function buildAuthProbeResult(
  status: DriverAuthProbeResult["status"],
  detail: string,
): DriverAuthProbeResult {
  const bounded =
    detail.length > DRIVER_AUTH_DETAIL_MAX_LEN
      ? detail.slice(0, DRIVER_AUTH_DETAIL_MAX_LEN)
      : detail;
  const parsed = DriverAuthProbeResultSchema.safeParse({ status, detail: bounded });
  return parsed.success ? parsed.data : DriverAuthProbeResultSchema.parse({ status });
}

// ---- Compaction and provider-command params ----

// These params are daemon-constructed and binding-addressed: a run has many bindings and each
// operation acts on exactly one leg. The client-facing verbs take a run (compaction) or an agent
// (enumeration), and the SDK seam resolves the binding at dispatch.

/** Params of `compactContext` (gated on `context_compaction`); addresses one binding. */
export interface CompactContextParams {
  sessionId: SessionId;
  bindingId: string;
}

/** Params of `listProviderCommands` (gated on `provider_commands`); addresses one binding. */
export interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
}

// ---- Callback tools ----

/**
 * The invocation a driver hands to the injected dispatcher, built from untrusted provider wire
 * output. This parse is the last point before the value reaches daemon-owned code and guarantees
 * only that strings are bounded and ids well-formed. The dispatcher host does the checks that need
 * the session's registry: an unknown `toolName` answers `failed` without dispatch, and `arguments`
 * are validated against the registered `inputSchema` before any Cedar round-trip, so malformed
 * provider output never reaches the approval pipeline. `toolCallId` is copied verbatim onto the
 * answered result because tool-event pairing is an exact-string match.
 */
export interface CallbackToolInvocation {
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId: string;
  sessionId: SessionId;
  runId: RunId;
}
/** Validates a {@link CallbackToolInvocation}; strict. */
export const CallbackToolInvocationSchema: z.ZodType<
  CallbackToolInvocation,
  CallbackToolInvocation
> = z
  .object({
    toolName: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "CallbackToolInvocation.toolName"),
    arguments: z.record(z.string(), z.unknown()),
    toolCallId: wireFreeFormString(
      DRIVER_TOOL_CALL_ID_MAX_LEN,
      "CallbackToolInvocation.toolCallId",
    ),
    sessionId: SessionIdSchema,
    // References the shared `RunIdSchema` rather than building a second run-id validator.
    runId: RunIdSchema,
  })
  .strict();

/**
 * The answer the daemon returns to the driver, which relays it to the provider. Daemon-constructed
 * and trusted, so plain TypeScript: trust runs the reverse way from the invocation. Only
 * `completed` may carry `output` and only the failure arms may carry `error`, so "denied with
 * output" and "completed with an error" are unrepresentable. The `?: never` members are
 * structurally absent, so they take no `| undefined` (as in `ExecutionPosture`).
 */
export type CallbackToolResult =
  | { status: "completed"; output?: unknown; error?: never }
  | { status: "denied"; output?: never; error?: string | undefined }
  | { status: "failed"; output?: never; error?: string | undefined };

// ---- MCP server status ----

/**
 * What a driver emits for one MCP server: `serverName` and `status`, nothing else. The driver never
 * supplies leg identity, since the daemon pre-binds the injected producer to the leg at spawn, so a
 * driver cannot misattribute or spoof another leg's rows. `serverName` is untrusted provider or CLI
 * output, so the shape is Zod-parsed at the driver normalization seam.
 */
export interface McpServerStatusEmission {
  serverName: string;
  status: McpServerStatus;
}
/** Validates a {@link McpServerStatusEmission}; strict. */
export const McpServerStatusEmissionSchema: z.ZodType<
  McpServerStatusEmission,
  McpServerStatusEmission
> = z
  .object({
    serverName: wireFreeFormString(
      DRIVER_MCP_SERVER_NAME_MAX_LEN,
      "McpServerStatusEmission.serverName",
    ),
    status: z.enum(["unknown", "starting", "connected", "needs-auth", "failed"]),
  })
  .strict();

/**
 * What the consumer reads: the pre-bound producer stamps the leg identity onto every emission.
 * `bindingId` is daemon-stamped, never driver-supplied. Because a run has many bindings, statuses
 * key per `(binding, server)`, so a relaunched leg's fresh census supersedes its own predecessor
 * without clobbering a concurrent live leg's rows.
 *
 * @consumedBy the MCP server settings' live status, which reads each leg's server states
 */
export interface McpServerStatusUpdate {
  sessionId: SessionId;
  bindingId: string;
  serverName: string;
  status: McpServerStatus;
}

/**
 * The injected status sink. Returns `void`, not `Promise<void>`, unlike the awaited
 * `onCallbackToolCall`: it is fire-and-forget telemetry, and making it awaitable would let a slow
 * consumer back-pressure the provider's status stream.
 */
export type McpServerStatusProducer = (emission: McpServerStatusEmission) => void;

// ---- Provider-native subagents ----

/**
 * Provider-native subagent policy, daemon-constructed and gated on `subagents`. The daemon is the
 * only cross-session supervisor, so provider subagents run in-session only: their usage aggregates
 * into the run's own budgets and their tool calls flow through the same approval pipeline.
 * `helpersAtOnce` is the person's `Helpers at once`: how many helpers run at once, at least one, or
 * `null` for no limit; a setting of `0` is `{enabled: false}`, which withholds the provider's helper
 * tool. Nothing bounds how deep helpers nest. Discriminated on `enabled` so a disabled policy
 * carries no limit or definitions.
 */
export type SubagentPolicy =
  | { enabled: false }
  | { enabled: true; helpersAtOnce: number | null; definitions: SubagentDefinition[] };

/**
 * The unified per-subagent definition each driver maps onto its provider's own form. The fields
 * beyond `name`, `prompt` and `description` are optional because each leg maps what its provider
 * supports and ignores the rest, which the capability matrix grades.
 */
export interface SubagentDefinition {
  name: string;
  /** The helper's own instructions, which its provider runs it under. */
  prompt: string;
  /** When the lead should hand work to this helper; both providers require it. */
  description: string;
  model?: string | undefined;
  tools?: string[] | undefined;
  effort?: string | undefined;
  maxTurns?: number | undefined;
}

// ---- Tool servers ----

/** One tool server a session can reach, by its name, and whether the person switched it on. */
export interface SessionToolServer {
  serverName: string;
  enabled: boolean;
}
