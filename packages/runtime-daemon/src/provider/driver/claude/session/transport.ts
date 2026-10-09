/**
 * The seam between the Claude session lifecycle and the process that runs a session: the frames it
 * writes, the control requests it sends and answers, the channel it observes, and the requests
 * that open, resume, fork or probe a session.
 */

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { type ThreadFrameRoute } from "../../../thread-frame-router.js";
import { type CumulativeAxisReadings } from "../../../usage-delta-accountant.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import type { OutboundText } from "../../../outbound-text.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { type ClaudeSubagentLifecycleSignal } from "../event-normalizer.js";
import type {
  ClaudeCallbackMcpServerDescriptor,
  ClaudeSandboxSettings,
} from "../spawn/settings.js";
import type {
  CallbackToolInvocation,
  CallbackToolResult,
  McpServerStatusProducer,
  SessionToolServer,
  StartRunParams,
  SubagentPolicy,
} from "../../contract.js";
import type { DaemonTurnBindingResolver } from "../../run-control.js";
import type { ClaudeAttachedAdvisor } from "./answered-commands.js";

/** Bare name: `system/init` lists `slash_commands` without the leading slash. */
export const CLAUDE_COMPACTION_COMMAND_NAME = "compact";

/**
 * How long the transport waits on any one request to the Claude Code process, a control request or
 * a stdin write, before failing it. Milliseconds.
 */
export const CLAUDE_REQUEST_DEADLINE_MS = 60_000;

/** The slash command that asks the provider to compact its context. */
export const CLAUDE_COMPACTION_COMMAND_TEXT: string = `/${CLAUDE_COMPACTION_COMMAND_NAME}`;

/**
 * One stdin user frame as Claude Code's stream-json input reads it. `uuid` names the message, so a
 * withdraw (`cancel_async_message`) and a conversation cut (`rewind_conversation`) can address it.
 */
export interface ClaudeUserFrame {
  readonly type: "user";
  readonly uuid: string;
  readonly message: { readonly role: "user"; readonly content: string };
  readonly client_composed?: true;
}

/**
 * Composes the user frame for one piece of provider-bound text, its words unchanged. Only text the
 * daemon composes itself is marked `client_composed: true`, so a leading `/` or an `@path` in it
 * reaches the model as written; the person's typed text and a command the daemon sends for Claude
 * Code to run go unmarked, since the mark expands no `@path` and stops a command from running.
 */
export function composeClaudeUserFrame(
  outboundText: OutboundText,
  messageUuid: string,
): ClaudeUserFrame {
  const frame: ClaudeUserFrame = {
    type: "user",
    uuid: messageUuid,
    message: { role: "user", content: outboundText.text },
  };
  return outboundText.origin === "system_narration" ? { ...frame, client_composed: true } : frame;
}

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

/** Claude Code's permission modes, as `--permission-mode` and `set_permission_mode` take them. */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "plan";

/** The hook events the daemon registers on the wire in `initialize`. */
type ClaudeHookEvent = "PreToolUse" | "PostToolBatch" | "PermissionDenied";

/**
 * One hook matcher as `initialize` declares it. `matcher` is a regular expression on the tool name;
 * `timeout` is in seconds and bounds how long Claude Code waits on an unanswered callback.
 */
export interface ClaudeHookMatcher {
  readonly matcher?: string;
  readonly hookCallbackIds: readonly string[];
  readonly timeout?: number;
}

