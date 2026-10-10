// The transport that runs Claude Code: each spawn resolves the configured command again, starts
// the process in the session's folder and environment with the composed command line, and brings
// it up: `initialize` with the daemon's hooks, the summarized thinking display, the session's tool
// servers, and the settings readback. It also runs the processes that keep nothing: the sign-in
// probe, the model catalog read, the figures read when a session is created, the build read,
// whose version read and capability probes share one process, which spend no turn, and a one-turn
// process. It keeps every process it started, so the daemon's stop ends them all.

import os from "node:os";

import { DAEMON_STOP_TERMINAL_DRAIN_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { mintUuidV7 } from "../../../../uuid-v7.js";
import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { ToolServerRoute } from "../../../port/tool-server-route.js";
import {
  resolveProviderExecutable,
  type ProviderVersionHandshakeRequest,
} from "../../../spawned-version.js";
import { DAEMON_TOOL_SERVER_NAME } from "../../../tool-server-name.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import { McpServerStatusEmissionSchema } from "../../contract.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { readClaudeProviderMessageId } from "../delivery/messages.js";
import {
  readClaudeAssistantRefusal,
  readClaudeRefusalWithoutFallback,
} from "../delivery/system.js";
import { composeClaudeInitializeRequest } from "../hooks/registration.js";
import { classifyClaudeTurnEvidence } from "../turn-evidence.js";
import {
  claudeConfigFolderFor,
  findClaudeConversationFile,
  readClaudeConversationOutline,
  type ClaudeConversationOutline,
} from "../session/conversation-file.js";
import {
  ClaudeAuthenticationRequiredError,
  describeFailure,
  sanitizeFailureDetail,
} from "../session/errors.js";
import {
  startClaudeCodeProcess,
  type ClaudeCodeProcess,
  type ClaudeCodeProcessLaunch,
} from "../session/process.js";
import {
  CLAUDE_REQUEST_DEADLINE_MS,
  ClaudeControlRequestRefusedError,
  type ClaudeAuthProbeReading,
  type ClaudeAuthProbeRequest,
  type ClaudeCreationFiguresReading,
  type ClaudeCreationFiguresRequest,
  type ClaudeModelContextRead,
  type ClaudeSessionFolderReadRequest,
  type ClaudeLocalCommandReply,
  type ClaudeReplyReserveReads,
  type ClaudeControlRequest,
  type ClaudeControlResponse,
  type ClaudeHttpServerEntry,
  type ClaudeInitializeDeclaration,
  type ClaudeModelCatalogReading,
  type ClaudeOfferedModel,
  type ClaudeOneTurnReply,
  type ClaudeOneTurnRequest,
  type ClaudeResumedSessionAttachment,
  type ClaudeSessionAttachment,
  type ClaudeSessionResumeRequest,
  type ClaudeSessionRewindRequest,
  type ClaudeSessionSpawnRequest,
  type ClaudeSessionTransport,
  type ClaudeSettingsReadback,
  type ClaudeSpawnBoundLegs,
} from "../session/transport.js";
import { readClaudeAttachedAdvisor } from "../session/answered-commands.js";
import {
  CLAUDE_AUTO_COMPACT_WINDOW_KEY,
  CLAUDE_MAX_OUTPUT_TOKENS_KEY,
  CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS,
  CLAUDE_RESERVE_READ_WINDOW_TOKENS,
} from "../session/reply-reserve.js";
import { composeClaudeArguments, type ClaudeConversationStart } from "./arguments.js";
import { composeClaudeSpawnSettings } from "./settings.js";

/** What the transport resolves and reaches at each spawn. */
export interface ClaudeProcessTransportDependencies {
  /** The provider command to run, read again at every spawn. */
  readonly providerCommand: () => Promise<string>;
  /** The route to the session's tool servers; while unregistered a session loads none. */
  readonly toolServerRoute: PortRegistration<ToolServerRoute>;
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** The system fact a conversation file is found by: the variable naming the home folder. */
  readonly operatingSystem: Pick<ProviderOperatingSystem, "homeVariable">;
}

/** The reads of one build, on one process that keeps nothing: its version first, then probes. */
export interface ClaudeBuildProcess {
  /**
   * Starts the process at the request's resolved path in its environment and reads the build's
   * version with `get_binary_version`; the reply is the provider's, unread. Throws when Claude
   * Code refuses the request.
   */
  readonly readBinaryVersion: (request: ProviderVersionHandshakeRequest) => Promise<unknown>;
  /**
   * Sends one capability probe on the process the version read started and resolves with Claude
   * Code's answer as it came, a refusal of the name included, for the probe classifier to read.
   */
  readonly sendCapabilityProbe: (probeName: string) => Promise<ClaudeControlResponse>;
}

// The arguments of a process brought up only to answer control requests, keeping nothing.
const CLAUDE_CONTROL_ONLY_ARGUMENTS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
];

