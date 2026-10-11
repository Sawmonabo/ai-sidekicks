// Starting a Codex turn for a run: the person's words, picked skills and staged files, the turn's
// model, window, speed and reviewer, and the route that lets the run's steers, interrupts and
// terminal find the turn. The permission profile is the thread's, so a turn carries only the
// level's reviewer. A turn the daemon starts itself, such as a review, a goal or `Allow once`, is
// started as the session's own run through the run engine before its request is sent, so every
// row of the turn has a run. Codex runs a turn the daemon stopped until its end arrives, so no
// turn starts before that end, every wait of one start sharing the start's own deadline.

import type { InterruptRunParams } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { composeCodexMessageInput } from "../attachments.js";
import type { CodexOutputSpeed } from "../output-speed.js";
import { composeCodexServiceTier } from "../output-speed.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import { composeCodexApprovalsReviewer } from "../permission-level.js";
import { type CodexRunConfig, parseCodexRunConfig } from "../session/config.js";
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
  type CodexRunEnginePort,
  type CodexSessionRecord,
  type CodexTurnMessage,
  endingTurnIds,
  isTurnInFlight,
  newestActiveTurnForRun,
} from "../session/state.js";
import { readTurnId } from "../thread/view.js";
import {
  type CodexDiagnosticSink,
  type CodexScheduleTimeout,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import { KeyedLock } from "../../../../keyed-lock.js";
import { resolveMessageAttachments, type AttachmentResolver } from "../../attachments.js";
import type { StartRunParams } from "../../contract.js";
import type { DaemonTurnBindingResolver } from "../../run-control.js";
import type { CodexRunRoutes } from "./routes.js";
import type { CodexTurnEndDeadline, CodexTurnEndWaiters } from "./turn-end-waiters.js";

// `turn/start` is believed to answer once the turn is accepted, so this matches the ordinary
// request deadline. Separate so a wrong reading is a configuration change, not a code change.
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/** One turn to start on a session's conversation for a run. */
export interface CodexTurnRequest {
  readonly runId: RunId;
  /** The person's messages, as typed and with their skills and files, in send order. */
  readonly messages: readonly CodexTurnMessage[];
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
  /**
   * Read right before the turn is sent: `true` sends nothing and refuses the start, for a start
   * its run's interrupt withdrew.
   */
  readonly isWithdrawn?: () => boolean;
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
  readonly runEngine: Pick<CodexRunEnginePort, "startDaemonTurn">;
  readonly daemonTurnBindings: DaemonTurnBindingResolver;
  readonly attachments: AttachmentResolver;
  readonly turnEnds: Pick<CodexTurnEndWaiters, "openDeadline" | "waitForStoppedTurns">;
  /** The driver's interrupt of a run's live turn. */
  readonly interruptRun: (params: InterruptRunParams) => Promise<void>;
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
  readonly #runEngine: Pick<CodexRunEnginePort, "startDaemonTurn">;
  readonly #daemonTurnBindings: DaemonTurnBindingResolver;
  readonly #attachments: AttachmentResolver;
  readonly #turnEnds: CodexRunStartDependencies["turnEnds"];
  readonly #interruptRun: CodexRunStartDependencies["interruptRun"];
  readonly #reportDiagnostic: CodexDiagnosticSink;
  // Each record's latest binding adoption, so a failed start undoes only an adoption no later
  // start has made since, even one adopting the same binding.
  readonly #latestAdoptions = new WeakMap<CodexSessionRecord, object>();
  // Each session's turn starts and the requests sent apart from them, one at a time.
  readonly #turnSends = new KeyedLock<SessionId>();
  readonly #scheduleTimeout: CodexScheduleTimeout;
  /** How long a turn's start may take before it counts as not started, in milliseconds. */
  readonly turnStartTimeoutMs: number;

  constructor(dependencies: CodexRunStartDependencies) {
    this.#slots = dependencies.slots;
    this.#configForks = dependencies.configForks;
    this.#forks = dependencies.forks;
    this.#runRoutes = dependencies.runRoutes;
    this.#outputSpeed = dependencies.outputSpeed;
    this.#runEngine = dependencies.runEngine;
    this.#daemonTurnBindings = dependencies.daemonTurnBindings;
    this.#attachments = dependencies.attachments;
    this.#turnEnds = dependencies.turnEnds;
    this.#interruptRun = dependencies.interruptRun;
    this.#reportDiagnostic = dependencies.reportDiagnostic;
    this.#scheduleTimeout = dependencies.scheduleTimeout;
    this.turnStartTimeoutMs = dependencies.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
  }

  /**
   * Starts one provider turn for a run from its agent config, on the binding the config names,
   * once Codex ended every turn the daemon is stopping, and after a turn Codex started by itself
   * as {@link startTurn} waits it out, every wait within one turn-start deadline. A run whose turn
   * did not start keeps no binding, and the session keeps the one it had.
   */
  async startRun(params: StartRunParams): Promise<void> {
    const runConfig = parseCodexRunConfig(params.agentConfig);
    // A run arriving while the conversation forks onto its new config waits for the fork and runs
    // on it; a failed fork fails the run.
    await this.#configForks.join(runConfig.sessionId);
    const record = this.#slots.require(runConfig.sessionId);
    const deadline = this.#turnEnds.openDeadline(this.turnStartTimeoutMs);
    try {
      await this.#startRunTurn(record, runConfig, params, deadline);
    } finally {
      deadline.close();
    }
  }

  async #startRunTurn(
    record: CodexSessionRecord,
    runConfig: CodexRunConfig,
    params: StartRunParams,
    deadline: CodexTurnEndDeadline,
  ): Promise<void> {
    // Before the run's binding is recorded: the end of its own interrupted turn forgets it.
    await this.#waitOutStoppedTurns(record, params.runId, deadline);
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
      const attachments = await resolveMessageAttachments(
        this.#attachments,
        record.sessionId,
        runConfig.attachments,
      );
      await this.#startTurn(
        record,
        {
          runId: params.runId,
          messages: [
            {
              text: runConfig.input,
              skills: runConfig.skills ?? [],
              attachments,
            },
          ],
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
        },
        deadline,
      );
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
   * settle first. Right before the turn is sent, every turn the daemon is stopping is waited on to
   * end, one Codex started by itself whose run did not open among them, and the opening of one
   * whose run is opening is waited for, all within one turn-start deadline, past which this turn
   * is refused with `session_turn_in_flight`, nothing sent; so is it while a turn Codex started
   * whose run opened still runs. A clean refusal leaves the session usable; any other failure may
   * hide an accepted turn, so that turn is interrupted and the session's conversation let go, the
   * service staying, before the failure is rethrown.
   */
  async startTurn(record: CodexSessionRecord, turn: CodexTurnRequest): Promise<void> {
    const deadline = this.#turnEnds.openDeadline(this.turnStartTimeoutMs);
    try {
      await this.#startTurn(record, turn, deadline);
    } finally {
      deadline.close();
    }
  }

  /**
   * Runs `send` while no turn of `record`'s session is being sent or awaits Codex's answer, and
   * holds the session's turn starts until it settles: for a request, such as a goal, that changes
   * what Codex starts next.
   */
  async sendApartFromTurnStarts<T>(record: CodexSessionRecord, send: () => Promise<T>): Promise<T> {
    return await this.#turnSends.run(record.sessionId, send);
  }

  // {@link startTurn}, its waits bound by the start's `deadline`.
  async #startTurn(
    record: CodexSessionRecord,
    turn: CodexTurnRequest,
    deadline: CodexTurnEndDeadline,
  ): Promise<void> {
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
    // `turn/start` carries none of the config, so the conversation moves onto it first. Codex folds
    // a turn sent onto a busy thread into the running one, so a turn the daemon is stopping and a
    // turn Codex started by itself are waited out after every await, the fork run again for a
    // change owed meanwhile. The bounded wait for a stopped turn comes first, since the fork waits
    // for the session's turns to settle with no deadline.
    await this.#waitOutStoppedTurns(record, turn.runId, deadline);
    await this.#configForks.forkBeforeTurn(record);
    // One turn is sent at a time, and a request that changes what Codex starts next goes apart from
    // it, so neither reaches Codex before the other is answered.
    await this.#turnSends.run(record.sessionId, async () => {
      while (hasSelfStartedTurn(record) || endingTurnIds(record).length > 0) {
        await this.#waitOutStoppedTurns(record, turn.runId, deadline);
        // A run opening for a turn Codex started is waited for; one that did not open leaves a turn
        // being stopped, which the next pass waits on.
        await record.delivery.selfStartedTurnOpening?.opened;
        await this.#configForks.forkBeforeTurn(record);
      }
      // A turn Codex started whose run opened meanwhile holds the session, so nothing is sent.
      if (
        [...record.delivery.selfStartedTurnIds].some((id) => record.runIdByActiveTurnId.has(id))
      ) {
        throw new CodexTransportError(
          `Codex session "${record.sessionId}" runs a turn Codex started, so this one waits.`,
          { sessionId: record.sessionId, runId: turn.runId, reason: "session_turn_in_flight" },
        );
      }
      if (turn.isWithdrawn?.() === true) {
        throw new CodexTransportError(
          `The turn of run "${turn.runId}" was withdrawn before it went.`,
          {
            sessionId: record.sessionId,
            runId: turn.runId,
          },
        );
      }
      // Frames of the turn that arrive before its answer belong to this run.
      record.delivery.startingTurnRunIds.push(turn.runId);
      let turnId: string;
      try {
        turnId = readTurnId(
          await record.service.request(
            "turn/start",
            {
              threadId: record.threadId,
              input: composeCodexMessageInput(turn.messages),
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
          messages: turn.messages,
          clientMessageIds: turn.clientMessageIds,
          outputSpeedForTurn: turn.outputSpeedForTurn,
        });
      } else {
        // The turn ended before its answer, while it still counted as starting.
        this.#noteStartSettled(record);
      }
    });
  }

  /**
   * Starts a turn the daemon starts on a session itself as the session's own run, at the session's
   * current posture, and resolves with the run's id once Codex started the turn and the run is
   * running. Refused, before any run exists, while a turn runs, starts or is still ending on the
   * session: Codex would fold it into that turn, which the queue holds it for instead; and so is a
   * turn the daemon starts while the session holds its next turn for an interrupted run's
   * continue. Throws as the opening's request throws, and `CodexTransportError` when Codex started
   * no turn within the turn-start deadline; the run engine then ends the run failed. The run of a
   * turn Codex started by itself passes that turn's id, whose own opening is no turn in flight.
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
      isProviderStarted: selfStartedTurnId !== undefined,
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
          // Checked after the last await: a turn started or starting in that window, Codex's own
          // among them, would take this turn's first frames, and Codex would fold this one into it.
          if (isTurnInFlight(record, selfStartedTurnId)) {
            throw new CodexTransportError(
              `Codex session "${sessionId}" started a turn while this one was starting.`,
              { sessionId, runId, reason: "session_turn_in_flight" },
            );
          }
          await this.#openDaemonTurn(record, runId, opening);
        } catch (cause) {
          this.#runRoutes.forgetRun(runId);
          adoption.undo();
          throw cause;
        }
      },
      // A turn that already ended before its run could be recorded has nothing left to stop.
      interruptTurn: async (runId) => {
        if (newestActiveTurnForRun(record, runId) !== undefined) {
          await this.#interruptRun({ runId });
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

  // Waits for every turn the daemon is stopping to end within `deadline`, or refuses this turn
  // with `session_turn_in_flight`.
  async #waitOutStoppedTurns(
    record: CodexSessionRecord,
    runId: RunId,
    deadline: CodexTurnEndDeadline,
  ): Promise<void> {
    if (!(await this.#turnEnds.waitForStoppedTurns(record, deadline))) {
      throw new CodexTransportError(
        `Codex did not end a turn it was stopping on session "${record.sessionId}" in time.`,
        { sessionId: record.sessionId, runId, reason: "session_turn_in_flight" },
      );
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

// Whether a turn Codex started by itself is opening its run or runs on with none.
function hasSelfStartedTurn(record: CodexSessionRecord): boolean {
  return (
    record.delivery.selfStartedTurnOpening !== undefined || record.delivery.unownedTurnIds.size > 0
  );
}

// A refusal that proves no turn started: the provider's own answer, or a request never sent.
function isCleanTurnStartRefusal(cause: unknown): boolean {
  return cause instanceof CodexProviderRequestError || cause instanceof CodexRequestTooLargeError;
}