/** The `permissions` document of a session's settings; `null` on a list never removes a rule. */
export interface ClaudePermissionsDocument {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

/**
 * The flag settings the daemon changes on a live process. `apply_flag_settings` merges each
 * top-level key whole, so `permissions` always carries the session's whole document, and a key
 * sent as `null` is removed from the flag-settings layer.
 */
interface ClaudeFlagSettings {
  readonly fastMode?: boolean;
  readonly permissions?: ClaudePermissionsDocument;
  /** One of the output styles the `initialize` reply offered. */
  readonly outputStyle?: string;
  /** The Bash sandbox, on at Sandboxed and removed at every other level. */
  readonly sandbox?: ClaudeSandboxSettings | null;
  /**
   * The session's advisor model, or `""` for none: Claude Code reads an empty advisor as off, and
   * it outranks the person's own advisor, which `null` would let through by removing the key.
   */
  readonly advisorModel?: string;
  /** Environment keys the process reads from its next request on; a key sent as `""` is removed. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * One helper definition as `initialize` declares it under `agents`, keyed by the helper's name.
 * Claude Code requires `description` and `prompt`; no `permissionMode` is sent, so a helper runs
 * at its session's level.
 */
export interface ClaudeAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly effort?: string;
  readonly maxTurns?: number;
}

/** An MCP server entry `mcp_set_servers` installs: one route on the daemon's tool server. */
export interface ClaudeHttpServerEntry {
  readonly type: "http";
  readonly url: string;
}

/**
 * The control requests the daemon sends, in their wire shape; closed so an unrouted subtype cannot
 * typecheck. `cancel_queued` rides only where the process advertised `interrupt_cancel_queued_v1`.
 */
export type ClaudeControlRequest =
  | {
      readonly subtype: "initialize";
      readonly hooks: Readonly<Partial<Record<ClaudeHookEvent, readonly ClaudeHookMatcher[]>>>;
      readonly agents?: Readonly<Record<string, ClaudeAgentDefinition>>;
      readonly supportedDialogKinds: readonly string[];
      readonly perTaskStopAffordance: true;
    }
  | { readonly subtype: "interrupt"; readonly cancel_queued?: true }
  | { readonly subtype: "apply_flag_settings"; readonly settings: ClaudeFlagSettings }
  | { readonly subtype: "set_permission_mode"; readonly mode: ClaudePermissionMode }
  | { readonly subtype: "set_max_thinking_tokens"; readonly thinking_display: "summarized" }
  | {
      readonly subtype: "mcp_set_servers";
      readonly servers: Readonly<Record<string, ClaudeHttpServerEntry>>;
    }
  | { readonly subtype: "get_settings" }
  | {
      readonly subtype: "rewind_conversation";
      readonly target_message_uuid: string;
      readonly last_seen_user_message_uuid?: string;
      readonly interrupt_if_running: true;
    }
  | { readonly subtype: "cancel_async_message"; readonly message_uuid: string }
  | { readonly subtype: "get_context_usage" }
  | { readonly subtype: "set_model"; readonly model: string }
  | { readonly subtype: "get_binary_version" };

/** The settled `control_response` payload; a typed refusal is feature-detected at call time. */
export type ClaudeControlResponse =
  | { readonly subtype: "success"; readonly response?: Record<string, unknown> | undefined }
  | { readonly subtype: "error"; readonly error: string };

/**
 * One request Claude Code sent the daemon (`can_use_tool`, `hook_callback`, `request_user_dialog`
 * and the rest), verbatim and untrusted, under the id its answer goes back with.
 */
export interface ClaudeInboundControlRequest {
  readonly requestId: string;
  readonly subtype: string;
  readonly request: Readonly<Record<string, unknown>>;
}

/** What arrives on a channel's request stream: a request, or Claude Code withdrawing one. */
export type ClaudeInboundRequestEvent =
  | { readonly kind: "request"; readonly request: ClaudeInboundControlRequest }
  | { readonly kind: "cancel"; readonly requestId: string };

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

/**
 * A fast-mode declaration verbatim: `fast_mode_state` and `fast_mode_disabled_reason`, as the
 * `initialize` reply and each `system/init` report them; `null` where the frame carries none.
 */
export interface ClaudeFastModeDeclaration {
  readonly fastModeState: string | null;
  readonly fastModeDisabledReason: string | null;
}

/** The `system/init` declaration, verbatim and whole; the cap applies to the composed reply. */
export interface ClaudeHandshakeDeclaration extends ClaudeFastModeDeclaration {
  /** `slash_commands` — interactively invocable, names WITHOUT a leading `/`. */
  readonly slashCommands: readonly string[];
  readonly skills: readonly string[];
  /** Run in the provider's terminal UI, not invocable here; kept out of `invocableCommandNames`. */
  readonly terminalSlashCommands: readonly string[];
  /** The open `capabilities` set, each token verbatim, such as `interrupt_cancel_queued_v1`. */
  readonly capabilities: readonly string[];
  /** The permission mode the process runs in, which may differ from the one it was asked for. */
  readonly permissionMode: string | null;
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

/** One live Claude Code process, past its `initialize` exchange. */
export interface ClaudeProviderProcess {
  readonly providerSessionId: string;