// What a one-turn process answers a tool ask with: it has no one to ask.
const CLAUDE_ONE_TURN_ASK_DENIAL =
  "This turn runs on its own copy of the conversation, with no one to approve a tool.";

// The Agent SDK's own rule: `initialize` waits the larger of the request deadline and the stream
// close timeout the process was given, which is in milliseconds.
function initializeDeadlineMs(spawnEnvironment: readonly SpawnEnvPair[]): number {
  const configured = Number(
    spawnEnvironment.find(([name]) => name === "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT")?.[1],
  );
  return Number.isFinite(configured)
    ? Math.max(CLAUDE_REQUEST_DEADLINE_MS, configured)
    : CLAUDE_REQUEST_DEADLINE_MS;
}

function readInitializeDeclaration(
  reply: Record<string, unknown> | undefined,
): ClaudeInitializeDeclaration {
  const source = reply ?? {};
  const rawModels = Array.isArray(source["models"]) ? source["models"] : [];
  const models: ClaudeOfferedModel[] = [];
  const autoModeModels = new Set<string>();
  for (const model of rawModels) {
    const value = isPlainObject(model) ? readNonEmptyString(model, "value") : undefined;
    if (value === undefined || !isPlainObject(model)) {
      continue;
    }
    const resolvedModel = readNonEmptyString(model, "resolvedModel");
    models.push({ value, resolvedModel, displayName: readNonEmptyString(model, "displayName") });
    if (model["supportsAutoMode"] === true) {
      autoModeModels.add(value);
      if (resolvedModel !== undefined) {
        autoModeModels.add(resolvedModel);
      }
    }
  }
  const styles = Array.isArray(source["available_output_styles"])
    ? source["available_output_styles"].filter(
        (style): style is string => typeof style === "string",
      )
    : [];
  return {
    fastMode: {
      fastModeState: readNonEmptyString(source, "fast_mode_state") ?? null,
      fastModeDisabledReason: readNonEmptyString(source, "fast_mode_disabled_reason") ?? null,
    },
    models,
    autoModeModels,
    outputStyles: styles,
    outputStyle: readNonEmptyString(source, "output_style"),
  };
}

