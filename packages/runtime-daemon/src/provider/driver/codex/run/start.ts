// Starting a Codex turn for a run: the person's words and picked skill, the turn's model, window,
// speed and reviewer, and the route that lets the run's steers, interrupts and terminal find the
// turn. The permission profile is the thread's, so a turn carries only the level's reviewer. A turn
// the daemon starts itself, such as a review, a goal or `Allow once`, is started as the session's
// own run through the run engine before its request is sent, so every row of the turn has a run.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";

import type { CodexProviderCommandCache } from "../commands.js";
import type { CodexOutputSpeed } from "../output-speed.js";
import { composeCodexServiceTier } from "../output-speed.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import { composeCodexApprovalsReviewer } from "../permission-level.js";
import { parseCodexRunConfig } from "../session/config.js";
import { composeCodexCollaborationMode } from "../session/controls.js";
import {
  CodexProviderRequestError,
  CodexRequestTooLargeError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "../session/errors.js";
import type { CodexConfigForks } from "../session/config-fork.js";
import type { CodexConversationForks } from "../session/fork.js";
import type { CodexSessionSlots } from "../session/slots.js";
import {
  type CodexPickedSkill,
  type CodexRunEnginePort,
  type CodexSessionRecord,
  isTurnInFlight,
  newestActiveTurnForRun,
} from "../session/state.js";
import { readTurnId } from "../thread/view.js";
import {
  type CodexDiagnosticSink,
  type CodexScheduleTimeout,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { StartRunParams } from "../../contract.js";
import type { DaemonTurnBindingResolver } from "../../run-control.js";
import type { CodexRunRoutes } from "./routes.js";

// `turn/start` is believed to answer once the turn is accepted, so this matches the ordinary
// request deadline. Separate so a wrong reading is a configuration change, not a code change.
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/** One turn to start on a session's conversation for a run. */
export interface CodexTurnRequest {
  readonly runId: RunId;
  /** The person's messages, as typed, in send order. */
  readonly texts: readonly string[];
  /** The ids of those messages, which an undo's cut later names. */
  readonly clientMessageIds: readonly string[];
  readonly model: string | undefined;
  /**
   * The window the turn runs its model on, in tokens: a larger window as recorded when it was
   * picked, or `undefined` for the model's default window.
   */
  readonly modelContextWindow: number | undefined;
  readonly outputSpeed: string | undefined;
  /** A level for this turn alone; the thread keeps its own tier for the turns after it. */
  readonly outputSpeedForTurn: string | undefined;
  readonly outputSchema: Record<string, unknown> | undefined;
  /** The run's level, whose reviewer the turn carries; `undefined` keeps the thread's. */
  readonly level: PermissionLevel | undefined;
  /** The skill the person picked, sent beside the words. */
  readonly skill: CodexPickedSkill | undefined;
}

/**
 * Sends the request that makes Codex start a turn the daemon starts itself, and resolves with the
 * turn its reply names, or `undefined` when the reply names none and the turn's own `turn/started`
 * names it instead.
 */
export type CodexDaemonTurnOpening = (record: CodexSessionRecord) => Promise<string | undefined>;

/** What starting turns needs from the lifecycle. */
export interface CodexRunStartDependencies {
  readonly slots: CodexSessionSlots;
  readonly configForks: CodexConfigForks;
  readonly forks: Pick<CodexConversationForks, "bindFirstRun">;
  readonly runRoutes: CodexRunRoutes;
  readonly outputSpeed: CodexOutputSpeed;
  readonly providerCommands: CodexProviderCommandCache;
  readonly runEngine: Pick<CodexRunEnginePort, "startDaemonTurn">;
  readonly daemonTurnBindings: DaemonTurnBindingResolver;
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly scheduleTimeout: CodexScheduleTimeout;
  readonly turnStartTimeoutMs?: number | undefined;
}

/** Starts turns for runs and routes each accepted turn to its run. */
export class CodexRunStart {
  readonly #slots: CodexSessionSlots;
  readonly #configForks: CodexConfigForks;
  readonly #forks: CodexRunStartDependencies["forks"];
  readonly #runRoutes: CodexRunRoutes;
  readonly #outputSpeed: CodexOutputSpeed;
  readonly #providerCommands: CodexProviderCommandCache;
  readonly #runEngine: Pick<CodexRunEnginePort, "startDaemonTurn">;
  readonly #daemonTurnBindings: DaemonTurnBindingResolver;
  readonly #reportDiagnostic: CodexDiagnosticSink;
  // Each record's latest binding adoption, so a failed start undoes only an adoption no later
  // start has made since, even one adopting the same binding.
  readonly #latestAdoptions = new WeakMap<CodexSessionRecord, object>();
  readonly #scheduleTimeout: CodexScheduleTimeout;
  /** How long a turn's start may take before it counts as not started, in milliseconds. */
  readonly turnStartTimeoutMs: number;

  constructor(dependencies: CodexRunStartDependencies) {
    this.#slots = dependencies.slots;
    this.#configForks = dependencies.configForks;
    this.#forks = dependencies.forks;
    this.#runRoutes = dependencies.runRoutes;
    this.#outputSpeed = dependencies.outputSpeed;
    this.#providerCommands = dependencies.providerCommands;
    this.#runEngine = dependencies.runEngine;
    this.#daemonTurnBindings = dependencies.daemonTurnBindings;
    this.#reportDiagnostic = dependencies.reportDiagnostic;
    this.#scheduleTimeout = dependencies.scheduleTimeout;
    this.turnStartTimeoutMs = dependencies.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
  }

  /**
   * Starts one provider turn for a run from its agent config, on the binding the config names.
   * A run whose turn did not start keeps no binding, and the session keeps the one it had.
   */
  async startRun(params: StartRunParams): Promise<void> {
    const runConfig = parseCodexRunConfig(params.agentConfig);
    // A run arriving while the conversation forks onto its new config waits for the fork and runs
    // on it; a failed fork fails the run.
    await this.#configForks.join(runConfig.sessionId);
    const record = this.#slots.require(runConfig.sessionId);
    // Codex folds a turn sent onto a busy thread into the running one, which would then answer
    // for two runs; refused before anything is sent, so the caller may start it again.
    if (record.delivery.selfStartedTurnOpening !== undefined) {
      throw new CodexTransportError(
        `Codex session "${runConfig.sessionId}" is opening the run of a turn Codex started.`,
        { sessionId: runConfig.sessionId, runId: params.runId, reason: "session_turn_in_flight" },
      );
    }
    this.#runRoutes.bindRunDelivery(params.runId, {
      sessionId: runConfig.sessionId,
      bindingId: runConfig.bindingId,
      agentId: runConfig.agentId,
    });
    if (params.outputSpeedForTurn !== undefined) {
      this.#runRoutes.keepOutputSpeedForTurn(params.runId, params.outputSpeedForTurn);
    }
    // The run's binding is the one a fork during or after the turn's start points at the
    // conversation it moves to.
    const adoption = this.#adoptBinding(record, runConfig.bindingId);
    try {
      if (adoption.previousBindingId === undefined) {
        await this.#forks.bindFirstRun(record, runConfig.bindingId);
      }
      const skill =
        runConfig.skill === undefined
          ? undefined
          : await this.#providerCommands.readPickedSkill(record, runConfig.skill);
      await this.startTurn(record, {
        runId: params.runId,
        texts: [runConfig.input],
        clientMessageIds:
          runConfig.clientUserMessageId === undefined ? [] : [runConfig.clientUserMessageId],
        model: runConfig.model,
        // The window travels with the model: a turn naming neither keeps the conversation's.
        modelContextWindow:
          runConfig.model === undefined && runConfig.modelContextWindow === undefined
            ? record.threadSettings.modelContextWindow
            : runConfig.modelContextWindow,
        outputSpeed: params.outputSpeed,
        outputSpeedForTurn: params.outputSpeedForTurn,
        outputSchema: params.outputSchema,
        level: params.executionPosture?.mode,
        skill,
      });
    } catch (cause) {
      this.#runRoutes.forgetRun(params.runId);
      adoption.undo();
      throw cause;
    }
  }

  // Makes `bindingId` the session's binding, returning the one it had and an undo that restores it
  // only while this is still the record's latest adoption and the binding is still `bindingId`.
  #adoptBinding(
    record: CodexSessionRecord,
    bindingId: string,
  ): { readonly previousBindingId: string | undefined; readonly undo: () => void } {
    const previousBindingId = record.bindingId;
    const adoption = {};
    record.bindingId = bindingId;
    this.#latestAdoptions.set(record, adoption);
    return {
      previousBindingId,
      undo: () => {
        if (this.#latestAdoptions.get(record) === adoption && record.bindingId === bindingId) {
          record.bindingId = previousBindingId;
        }
      },
    };
  }

  /**
   * Starts one turn on `record` and routes it to the run, after the fork that moves the
   * conversation onto any config it still owes, which waits for a turn running on the session to
   * settle first. A clean refusal leaves the session usable; any other failure may hide an
   * accepted turn, so that turn is interrupted and the session's conversation let go, the service
   * staying, before the failure is rethrown.
   */
  async startTurn(record: CodexSessionRecord, turn: CodexTurnRequest): Promise<void> {
    const turnModel = turn.model ?? record.threadSettings.model;
    if (turn.modelContextWindow !== record.threadSettings.modelContextWindow) {
      // The window is chosen with the turn's model and reaches the conversation only by a fork,
      // which this turn runs first, so its failure fails the turn.
      record.threadSettings = {
        ...record.threadSettings,
        model: turnModel,
        modelContextWindow: turn.modelContextWindow,
      };
      record.isConfigForkOwed = true;
    }
    // The run's level wins and the thread's request is the fallback. Each turn resolves it
    // against the model's tier list afresh, since the catalog can change.
    const turnOutputSpeedRequest = turn.outputSpeed ?? record.outputSpeedRequest;
    const turnOutputSpeed = this.#outputSpeed.needsCatalogRead(turnOutputSpeedRequest)
      ? await this.#resolveTurnOutputSpeed(record, turnModel, turnOutputSpeedRequest)
      : turnOutputSpeedRequest;
    const turnAloneOutputSpeed = this.#outputSpeed.needsCatalogRead(turn.outputSpeedForTurn)
      ? await this.#resolveTurnOutputSpeed(record, turnModel, turn.outputSpeedForTurn)
      : turn.outputSpeedForTurn;
    // `turn/start` carries none of the config, so the conversation moves onto it first.
    await this.#configForks.forkBeforeTurn(record);
    // Frames of the turn that arrive before its answer belong to this run.
    record.delivery.startingTurnRunIds.push(turn.runId);
    let turnId: string;
    try {
      turnId = readTurnId(
        await record.service.request(
          "turn/start",
          {
            threadId: record.threadId,
            input: [
              ...turn.texts.map((text) => ({ type: "text", text, text_elements: [] })),
              ...(turn.skill === undefined
                ? []
                : [{ type: "skill", name: turn.skill.name, path: turn.skill.path }]),
            ],
            approvalsReviewer: composeCodexApprovalsReviewer(
              turn.level ?? record.threadSettings.level,
            ),
            // Every turn names its mode: Codex's own plan mode in Plan, its default in Build.
            collaborationMode: composeCodexCollaborationMode(
              record.sessionMode,
              turnModel,
              record.reasoningEffort,
            ),
            ...(turn.model === undefined ? {} : { model: turn.model }),
            ...(turn.clientMessageIds[0] === undefined
              ? {}
              : { clientUserMessageId: turn.clientMessageIds[0] }),
            ...(turn.outputSchema === undefined ? {} : { outputSchema: turn.outputSchema }),
            ...composeCodexServiceTier(turnOutputSpeed),
            // Codex applies it to this turn's copy of the settings only, after it keeps the
            // thread's, and reads `default` as standard.
            ...(turnAloneOutputSpeed === undefined
              ? {}
              : { serviceTierForTurn: turnAloneOutputSpeed }),
          },
          this.turnStartTimeoutMs,
        ),
        "turn/start",
      );
    } catch (cause) {
      this.#forgetStarting(record, turn.runId);
      if (isCleanTurnStartRefusal(cause)) {
        this.#noteStartSettled(record);
      } else {
        await this.#abandonUnclearTurn(record, turn.runId);
      }
      throw cause;
    }
    this.#forgetStarting(record, turn.runId);
    // One synchronous run from here, so one slot check covers the route install.
    if (!this.#slots.stillHolds(record)) {
      // Reached only via a transition begun after dispatch: the accepted turn would run with no
      // route to interrupt it, so the conversation is let go and the run refused.
      await this.#slots.dispose(record);
      throw new CodexTransportError(
        `Codex session "${record.sessionId}" stopped holding its slot while a turn was starting.`,
        { sessionId: record.sessionId, method: "turn/start" },
      );
    }
    // The provider applies a turn's model and tier from that turn on, so the thread now holds
    // them, and a resume after a crash sends them again.
    record.threadSettings = { ...record.threadSettings, model: turnModel };
    record.outputSpeedRequest = turnOutputSpeedRequest;
    this.#outputSpeed.armRunSettlement(record, turnId, turn.runId, turnOutputSpeed);
    for (const clientMessageId of turn.clientMessageIds) {
      record.turnIdByClientMessageId.set(clientMessageId, turnId);
    }
    if (this.#routeAcceptedTurn(record, turn.runId, turnId)) {
      record.turnInputByTurnId.set(turnId, {
        texts: turn.texts,
        clientMessageIds: turn.clientMessageIds,
        skill: turn.skill,
        outputSpeedForTurn: turn.outputSpeedForTurn,
      });
    } else {
      // The turn ended before its answer, while it still counted as starting.
      this.#noteStartSettled(record);
    }
  }

  /**
   * Starts a turn the daemon starts on a session itself as the session's own run, at the session's
   * current posture, and resolves with the run's id once Codex started the turn and the run is
   * running. Refused, before any run exists, while a turn runs or starts on the session: Codex
   * would fold it into that turn, which the queue holds it for instead. Throws as the opening's
   * request throws, and `CodexTransportError` when Codex started no turn within the turn-start
   * deadline; the run engine then ends the run failed. The run of a turn Codex started by itself
   * passes that turn's id, whose own opening is no turn in flight.
   */
  async startDaemonTurn(
    record: CodexSessionRecord,
    opening: CodexDaemonTurnOpening,
    selfStartedTurnId?: string,
  ): Promise<RunId> {
    const { sessionId } = record;
    if (isTurnInFlight(record, selfStartedTurnId)) {
      throw new CodexTransportError(
        `Codex session "${sessionId}" has a turn running, so a turn the daemon starts waits.`,
        { sessionId, reason: "session_turn_in_flight" },
      );
    }
    return await this.#runEngine.startDaemonTurn({
      sessionId,
      provider: CODEX_DRIVER_NAME,
      admittedProviderAccountId: record.providerAccountId ?? null,
      executionPosture: record.executionPosture,
      startTurn: async (runId) => {
        const binding = await this.#daemonTurnBindings.openDaemonTurnBinding(runId, sessionId);
        // A fork onto a changed config moves this record onto its new conversation in place, so
        // the turn waits for one in flight.
        await this.#configForks.join(sessionId);
        // Re-read after the awaits: a resume or close in that window replaced or retired it.
        if (!this.#slots.stillHolds(record)) {
          throw new CodexTransportError(
            `Codex session "${sessionId}" was re-established while its turn was starting.`,
            { sessionId, runId },
          );
        }
        // A run started in that window would take this turn's first frames.
        if (isTurnInFlight(record, selfStartedTurnId)) {
          throw new CodexTransportError(
            `Codex session "${sessionId}" started a turn while this one was starting.`,
            { sessionId, runId, reason: "session_turn_in_flight" },
          );
        }
        this.#runRoutes.bindRunDelivery(runId, { sessionId, ...binding });
        const adoption = this.#adoptBinding(record, binding.bindingId);
        try {
          if (adoption.previousBindingId === undefined) {
            await this.#forks.bindFirstRun(record, binding.bindingId);
          }
          // A turn Codex started itself already runs on the conversation as it is.
          if (selfStartedTurnId === undefined) {
            await this.#configForks.forkBeforeTurn(record);
          }
          await this.#openDaemonTurn(record, runId, opening);
        } catch (cause) {
          this.#runRoutes.forgetRun(runId);
          adoption.undo();
          throw cause;
        }
      },
    });
  }

  // Sends the opening with the run waiting as the turn starting next, so the turn's first frames
  // reach it whether they come before the reply or, for a reply that names no turn, instead of it.
  async #openDaemonTurn(
    record: CodexSessionRecord,
    runId: RunId,
    opening: CodexDaemonTurnOpening,
  ): Promise<void> {
    record.delivery.startingTurnRunIds.push(runId);
    const turnStarted = Promise.withResolvers<string | undefined>();
    const stopWaiting = this.#runRoutes.awaitTurnStart(runId, turnStarted.resolve);
    const cancelDeadline = this.#scheduleTimeout(() => {
      turnStarted.resolve(undefined);
    }, this.turnStartTimeoutMs);
    let repliedTurnId: string | undefined;
    try {
      repliedTurnId = await opening(record);
    } catch (cause) {
      stopWaiting();
      cancelDeadline();
      this.#forgetStarting(record, runId);
      if (isCleanTurnStartRefusal(cause)) {
        this.#noteStartSettled(record);
      } else {
        await this.#abandonUnclearTurn(record, runId);
      }
      throw cause;
    }
    const turnId = repliedTurnId ?? (await turnStarted.promise);
    stopWaiting();
    cancelDeadline();
    this.#forgetStarting(record, runId);
    if (turnId === undefined) {
      this.#noteStartSettled(record);
      throw new CodexTransportError(
        `Codex started no turn within ${this.turnStartTimeoutMs}ms of the request.`,
        { sessionId: record.sessionId, runId },
      );
    }
    if (!this.#routeAcceptedTurn(record, runId, turnId)) {
      this.#noteStartSettled(record);
    }
  }

  /**
   * Records an accepted turn's boundary and routes it to its run; `false` for a turn already over,
   * which gets no route, since nothing would ever retire it.
   */
  #routeAcceptedTurn(record: CodexSessionRecord, runId: RunId, turnId: string): boolean {
    // Appended at acceptance, not completion: a completion-time ledger would omit interrupted and
    // failed turns and misname later positions.
    if (!record.turnBoundaries.includes(turnId)) {
      record.turnBoundaries.push(turnId);
    }
    if (record.settledTurnIds.has(turnId)) {
      return false;
    }
    record.runIdByActiveTurnId.set(turnId, runId);
    this.#runRoutes.bindRun(runId, record.sessionId, turnId);
    return true;
  }

  // A start that left no turn running: a turn waiting on it, or a fork owed meanwhile, goes on,
  // since no turn's end will come to say so.
  #noteStartSettled(record: CodexSessionRecord): void {
    if (!isTurnInFlight(record)) {
      this.#configForks.noteTurnSettled(record);
    }
  }

  // A run's turn was answered or started, or its request failed, so its frames are no longer ones
  // whose turn is still starting.
  #forgetStarting(record: CodexSessionRecord, runId: RunId): void {
    const index = record.delivery.startingTurnRunIds.indexOf(runId);
    if (index >= 0) {
      record.delivery.startingTurnRunIds.splice(index, 1);
    }
  }

  /**
   * After a request that starts a turn whose outcome is unknown: the turn Codex may have accepted,
   * where its first frame named it, is interrupted, then the conversation is unsubscribed so
   * nothing of it runs on unseen. The service stays for its other conversations.
   */
  async #abandonUnclearTurn(record: CodexSessionRecord, runId: RunId): Promise<void> {
    const turnId = newestActiveTurnForRun(record, runId);
    if (turnId !== undefined && record.service.isRunning) {
      try {
        await record.service.request("turn/interrupt", { threadId: record.threadId, turnId });
      } catch (cause) {
        reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, {
          kind: "teardown-step-failed",
          step: "turn-interrupt",
          detail: normalizeProviderFailureDetail(cause),
        });
      }
    }
    await this.#slots.dispose(record);
  }

  /**
   * The level a turn carries, resolved before `turn/start` is sent. Throws `CodexTransportError`
   * when the session was re-established meanwhile.
   */
  async #resolveTurnOutputSpeed(
    record: CodexSessionRecord,
    turnModel: string,
    request: string | undefined,
  ): Promise<string | undefined> {
    const resolved = await this.#outputSpeed.resolveLevel(record.service, turnModel, request);
    // Re-read after the catalog read: a resume or close in that window replaced or retired this
    // record, and a turn on it would reach a conversation being let go.
    if (this.#slots.require(record.sessionId) !== record) {
      throw new CodexTransportError(
        `Codex session "${record.sessionId}" was re-established while its turn's output speed ` +
          `was being checked.`,
        { sessionId: record.sessionId, method: "turn/start" },
      );
    }
    return resolved;
  }
}

// A refusal that proves no turn started: the provider's own answer, or a request never sent.
function isCleanTurnStartRefusal(cause: unknown): boolean {
  return cause instanceof CodexProviderRequestError || cause instanceof CodexRequestTooLargeError;
}