  /**
   * Whether no further `onTurnTerminal` can arrive (not merely that the process exited); a channel
   * that can deliver none must say `true`. `false` is the safe default: it costs one slot.
   */
  readonly isClosed: boolean;

  /**
   * Writes the text as one `composeClaudeUserFrame` line stamped `messageUuid`. Report a failure as
   * a `failed` attempt, not a rejection: only the transport knows whether it came before the first
   * byte, and a rejection is treated as `indeterminate`.
   */
  sendUserText(
    outboundText: OutboundText,
    messageUuid: string,
  ): Promise<ClaudeUserTextWriteAttempt>;

  /**
   * Sends one control request and settles on its `control_response`. Rejects with
   * `ClaudeRequestTimeoutError` when the request's deadline passes and at once when the process
   * exits with the request pending.
   */
  sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse>;

  /**
   * Registers the observer of the requests Claude Code sends (replacing any earlier one). A request
   * nobody answers stays pending at the provider, which waits on it.
   */
  onInboundRequest(observer: (event: ClaudeInboundRequestEvent) => void): void;

  /** Answers one request Claude Code sent, under its own id. Rejects when the write fails. */
  answerInboundRequest(requestId: string, response: Record<string, unknown>): Promise<void>;

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
   * Registers the consumer of each frame the router delivered (replacing any earlier one), whole
   * and untrusted, with the route it was delivered under; the event side normalizes it.
   */
  onDeliveredFrame(
    consumer: (frame: Readonly<Record<string, unknown>>, route: ThreadFrameRoute) => void,
  ): void;

  /** Registers the exit observer (replacing any earlier one); it is called once, on exit. */
  onExit(observer: (exit: ProcessExit) => void): void;

  /**
   * Stops the process with SIGTERM, which ends a running turn without answering what is queued,
   * and resolves once it exited. Used by a conversation cut and a process that stopped answering.
   */
  terminate(): Promise<void>;

  /**
   * Ends the provider process by closing its input, which lets it finish what it holds, and kills
   * it if it has not exited within the request deadline. A rejected session-bound channel stays
   * quarantined and the next `closeSession` retries it; a refused foreign-id channel is dropped,
   * and only the refusal text reports the rejection.
   */
  dispose(reason: ClaudeChannelDisposalReason): Promise<void>;
}

/**
 * The spawn-bound legs shared by every spawn of a session. A resume is a fresh spawn, so a leg
 * omitted there would be shed (a posture-less relaunch runs unsandboxed).
 */
export interface ClaudeSpawnBoundLegs {
  readonly sessionId: SessionId;
  /** The session's model, passed as `--model` on every spawn. */
  readonly model: string;
  readonly executionPosture: ExecutionPosture | undefined;
  /** The folder the process runs in; a resume from any other folder starts a new conversation. */
  readonly workingDirectory: string;
  readonly callbackTools: SessionCallbackTool[] | undefined;
  readonly subagentPolicy: SubagentPolicy | undefined;
  /** Every tool server the session can reach, each installed by `mcp_set_servers` when on. */
  readonly toolServers: readonly SessionToolServer[];
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly onCallbackToolCall:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  /**
   * The daemon-hosted `sidekicks` server serving the admitted `callbackTools`; the transport
   * realizes it as `--mcp-config` and maps invocations back via `registryNamesByProviderName`.
   */
  readonly callbackToolServer: ClaudeCallbackMcpServerDescriptor | undefined;
  readonly onMcpServerStatus: McpServerStatusProducer | undefined;
  /** The curated credential paths, canonical and absolute, denied to every file tool. */
  readonly credentialDenyPaths: readonly string[];
  /** The agent's memory folder and its link, whose `.md` files it may change at Sandboxed. */
  readonly memoryFolders: readonly string[];
  /** The process's whole environment, built once by `composeClaudeSpawnEnvironment`. */
  readonly spawnEnvironment: readonly SpawnEnvPair[];
  /** The session's advisor model, carried in `--settings`, or `null` when it is off. */
  readonly advisorModel: string | null;
  /**
   * The session's own output style, carried in `--settings`, or `null` where it chose none and
   * Claude Code's own setting holds.
   */
  readonly outputStyle: string | null;
}

/** The request to start a provider process for a new session. */
export interface ClaudeSessionSpawnRequest extends ClaudeSpawnBoundLegs {
  // Pinned as `--session-id`; not the daemon's `SessionId`, since a relaunch spawns a second
  // process for the same session and a reused id would collide with the leg shutting down.
  readonly providerSessionId: string;
  readonly config: Record<string, unknown>;
}

/** The request to re-attach to an existing provider session by its resume handle. */
export interface ClaudeSessionResumeRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string;
}

/**
 * A conversation fork: `--fork-session --resume-session-at <message-uuid>`, carrying the
 * spawn-bound legs because a fork is a fresh process. The transport resolves `targetPosition` to
 * the message uuid (throwing on a position naming no turn), runs the fork from the identical
 * working folder, and never uses `--rewind-files`, which restores only Write and Edit.
 */
export interface ClaudeSessionRewindRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string;
  readonly targetPosition: number;
}