// The commands an `initialize` reply's `commands` lists, by name.
function readListedCommandNames(reply: Record<string, unknown> | undefined): Set<string> {
  const commands = reply?.["commands"];
  const names = new Set<string>();
  for (const command of Array.isArray(commands) ? commands : []) {
    const name = isPlainObject(command) ? readNonEmptyString(command, "name") : undefined;
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/** Runs Claude Code processes for the lifecycle; see {@link ClaudeSessionTransport}. */
export class ClaudeProcessTransport implements ClaudeSessionTransport {
  readonly #dependencies: ClaudeProcessTransportDependencies;
  // Every process started and not yet exited, so the daemon's stop reaches each one.
  readonly #liveProcesses: Set<ClaudeCodeProcess> = new Set();
  #isStopped = false;

  constructor(dependencies: ClaudeProcessTransportDependencies) {
    this.#dependencies = dependencies;
  }

  /** The callback tools ride the daemon's tool server, so they reach a session only once routed. */
  get realizesCallbackToolRegistration(): boolean {
    return this.#dependencies.toolServerRoute.port !== undefined;
  }

  async spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment> {
    return await this.#launch(request, request.providerSessionId, {
      kind: "new",
      providerSessionId: request.providerSessionId,
    });
  }

  async resumeSession(
    request: ClaudeSessionResumeRequest,
  ): Promise<ClaudeResumedSessionAttachment> {
    // Read before the spawn: the position is where the conversation stood when it was resumed.
    const outline = await this.#readOutline(request.spawnEnvironment, request.resumeHandle);
    const attachment = await this.#launch(request, request.resumeHandle, {
      kind: "resume",
      resumeHandle: request.resumeHandle,
    });
    return { ...attachment, sessionPosition: outline?.turnEndUuids.length ?? 0 };
  }

  /** Throws when the position names no turn of the conversation file. */
  async rewindSession(
    request: ClaudeSessionRewindRequest,
  ): Promise<ClaudeResumedSessionAttachment> {
    const outline = await this.#readOutline(request.spawnEnvironment, request.resumeHandle);
    const resumeAtMessageUuid = outline?.turnEndUuids[request.targetPosition - 1];
    if (resumeAtMessageUuid === undefined) {
      throw new Error(
        `Position ${String(request.targetPosition)} names no turn of conversation ` +
          `${request.resumeHandle}.`,
      );
    }
    const forkedProviderSessionId = mintUuidV7();
    const attachment = await this.#launch(request, forkedProviderSessionId, {
      kind: "fork",
      resumeHandle: request.resumeHandle,
      forkedProviderSessionId,
      resumeAtMessageUuid,
    });
    return { ...attachment, sessionPosition: request.targetPosition };
  }

  /**
   * Brings a process up on the person's own home with nothing persisted and reads the account
   * its `initialize` reply names; one with no sign-in source is logged out.
   */
  async probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading> {
    const claudeProcess = await this.#startControlOnly(request);
    try {
      const reply = await this.#expectSuccess(
        claudeProcess,
        composeClaudeInitializeRequest(undefined),
        initializeDeadlineMs(request.spawnEnvironment),
      );
      const account = reply?.["account"];
      const signInSource = isPlainObject(account)
        ? (readNonEmptyString(account, "tokenSource") ??
          readNonEmptyString(account, "apiKeySource"))
        : undefined;
      if (signInSource === undefined || signInSource === "none") {
        throw new ClaudeAuthenticationRequiredError("Claude Code names no sign-in on this home.");
      }
      return { detail: `signed in through ${signInSource}` };
    } finally {
      await claudeProcess.dispose();
    }
  }

  /** Reads the catalog from a control-only process's `initialize` reply; see the port. */
  async readModelCatalog(request: ClaudeAuthProbeRequest): Promise<ClaudeModelCatalogReading> {
    const claudeProcess = await this.#startControlOnly(request);
    try {
      const initialize = await this.#expectSuccess(
        claudeProcess,
        composeClaudeInitializeRequest(undefined),
        initializeDeadlineMs(request.spawnEnvironment),
      );
      return { initialize, contextUsage: await this.#readContextUsage(claudeProcess) };
    } finally {
      await claudeProcess.dispose();
    }
  }

  /** Reads the figures a session's creation needs from one control-only process; see the port. */
  async readCreationFigures(
    request: ClaudeCreationFiguresRequest,
  ): Promise<ClaudeCreationFiguresReading> {
    const claudeProcess = await this.#startControlOnly(request, request.workingDirectory, [
      "--model",
      request.model,
    ]);
    try {
      const initialize = await this.#expectSuccess(
        claudeProcess,
        composeClaudeInitializeRequest(undefined),
        initializeDeadlineMs(request.spawnEnvironment),
      );
      const listed = readListedCommandNames(initialize);
      // One at a time: each command is answered by its own `result`.
      const outputStyle = await this.#printLocalCommand(claudeProcess, "output-style", listed);
      const advisor = await this.#printLocalCommand(claudeProcess, "advisor", listed);
      const declaration = readInitializeDeclaration(initialize);
      const replyReserveReads = await this.#readReplyReserve(claudeProcess);
      return {
        outputStyleNames: declaration.outputStyles,
        outputStyle,
        advisor,
        replyReserveReads,
        // Last, once both reserve keys are removed, so each read reports the model's own window.
        contextReads: await this.#readContextWindows(claudeProcess, request, declaration.models),
      };
    } finally {
      await claudeProcess.dispose();
    }
  }

  /** Reads the reply reserve for one model from its own control-only process; see the port. */
  async readReplyReserve(
    request: ClaudeSessionFolderReadRequest,
  ): Promise<ClaudeReplyReserveReads> {
    const claudeProcess = await this.#startControlOnly(request, request.workingDirectory, [
      "--model",
      request.model,
    ]);
    try {
      await this.#expectSuccess(
        claudeProcess,
        composeClaudeInitializeRequest(undefined),
        initializeDeadlineMs(request.spawnEnvironment),
      );
      return await this.#readReplyReserve(claudeProcess);
    } finally {
      await claudeProcess.dispose();
    }
  }

  /**
   * Hands `read` the reads of one build, all on the one process its version read starts, which
   * ends once `read` settles.
   */
  async readBuild<T>(read: (build: ClaudeBuildProcess) => Promise<T>): Promise<T> {
    let claudeProcess: ClaudeCodeProcess | undefined;
    try {
      return await read({
        readBinaryVersion: async (request) => {
          const environment = Object.entries(request.environment).flatMap(
            ([name, value]): SpawnEnvPair[] => (value === undefined ? [] : [[name, value]]),
          );
          claudeProcess = await this.#startKeepingNothing(
            request.resolvedExecutablePath,
            environment,
          );
          return await this.#expectSuccess(claudeProcess, { subtype: "get_binary_version" });
        },
        sendCapabilityProbe: async (probeName) => {
          if (claudeProcess === undefined) {
            throw new Error(
              "A capability probe was sent before the version read started Claude Code",
            );
          }
          return await claudeProcess.sendCapabilityProbe(probeName);
        },
      });
    } finally {
      await claudeProcess?.dispose();
    }
  }

  async stopEveryProcess(): Promise<void> {
    this.#isStopped = true;
    await Promise.all(
      [...this.#liveProcesses].map(async (claudeProcess) => {
        await claudeProcess.stop(DAEMON_STOP_TERMINAL_DRAIN_MS);
      }),
    );
  }

  /** Runs one unkept turn; see the port. */
  async runOneTurn(request: ClaudeOneTurnRequest): Promise<ClaudeOneTurnReply> {
    const attachment = await this.#launch(request, mintUuidV7(), {
      kind: "unkept",
      resumeHandle: request.resumeHandle,
    });
    const channel = attachment.channel;
    // The lead's last message is the one the `result` text repeats; a helper's names a parent call.
    let providerMessageId: string | undefined;
    // As Claude Code reads a turn, its last refused message is the turn's refusal.
    let refusal: RunRefusedCause | undefined;
    channel.onDeliveredFrame((frame) => {
      if (frame["type"] === "assistant" && (frame["parent_tool_use_id"] ?? null) === null) {
        providerMessageId = readClaudeProviderMessageId(frame) ?? providerMessageId;
        refusal = readClaudeAssistantRefusal(frame) ?? refusal;
      }
      if (frame["type"] === "system" && frame["subtype"] === "model_refusal_no_fallback") {
        refusal = readClaudeRefusalWithoutFallback(frame) ?? refusal;
      }
    });
    try {
      const reply = new Promise<ClaudeOneTurnReply>((resolve, reject) => {
        channel.onTurnTerminal((terminalFrame) => {
          const frame = isPlainObject(terminalFrame) ? terminalFrame : {};
          const text = readNonEmptyString(frame, "result") ?? "";
          if (frame["is_error"] === true && refusal === undefined) {
            reject(new Error(`The one-turn Claude Code process ended in an error: ${text}`));
            return;
          }
          resolve({ text, providerMessageId, refusal });
        });
        channel.onExit(() => {
          reject(new Error("The one-turn Claude Code process exited before its turn ended."));
        });
        const stop = (): void => {
          reject(new Error("The one-turn Claude Code turn was stopped."));
        };
        if (request.signal?.aborted === true) {
          stop();
        }
        request.signal?.addEventListener("abort", stop, { once: true });
      });
      // The daemon's own hooks pass, and a tool ask is refused: no one watches this process.
      channel.onInboundRequest((event) => {
        if (event.kind === "cancel") {
          return;
        }
        const answer =
          event.request.subtype === "can_use_tool"
            ? { behavior: "deny", message: CLAUDE_ONE_TURN_ASK_DENIAL }
            : {};
        channel.answerInboundRequest(event.request.requestId, answer).catch(async (error) => {
          this.#dependencies.diagnostics.emit({
            provider: CLAUDE_DRIVER_NAME,
            kind: "control_answer_failed",
            rawWireType: null,
            dispositionReason: sanitizeFailureDetail(describeFailure(error)),
            details: { requestId: event.request.requestId },
          });
          await channel.terminate();
        });
      });
      const sent = channel
        .sendUserText({ text: request.text, origin: "human_text" }, mintUuidV7())
        .then((attempt) => {
          if (attempt.settled === "failed") {
            throw attempt.cause;
          }
        });
      // Awaited together, so a stop or an exit while the text is still being written rejects at
      // once and is never left unhandled.
      const [, turnReply] = await Promise.all([sent, reply]);
      return turnReply;
    } finally {
      // A stopped turn ends its process at once; a finished one closes it as any session closes.
      if (request.signal?.aborted === true) {
        await channel.terminate();
      } else {
        await channel.dispose("session_closed");
      }
    }
  }

  // A process on the person's own home that keeps nothing, for control requests alone.
  async #startControlOnly(
    request: ClaudeAuthProbeRequest,
    workingDirectory: string = os.tmpdir(),
    extraArguments: readonly string[] = [],
  ): Promise<ClaudeCodeProcess> {
    const resolved = await resolveProviderExecutable(
      CLAUDE_DRIVER_NAME,
      await this.#dependencies.providerCommand(),
      request.spawnEnvironment,
    );
    return await this.#startKeepingNothing(
      resolved.resolvedExecutablePath,
      request.spawnEnvironment,
      workingDirectory,
      extraArguments,
    );
  }

  async #startKeepingNothing(
    executablePath: string,
    environment: readonly SpawnEnvPair[],
    workingDirectory: string = os.tmpdir(),
    extraArguments: readonly string[] = [],
  ): Promise<ClaudeCodeProcess> {
    return await this.#start({
      executablePath,
      args: [...CLAUDE_CONTROL_ONLY_ARGUMENTS, ...extraArguments],
      workingDirectory,
      environment,
      providerSessionId: mintUuidV7(),
    });
  }

  // Sends `/<name>` as a command for Claude Code to run, unmarked so it runs, and resolves with the
  // text of its `result` and the outcome Claude Code stamped on its reply. A reply showing a model
  // turn is refused: its text is the model's.
  async #printLocalCommand(
    claudeProcess: ClaudeCodeProcess,
    name: string,
    listed: ReadonlySet<string>,
  ): Promise<ClaudeLocalCommandReply> {
    let outcome: string | undefined;
    claudeProcess.onDeliveredFrame((frame) => {
      const stamped = frame["local_command_outcome"];
      outcome =
        (isPlainObject(stamped) ? readNonEmptyString(stamped, "kind") : undefined) ?? outcome;
    });
    const answered = Promise.withResolvers<unknown>();
    claudeProcess.onTurnTerminal(answered.resolve);
    claudeProcess.onExit(() => {
      answered.reject(new Error(`Claude Code exited before it answered /${name}.`));
    });
    const deadline = setTimeout(() => {
      answered.reject(new Error(`Claude Code did not answer /${name} in time.`));
    }, CLAUDE_REQUEST_DEADLINE_MS);
    try {
      const sent = claudeProcess
        .sendUserText({ text: `/${name}`, origin: "driver_command" }, mintUuidV7())
        .then((attempt) => {
          if (attempt.settled === "failed") {
            throw attempt.cause;
          }
        });
      // Awaited together, so an exit while the text is still being written is never unhandled.
      const [, frame] = await Promise.all([sent, answered.promise]);
      if (classifyClaudeTurnEvidence(frame).observations.length > 0) {
        throw new Error(`Claude Code ran a model turn for /${name} instead of answering it.`);
      }
      return {
        isListed: listed.has(name),
        text: isPlainObject(frame) ? readNonEmptyString(frame, "result") : undefined,
        outcome,
      };
    } finally {
      clearTimeout(deadline);
    }
  }

  // Two context reads on the window key's window, the second with the maximum reply key added, and
  // both keys removed after, so nothing the process does later is capped. A refusal is the answer.
  // One process for every model: `set_model` moves it, and a refused move or read keeps no window.
  // Each full id is sent, never an alias, and each costs Claude Code's one-token model check.
  async #readContextWindows(
    claudeProcess: ClaudeCodeProcess,
    request: ClaudeCreationFiguresRequest,
    offeredModels: readonly ClaudeOfferedModel[],
  ): Promise<ClaudeModelContextRead[]> {
    const reads: ClaudeModelContextRead[] = [];
    const readModels = new Set(request.contextReadModels);
    if (!readModels.has(request.model)) {
      const usage = await this.#readContextUsage(claudeProcess);
      reads.push({ requestedModel: request.model, usage });
      const reportedModel = usage === undefined ? undefined : readNonEmptyString(usage, "model");
      readModels.add(reportedModel ?? request.model);
    }
    for (const { resolvedModel } of offeredModels) {
      if (resolvedModel === undefined || readModels.has(resolvedModel)) {
        continue;
      }
      readModels.add(resolvedModel);
      const moved = await claudeProcess.sendControlRequest({
        subtype: "set_model",
        model: resolvedModel,
      });
      reads.push({
        requestedModel: resolvedModel,
        usage:
          moved.subtype === "success" ? await this.#readContextUsage(claudeProcess) : undefined,
      });
    }
    return reads;
  }

  // Feature-detected: a build that refuses it reports no window, never a guessed one.
  async #readContextUsage(
    claudeProcess: ClaudeCodeProcess,
  ): Promise<Record<string, unknown> | undefined> {
    const usage = await claudeProcess.sendControlRequest({ subtype: "get_context_usage" });
    return usage.subtype === "success" ? usage.response : undefined;
  }

  async #readReplyReserve(claudeProcess: ClaudeCodeProcess): Promise<ClaudeReplyReserveReads> {
    const window = String(CLAUDE_RESERVE_READ_WINDOW_TOKENS);
    const maximumOutput = String(CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS);
    const steps: readonly ClaudeControlRequest[] = [
      {
        subtype: "apply_flag_settings",
        settings: { env: { [CLAUDE_AUTO_COMPACT_WINDOW_KEY]: window } },
      },
      { subtype: "get_context_usage" },
      {
        subtype: "apply_flag_settings",
        settings: {
          env: {
            [CLAUDE_AUTO_COMPACT_WINDOW_KEY]: window,
            [CLAUDE_MAX_OUTPUT_TOKENS_KEY]: maximumOutput,
          },
        },
      },
      { subtype: "get_context_usage" },
      {
        subtype: "apply_flag_settings",
        settings: {
          env: { [CLAUDE_AUTO_COMPACT_WINDOW_KEY]: "", [CLAUDE_MAX_OUTPUT_TOKENS_KEY]: "" },
        },
      },
    ];
    const reports: (Record<string, unknown> | undefined)[] = [];
    for (const step of steps) {
      const response = await claudeProcess.sendControlRequest(step);
      if (response.subtype === "error") {
        return { kind: "refused", detail: `${step.subtype}: ${response.error}` };
      }
      if (step.subtype === "get_context_usage") {
        reports.push(response.response);
      }
    }
    return { kind: "read", windowOnly: reports[0], withMaximumOutput: reports[1] };
  }

  // Every process starts here, so the daemon's stop knows each one; none starts once it stopped.
  async #start(launch: Omit<ClaudeCodeProcessLaunch, "diagnostics">): Promise<ClaudeCodeProcess> {
    if (this.#isStopped) {
      throw new Error("The daemon is stopping, so no Claude Code process starts.");
    }
    const claudeProcess = await startClaudeCodeProcess({
      ...launch,
      diagnostics: this.#dependencies.diagnostics,
    });
    this.#liveProcesses.add(claudeProcess);
    void claudeProcess.exited.then(() => {
      this.#liveProcesses.delete(claudeProcess);
    });
    // A stop that ran while the process was starting has already gone past it.
    if (this.#isStopped) {
      await claudeProcess.stop(DAEMON_STOP_TERMINAL_DRAIN_MS);
      throw new Error("The daemon is stopping, so no Claude Code process starts.");
    }
    return claudeProcess;
  }

  async #readOutline(
    spawnEnvironment: readonly SpawnEnvPair[],
    providerSessionId: string,
  ): Promise<ClaudeConversationOutline | undefined> {
    const filePath = await findClaudeConversationFile(
      claudeConfigFolderFor(spawnEnvironment, this.#dependencies.operatingSystem.homeVariable),
      providerSessionId,
    );
    return filePath === undefined ? undefined : await readClaudeConversationOutline(filePath);
  }

  async #launch(
    legs: ClaudeSpawnBoundLegs,
    providerSessionId: string,
    conversation: ClaudeConversationStart,
  ): Promise<ClaudeSessionAttachment> {
    // Resolved at every spawn, so a relaunch runs whatever the configured command names now.
    const resolved = await resolveProviderExecutable(
      CLAUDE_DRIVER_NAME,
      await this.#dependencies.providerCommand(),
      legs.spawnEnvironment,
    );
    // Read once per spawn, so the command line and the server set name the same route.
    const route = this.#dependencies.toolServerRoute.port;
    const policy = legs.subagentPolicy;
    const args = composeClaudeArguments({
      model: legs.model,
      level: legs.executionPosture?.mode,
      settings: composeClaudeSpawnSettings(legs),
      toolServer:
        route === undefined
          ? undefined
          : {
              name: DAEMON_TOOL_SERVER_NAME,
              entry: entryFor(route, legs.sessionId, DAEMON_TOOL_SERVER_NAME),
            },
      outputSchema: legs.outputSchema,
      withholdsHelperTool: policy?.enabled === false,
      conversation,
    });
    const claudeProcess = await this.#start({
      executablePath: resolved.resolvedExecutablePath,
      args,
      workingDirectory: legs.workingDirectory,
      environment: legs.spawnEnvironment,
      providerSessionId,
    });
    try {
      const initializeReply = await this.#expectSuccess(
        claudeProcess,
        composeClaudeInitializeRequest(policy),
        initializeDeadlineMs(legs.spawnEnvironment),
      );
      await this.#expectSuccess(claudeProcess, {
        subtype: "set_max_thinking_tokens",
        thinking_display: "summarized",
      });
      if (route !== undefined) {
        await this.#installToolServers(claudeProcess, legs, route);
      }
      return {
        providerSessionId,
        channel: claudeProcess,
        initialize: readInitializeDeclaration(initializeReply),
        settingsReadback: await this.#readSettingsReadback(claudeProcess),
      };
    } catch (error) {
      await claudeProcess.terminate();
      throw error;
    }
  }

  // Every tool server the person switched on, each on its own route; never `mcp_toggle`.
  async #installToolServers(
    claudeProcess: ClaudeCodeProcess,
    legs: ClaudeSpawnBoundLegs,
    route: ToolServerRoute,
  ): Promise<void> {
    const servers: Record<string, ClaudeHttpServerEntry> = {
      [DAEMON_TOOL_SERVER_NAME]: entryFor(route, legs.sessionId, DAEMON_TOOL_SERVER_NAME),
    };
    for (const toolServer of legs.toolServers) {
      if (toolServer.enabled) {
        servers[toolServer.serverName] = entryFor(route, legs.sessionId, toolServer.serverName);
      }
    }
    const reply = await this.#expectSuccess(claudeProcess, { subtype: "mcp_set_servers", servers });
    const errors = reply?.["errors"];
    if (!isPlainObject(errors) || legs.onMcpServerStatus === undefined) {
      return;
    }
    for (const serverName of Object.keys(errors)) {
      const emission = McpServerStatusEmissionSchema.safeParse({ serverName, status: "failed" });
      if (emission.success) {
        legs.onMcpServerStatus(emission.data);
      }
    }
  }

  async #readSettingsReadback(claudeProcess: ClaudeCodeProcess): Promise<ClaudeSettingsReadback> {
    const reply = await this.#expectSuccess(claudeProcess, { subtype: "get_settings" });
    const effective = reply?.["effective"];
    const cleanupPeriodDays = isPlainObject(effective) ? effective["cleanupPeriodDays"] : undefined;
    return {
      cleanupPeriodDays: typeof cleanupPeriodDays === "number" ? cleanupPeriodDays : null,
      attachedAdvisor: readClaudeAttachedAdvisor(reply),
    };
  }

  // A refusal while bringing a process up fails the spawn; nothing runs on a half-set process.
  async #expectSuccess(
    claudeProcess: ClaudeCodeProcess,
    request: ClaudeControlRequest,
    deadlineMs: number = CLAUDE_REQUEST_DEADLINE_MS,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await claudeProcess.sendControlRequestWithin(request, deadlineMs);
    if (response.subtype === "error") {
      throw new ClaudeControlRequestRefusedError(request.subtype, response.error);
    }
    return response.response;
  }
}

function entryFor(
  route: ToolServerRoute,
  sessionId: SessionId,
  serverName: string,
): ClaudeHttpServerEntry {
  return { type: "http", url: route.urlFor(sessionId, serverName) };
}