/** One model the `initialize` reply offers, as Claude Code names it and as it resolves it. */
export interface ClaudeOfferedModel {
  /** What Claude Code takes as `--model`: a short alias or a full id. */
  readonly value: string;
  /** The full model id, where the reply resolves one. */
  readonly resolvedModel: string | undefined;
  /** The name Claude Code shows for it, where the reply gives one. */
  readonly displayName: string | undefined;
}

/**
 * What the `initialize` reply declared about the session's models and styles: the models it
 * offers, in its order, which of them run in auto mode, and the output styles the process offers.
 */
export interface ClaudeInitializeDeclaration {
  readonly fastMode: ClaudeFastModeDeclaration;
  readonly models: readonly ClaudeOfferedModel[];
  /**
   * Each name, alias and full id alike, of a model whose `supportsAutoMode` is true, the only ones
   * Reviewed is offered on.
   */
  readonly autoModeModels: ReadonlySet<string>;
  readonly outputStyles: readonly string[];
  /** The output style the process runs with, where the reply names one. */
  readonly outputStyle: string | undefined;
}

/** What the process's `get_settings` reply says took effect, read after each spawn. */
export interface ClaudeSettingsReadback {
  /** `effective.cleanupPeriodDays`, or `null` where the reply carries none. */
  readonly cleanupPeriodDays: number | null;
  readonly attachedAdvisor: ClaudeAttachedAdvisor;
}

/** A live provider process the transport attached, with its session id. */
export interface ClaudeSessionAttachment {
  // The id the process runs under; compared with the requested id, never assumed to match.
  readonly providerSessionId: string;
  readonly channel: ClaudeProviderProcess;
  /**
   * What the process's `initialize` reply reported, before any turn. Required, so every spawn,
   * resume and fork hands the binding its first output-speed observation.
   */
  readonly initialize: ClaudeInitializeDeclaration;
  readonly settingsReadback: ClaudeSettingsReadback;
}

/**
 * An attachment produced by a resume or a fork, carrying the position the process landed at: for
 * a fork, where it landed, not the requested position.
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
  /** The probe's whole environment, built like a session's so it cannot update the build. */
  readonly spawnEnvironment: readonly SpawnEnvPair[];
}

/**
 * A turn run once in a process that keeps nothing: on a throwaway copy of `resumeHandle`'s
 * conversation, or on a new conversation when it is `undefined`. `text` is the turn's message;
 * `signal`, where given, stops the turn and its process when it aborts.
 */
export interface ClaudeOneTurnRequest extends ClaudeSpawnBoundLegs {
  readonly resumeHandle: string | undefined;
  readonly text: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * One turn's reply: its text, the provider's own id of the lead's last message, the one that text
 * is, or `undefined` when the lead sent none, and the refusal the turn ended on, where it was
 * refused.
 */
export interface ClaudeOneTurnReply {
  readonly text: string;
  readonly providerMessageId: string | undefined;
  readonly refusal: RunRefusedCause | undefined;
}

/**
 * What one short control-only process reported about the models: its `initialize` reply, whose
 * `models` is the catalog, and its `get_context_usage` reply for the model it ran on, or
 * `undefined` where the process answered none.
 */
export interface ClaudeModelCatalogReading {
  readonly initialize: Record<string, unknown> | undefined;
  readonly contextUsage: Record<string, unknown> | undefined;
}

/**
 * Where a control-only process reading a session's figures is started: the session's own folder,
 * environment and model, so the project's and the person's own styles are among those it lists and
 * its context reads describe that model, under the session's base address.
 */
export interface ClaudeSessionFolderReadRequest {
  readonly spawnEnvironment: readonly SpawnEnvPair[];
  /** The session's working folder, absolute. */
  readonly workingDirectory: string;
  /** The model the figures are read for, passed as `--model`. */
  readonly model: string;
}

/**
 * A session's creation-time read: its folder read, and the models whose context read is already
 * done, which the process skips.
 */
export interface ClaudeCreationFiguresRequest extends ClaudeSessionFolderReadRequest {
  readonly contextReadModels: ReadonlySet<string>;
}

/**
 * One `get_context_usage` reply a control-only process gave with no window key set; `usage` is
 * `undefined` where Claude Code refused the move to the model or the read.
 */
export interface ClaudeModelContextRead {
  /** The model the process was started on or moved to; `undefined` for the account's default. */
  readonly requestedModel: string | undefined;
  readonly usage: Record<string, unknown> | undefined;
}

/** What one command typed with no argument printed in a control-only process. */
export interface ClaudeLocalCommandReply {
  /** Whether that process's `initialize.commands` names the command. */
  readonly isListed: boolean;
  /** The text of the command's `result`, or `undefined` where it carried none. */
  readonly text: string | undefined;
  /**
   * The `local_command_outcome.kind` Claude Code stamped on its reply (`unavailable_headless`,
   * `unknown`, …), as sent, or `undefined` where it stamped none.
   */
  readonly outcome: string | undefined;
}

/**
 * The two `get_context_usage` replies a reply reserve is derived from, as Claude Code sent them:
 * the first with only the window key set, the second with the maximum output key added; or the
 * request Claude Code refused on the way, with its words.
 */
export type ClaudeReplyReserveReads =
  | {
      readonly kind: "read";
      readonly windowOnly: Record<string, unknown> | undefined;
      readonly withMaximumOutput: Record<string, unknown> | undefined;
    }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * What the control-only process a session's creation runs reported: what `/output-style` and
 * `/advisor` printed typed with no argument, with the style names its `initialize` reply gave, the
 * two context reads the reply reserve comes from, and the context reads of its own model and of
 * each catalog model it was not told to skip.
 */
export interface ClaudeCreationFiguresReading {
  readonly outputStyleNames: readonly string[];
  readonly outputStyle: ClaudeLocalCommandReply;
  readonly advisor: ClaudeLocalCommandReply;
  readonly replyReserveReads: ClaudeReplyReserveReads;
  readonly contextReads: readonly ClaudeModelContextRead[];
}

/** The provider-process port: spawn, resume and fork a session, and probe authentication. */
export interface ClaudeSessionTransport {
  /**
   * Whether a spawn now would reach `callbackToolServer`. Required so it is never decided by
   * omission: `false` withholds the registry rather than expose tools nothing delivers.
   */
  readonly realizesCallbackToolRegistration: boolean;

  /**
   * Starts a provider process for a new session in `spawnEnvironment` exactly, never an inherited
   * one, resolving the configured command at each spawn. A determinate logged-out failure throws
   * `ClaudeAuthenticationRequiredError` (the only route to `reauth-required`); any other failure
   * throws something else. The same holds for `resumeSession` and `rewindSession`.
   */
  spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment>;
  /** Re-attaches to an existing provider session, with `spawnSession`'s obligations. */
  resumeSession(request: ClaudeSessionResumeRequest): Promise<ClaudeResumedSessionAttachment>;
  /**
   * Forks the session at a recorded position. Separate from `resumeSession` because a resume
   * landing on a different session id is a failure while a fork landing on the same id is one.
   */
  rewindSession(request: ClaudeSessionRewindRequest): Promise<ClaudeResumedSessionAttachment>;
  /**
   * The zero-turn authentication probe; reaching a working handshake is the evidence. The
   * transport spends no turn, leaks no credential material, tears down what it starts on every
   * path, and throws `ClaudeAuthenticationRequiredError` for a determinate logged-out reading.
   */
  probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading>;
  /**
   * Brings one process up with nothing persisted, reads its model catalog and the context window
   * of the model it runs on, spends no turn, and tears it down on every path.
   */
  readModelCatalog(request: ClaudeAuthProbeRequest): Promise<ClaudeModelCatalogReading>;
  /**
   * Brings one process up in the session's folder on its model with nothing persisted, sends
   * `/output-style` and `/advisor` with no argument, which Claude Code answers itself with no model
   * turn, then reads `get_context_usage` with the window key set and again with the maximum output
   * key added, removing both after. Then, with no key set, it reads `get_context_usage` on its
   * own model and, after `set_model`, on each catalog model `contextReadModels` does not name, and
   * tears it down on every path. Throws when the process fails, a reply does not arrive within the
   * request deadline, or a reply shows a model turn.
   */
  readCreationFigures(request: ClaudeCreationFiguresRequest): Promise<ClaudeCreationFiguresReading>;
  /**
   * Brings one process up in the session's folder on the request's model with nothing persisted,
   * reads the two context reads `readCreationFigures` reads and nothing else, and tears it down on
   * every path; for a model the session moved to after it was created. Throws as that does.
   */
  readReplyReserve(request: ClaudeSessionFolderReadRequest): Promise<ClaudeReplyReserveReads>;
  /**
   * Runs one turn in a process that persists nothing and resolves with the turn's reply once its
   * `result` arrives, a refused turn included; rejects when the process ends first, the turn
   * reports any other error or the request's signal aborts. The process is torn down on every path.
   */
  runOneTurn(request: ClaudeOneTurnRequest): Promise<ClaudeOneTurnReply>;
  /**
   * Ends every process this transport started and starts none after it, as the daemon stops: each
   * one's input is closed, and one still running after a bounded wait is killed. Resolves once
   * every one has exited.
   */
  stopEveryProcess(): Promise<void>;
}

/**
 * The daemon-owned facts `startRun` needs that `StartRunParams` lacks. `messageId` is the person's
 * message the opening text is, a UUID, stamped on the user frame so a later cut can name it.
 */
export interface ClaudeRunDispatch {
  readonly sessionId: SessionId;
  /** The runtime binding the run's deliveries are attributed on, opened by the daemon. */
  readonly bindingId: string;
  readonly openingText: string;
  readonly messageId: string;
}

/**
 * Resolves a run's dispatch facts and opens the binding of a turn the daemon starts on the session
 * itself, which carries no queued message (wired by the daemon).
 */
export interface ClaudeRunDispatchResolver extends DaemonTurnBindingResolver {
  /** The facts of a run admitted from the queue, or `undefined` when it has none. */
  resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined>;
}

/**
 * The reads `ClaudeInterventionDispatcher` needs: the live channel a run is bound to and the
 * capabilities its process advertised on `system/init`.
 */
export interface ClaudeRunProcessLookup {
  findProcessForRun(runId: RunId): ClaudeProviderProcess | undefined;
  advertisedCapabilitiesForRun(runId: RunId): ReadonlySet<string>;
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

/**
 * Sends one control request on a live process and resolves with its answer's payload. Throws
 * `ClaudeControlRequestRefusedError` when Claude Code refuses it.
 */
export async function sendClaudeControlRequest(
  channel: Pick<ClaudeProviderProcess, "sendControlRequest">,
  request: ClaudeControlRequest,
): Promise<Record<string, unknown> | undefined> {
  const response = await channel.sendControlRequest(request);
  if (response.subtype === "error") {
    throw new ClaudeControlRequestRefusedError(request.subtype, response.error);
  }
  return response.response;
}
