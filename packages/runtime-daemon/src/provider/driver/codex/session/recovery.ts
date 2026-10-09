// What happens to a service's conversations when the service ends, comes back, is restarted or
// moves to a new provider build: running turns end with the process, every conversation resumes
// once it runs again, and the sessions hear what happened through their notices. A build move waits
// for the old service to unload each conversation, because Codex refuses to resume one on the new
// service while the old one still writes it, and stops the old service only once the conversations
// held there for their running commands were let go.

import type { ProviderModel } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import { CODEX_DRIVER_NAME, normalizeCodexModelCatalog } from "../capabilities.js";
import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import { isPlainObject } from "../../../record-readers.js";
import type { CodexRunRoutes } from "../run/routes.js";
import type { CodexTurnEndWaiters } from "../run/turn-end-waiters.js";
import type { CodexServiceRegistry } from "../service/registry.js";
import type { CodexServiceRecoveryCause } from "../service/dependencies.js";
import type { CodexService } from "../service/supervisor.js";
import {
  type CodexScheduleTimeout,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { DriverResumeResult } from "../../contract.js";
import type { ProviderBuildChange } from "../../session-control.js";
import type { CodexConfigForks } from "./config-fork.js";
import type { CodexConversationRelease } from "./conversation-release.js";
import {
  CODEX_INVALID_REQUEST_CODE,
  CodexProviderRequestError,
  normalizeProviderFailureDetail,
} from "./errors.js";
import type { CodexInPlaceResume, CodexSessionEstablishment } from "./establishment.js";
import type { CodexListedTurn } from "./history.js";
import type { CodexSessionSlots } from "./slots.js";
import {
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexSessionRecord,
} from "./state.js";

/** `model/list`'s refusal when the service must restart before it can answer. */
const CODEX_RESTART_REQUESTED_MESSAGE = "Restart Codex";

/** The status `thread/read` gives a conversation its service no longer holds loaded. */
const CODEX_NOT_LOADED_STATUS = "notLoaded";

/** A turn status that is no end: the turn still runs. */
const CODEX_IN_PROGRESS_STATUS = "inProgress";

// A conversation's move to a new build, waiting for its running reply to end.
interface CodexPendingBuildMove {
  readonly from: CodexService;
  readonly move: () => void;
}

/** What recovery reports to and resumes through. */
export interface CodexServiceRecoveryDependencies {
  readonly options: Pick<
    CodexLifecycleOptions,
    | "runEngine"
    | "onSessionRelaunched"
    | "onLostRunFailure"
    | "diagnostics"
    | "reportDiagnostic"
    | "orderRecovery"
  >;
  readonly slots: CodexSessionSlots;
  readonly establishment: CodexSessionEstablishment;
  readonly services: CodexServiceRegistry;
  readonly runRoutes: CodexRunRoutes;
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly dispatch: CodexDeliveryDispatch;
  readonly turnEnds: CodexTurnEndWaiters;
  readonly release: CodexConversationRelease;
  readonly configForks: Pick<CodexConfigForks, "stopWaiting">;
  readonly scheduleTimeout: CodexScheduleTimeout;
  /** How long a conversation may take to unload before its move goes on, in milliseconds. */
  readonly unloadTimeoutMs: number;
  /** Takes a turn's end that Codex listed after a gap as if its `turn/completed` arrived. */
  readonly deliverTurnEnd: (sessionId: SessionId, params: unknown) => void;
}

/** Keeps each service's conversations through its crashes, restarts and build moves. */
export class CodexServiceRecovery {
  readonly #dependencies: CodexServiceRecoveryDependencies;
  readonly #options: CodexServiceRecoveryDependencies["options"];
  // The sessions whose running turn a service's last crash ended, owed `provider_restarted`.
  readonly #endedByCrash = new Map<CodexService, Set<SessionId>>();
  // The sessions a service's crash loop told it stayed down, owed `provider_restarted` too.
  readonly #heldByCrashLoop = new Map<CodexService, Set<SessionId>>();
  // Sessions waiting for their running reply to end before their conversation moves.
  readonly #movesAwaitingIdle = new Map<SessionId, CodexPendingBuildMove>();
  // Services a build move left, waiting for their held conversations to be let go.
  readonly #retiring = new Set<CodexService>();

  constructor(dependencies: CodexServiceRecoveryDependencies) {
    this.#dependencies = dependencies;
    this.#options = dependencies.options;
  }

  /** Ends every turn the service held with its process; the conversations stay to be resumed. */
  onProcessExited(service: CodexService, exit: ProcessExit): void {
    const ended = this.#endedByCrash.get(service) ?? new Set<SessionId>();
    for (const record of this.#dependencies.slots.recordsOn(service)) {
      const runIds = this.#dropTurns(record);
      if (runIds.size > 0) {
        ended.add(record.sessionId);
      }
      for (const runId of runIds) {
        this.#options.runEngine.endTurnOnProcessExit(runId, exit).catch((cause: unknown) => {
          this.#reportPortFailure("run-end", record.sessionId, cause);
        });
      }
    }
    this.#endedByCrash.set(service, ended);
  }

  /** Resumes every conversation of a service that runs again without anyone asking. */
  onRecovered(service: CodexService, cause: CodexServiceRecoveryCause): void {
    this.resumeAll(service, cause).then(
      () => {
        if (cause === "crash") {
          this.#announceRestarted(service, this.#endedByCrash.get(service));
          this.#endedByCrash.delete(service);
        }
      },
      (failure: unknown) => {
        this.#reportPortFailure("session-relaunched", undefined, failure);
      },
    );
  }

  /** Tells every session on a service that stays down after its crash window filled. */
  onCrashLoop(service: CodexService, exit: ProcessExit): void {
    const held = new Set<SessionId>();
    for (const record of this.#dependencies.slots.recordsOn(service)) {
      held.add(record.sessionId);
      this.#dependencies.dispatch.sendNotice(
        {
          sessionId: record.sessionId,
          kind: "provider_crash_loop",
          provider: CODEX_DRIVER_NAME,
          ...(exit.signal === undefined ? { exitCode: exit.exitCode } : { signal: exit.signal }),
        },
        null,
      );
    }
    this.#heldByCrashLoop.set(service, held);
    this.#endedByCrash.delete(service);
  }

  /**
   * The person's own service can no longer be reached: its running turns are lost, their runs
   * fail, and the conversations wait for a restart.
   */
  onServiceLost(service: CodexService, detail: string): void {
    this.#loseTurns(
      service,
      `The connection to the Codex service in the person's own Codex folder was lost and ` +
        `could not be opened again (${detail}).`,
    );
  }

  /**
   * Resumes every conversation the service holds, in the order the daemon gives, each inside its
   * session's slot, and writes one diagnostic naming the account and the conversations.
   * `except` is a session its caller resumes itself. After a reconnect the conversations held for
   * their running commands are subscribed to again first; after a restart they ended with it.
   */
  async resumeAll(
    service: CodexService,
    cause: CodexServiceRecoveryCause | "restart",
    except?: SessionId,
  ): Promise<void> {
    if (cause === "reconnect") {
      await this.#dependencies.release.resubscribeService(service);
    } else {
      this.#dependencies.release.forgetService(service);
    }
    const records = this.#ordered(this.#dependencies.slots.recordsOn(service)).filter(
      (record) => record.sessionId !== except,
    );
    for (const record of records) {
      const resumed = await this.#dependencies.slots.claim(
        record.sessionId,
        "establishing",
        async (): Promise<CodexInPlaceResume | undefined> =>
          // A session closed or established anew while it waited stays as it is now.
          this.#dependencies.slots.recordFor(record.sessionId) === record
            ? await this.#dependencies.establishment.resumeInPlace(record, service)
            : undefined,
      );
      if (resumed !== undefined) {
        this.#options.onSessionRelaunched(record.sessionId, resumed.result);
        this.#endTurnsEndedUnseen(record, resumed.listedTurns);
      }
    }
    if (cause === "reconnect") {
      // Nothing restarted: the connection came back to a service that kept running.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "service-reconnected",
        codexHome: service.home.codexHome,
        conversations: records.map((record) => record.threadId),
      });
      return;
    }
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      providerAccountId: service.home.providerAccountId,
      kind: "provider_restarted",
      rawWireType: null,
      dispositionReason: `the Codex service restarted after a ${cause}; conversations resumed`,
      details: {
        codexHome: service.home.codexHome,
        cause,
        conversations: records.map((record) => record.threadId).join(","),
      },
    });
  }

  /**
   * The person's restart of a service that stayed down: the crash window is forgotten, the
   * service starts, every other conversation resumes, then the called session does. Each session
   * the crash loop held hears it runs again.
   */
  async restart(
    service: CodexService,
    calledSessionId: SessionId,
    resumeCalled: () => Promise<DriverResumeResult>,
  ): Promise<DriverResumeResult> {
    service.clearCrashWindow();
    await service.ensureStarted();
    await this.resumeAll(service, "restart", calledSessionId);
    const result = await resumeCalled();
    this.#announceRestarted(service, this.#heldByCrashLoop.get(service));
    this.#heldByCrashLoop.delete(service);
    return result;
  }

  /**
   * The service's model catalog. A refusal asking for a restart restarts the service, resumes
   * its conversations and reads once more; any other failure propagates.
   */
  async readModelCatalog(service: CodexService): Promise<ProviderModel[]> {
    await service.ensureStarted();
    try {
      return normalizeCodexModelCatalog(await service.request("model/list", {}));
    } catch (cause) {
      if (!asksForRestart(cause)) {
        throw cause;
      }
      // The restart ends the process the daemon's own way, so no crash ends its turns. The
      // person's own service is only connected to again, and its turns run on.
      if (service.home.isManaged) {
        this.#loseTurns(
          service,
          "The Codex service restarted because it asked to before listing models.",
        );
      }
      await service.restart();
      await this.resumeAll(service, service.home.isManaged ? "restart" : "reconnect");
      return normalizeCodexModelCatalog(await service.request("model/list", {}));
    }
  }

  /**
   * Moves every conversation on the app's services onto a second service started on the new
   * build: an idle one at once, a busy one when its running reply ends. The old service stops once
   * it holds none. The person's own service is not the daemon's to start, so it stays as it is.
   */
  async moveToProviderBuild(change: ProviderBuildChange): Promise<void> {
    for (const service of this.#dependencies.services.services()) {
      const records = this.#dependencies.slots.recordsOn(service);
      if (!service.home.isManaged || records.length === 0) {
        continue;
      }
      const replacement = this.#dependencies.services.replace(service);
      await replacement.ensureStarted();
      for (const record of records) {
        this.#whenIdle(record, {
          from: service,
          move: () => {
            this.#move(record, service, replacement, change).catch((failure: unknown) => {
              this.#reportPortFailure("session-relaunched", record.sessionId, failure);
            });
          },
        });
      }
    }
  }

  /**
   * Drops a closed session's waiting move; the old service stops once the session was the last it
   * held and no conversation is held there for its commands.
   */
  forgetSession(sessionId: SessionId): void {
    const pending = this.#movesAwaitingIdle.get(sessionId);
    this.#movesAwaitingIdle.delete(sessionId);
    if (pending !== undefined) {
      this.#retireWhenEmpty(pending.from);
    }
  }

  /** Tells recovery a session's turn settled, so a move waiting for its reply goes ahead. */
  noteTurnSettled(record: CodexSessionRecord): void {
    if (record.runIdByActiveTurnId.size > 0) {
      return;
    }
    const pending = this.#movesAwaitingIdle.get(record.sessionId);
    if (pending !== undefined) {
      this.#movesAwaitingIdle.delete(record.sessionId);
      pending.move();
    }
  }

  #whenIdle(record: CodexSessionRecord, pending: CodexPendingBuildMove): void {
    if (record.runIdByActiveTurnId.size === 0) {
      pending.move();
      return;
    }
    this.#movesAwaitingIdle.set(record.sessionId, pending);
  }

  /**
   * One conversation's move to the new build: it leaves `from`, which unloads it once idle, and is
   * resumed on `to` with the settings the record holds now. Codex refuses the resume while the old
   * service still writes the conversation, so it is tried again once that unloaded, all within one
   * deadline. The session hears its new build.
   */
  async #move(
    record: CodexSessionRecord,
    from: CodexService,
    to: CodexService,
    change: ProviderBuildChange,
  ): Promise<void> {
    const resumed = await this.#dependencies.slots.claim(
      record.sessionId,
      "establishing",
      async (): Promise<CodexInPlaceResume | undefined> => {
        // A session closed or established anew while it waited stays as it is now.
        if (this.#dependencies.slots.recordFor(record.sessionId) !== record) {
          return undefined;
        }
        const deadline = Promise.withResolvers<false>();
        const cancelDeadline = this.#dependencies.scheduleTimeout(() => {
          deadline.resolve(false);
        }, this.#dependencies.unloadTimeoutMs);
        try {
          this.#dependencies.release.releaseSessionThreads(from, record.sessionId);
          try {
            await from.request("thread/unsubscribe", { threadId: record.threadId });
          } catch (cause) {
            reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
              kind: "teardown-step-failed",
              step: "thread-unsubscribe",
              detail: normalizeProviderFailureDetail(cause),
            });
          }
          const awaitUnloaded = async (): Promise<boolean> =>
            await this.#awaitUnloaded(from, record.threadId, deadline.promise);
          if (!(await awaitUnloaded())) {
            // Another client, such as a terminal the person joined, still holds it on the old
            // service; the resume goes ahead and Codex decides.
            reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
              kind: "conversation-unload-timed-out",
              threadId: record.threadId,
            });
          }
          return await this.#dependencies.establishment.resumeInPlace(record, to, awaitUnloaded);
        } finally {
          cancelDeadline();
        }
      },
    );
    if (resumed !== undefined) {
      this.#options.onSessionRelaunched(record.sessionId, resumed.result);
      if (resumed.result.status === "resumed") {
        this.#dependencies.dispatch.sendNotice(
          {
            sessionId: record.sessionId,
            kind: "provider_updated",
            provider: CODEX_DRIVER_NAME,
            fromVersion: change.fromVersion,
            toVersion: change.toVersion,
          },
          null,
        );
      }
    }
    this.#retireWhenEmpty(from);
  }

  /**
   * Waits until `from` no longer holds the conversation loaded: each `thread/closed` is confirmed
   * with `thread/read`, since a close can be stale. `false` when the deadline came first.
   */
  async #awaitUnloaded(
    from: CodexService,
    threadId: string,
    deadline: Promise<false>,
  ): Promise<boolean> {
    for (;;) {
      // Armed before the read, so a close between the two is not missed.
      const wait = from.waitForThreadClosed(threadId);
      try {
        if (await this.#isUnloaded(from, threadId)) {
          return true;
        }
        if (!(await Promise.race([wait.closed.then(() => true), deadline]))) {
          return false;
        }
      } finally {
        wait.stopWaiting();
      }
    }
  }

  async #isUnloaded(from: CodexService, threadId: string): Promise<boolean> {
    if (!from.isRunning) {
      // A service that stopped holds nothing loaded.
      return true;
    }
    let reply: unknown;
    try {
      reply = await from.request("thread/read", { threadId });
    } catch (cause) {
      // Unconfirmed, so the resume decides: Codex refuses it while the conversation is still
      // written elsewhere, and that refusal waits again.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "conversation-unload-unconfirmed",
        threadId,
        detail: normalizeProviderFailureDetail(cause),
      });
      return true;
    }
    const thread = isPlainObject(reply) ? reply["thread"] : undefined;
    const status = isPlainObject(thread) ? thread["status"] : undefined;
    return isPlainObject(status) && status["type"] === CODEX_NOT_LOADED_STATUS;
  }

  // Stops a service a build move left once no session is on it and no conversation is held there
  // for its commands, which would end with it.
  #retireWhenEmpty(service: CodexService): void {
    if (this.#dependencies.slots.recordsOn(service).length > 0 || this.#retiring.has(service)) {
      return;
    }
    this.#retiring.add(service);
    void this.#dependencies.release
      .whenNoneHeldOn(service)
      .then(async () => {
        await this.#dependencies.services.retire(service);
      })
      .catch((cause: unknown) => {
        reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
          kind: "teardown-step-failed",
          step: "service-stop",
          detail: normalizeProviderFailureDetail(cause),
        });
      })
      .finally(() => {
        this.#retiring.delete(service);
      });
  }

  /**
   * Ends the run of each turn the record still owes an end that Codex listed as over: its
   * `turn/completed` was sent while the daemon was not connected, and Codex sends none again.
   */
  #endTurnsEndedUnseen(record: CodexSessionRecord, listedTurns: readonly CodexListedTurn[]): void {
    for (const listed of listedTurns) {
      const isOwed =
        record.runIdByActiveTurnId.has(listed.id) ||
        record.interruptedRunIdByTurnId.has(listed.id) ||
        record.pausedRunIdByInterruptedTurnId.has(listed.id) ||
        record.delivery.retriedRunIdByTurnId.has(listed.id);
      if (isOwed && listed.turn["status"] !== CODEX_IN_PROGRESS_STATUS) {
        this.#dependencies.deliverTurnEnd(record.sessionId, {
          threadId: record.threadId,
          turn: listed.turn,
        });
      }
    }
  }

  /** Fails the run of every turn a service held, for an end no process exit reports. */
  #loseTurns(service: CodexService, providerFailureDetail: string): void {
    for (const record of this.#dependencies.slots.recordsOn(service)) {
      for (const runId of this.#dropTurns(record)) {
        this.#options.onLostRunFailure(record.sessionId, runId, {
          eventType: "run.failed",
          failureCategory: "provider failure",
          recoveryCondition: "recovery-needed",
          providerFailureDetail,
        });
      }
    }
  }

  /**
   * Drops every turn a record held, its routes, pauses, retries, compaction waits and
   * turn-end waits with them, and answers the runs those turns belonged to.
   */
  #dropTurns(record: CodexSessionRecord): Set<RunId> {
    const runIds = new Set<RunId>([
      ...record.runIdByActiveTurnId.values(),
      ...record.interruptedRunIdByTurnId.values(),
      ...record.pausedRunIdByInterruptedTurnId.values(),
      ...record.delivery.retriedRunIdByTurnId.values(),
    ]);
    record.runIdByActiveTurnId.clear();
    record.interruptedRunIdByTurnId.clear();
    record.pausedRunIdByInterruptedTurnId.clear();
    record.delivery.retriedRunIdByTurnId.clear();
    record.continuesAwaitingPause.clear();
    record.pauseRunIdByTurnId.clear();
    this.#dependencies.runRoutes.forgetRunRoutes(record.sessionId);
    this.#dependencies.pendingCompactions.releaseBinding(
      codexCompactionWaitKey(record.sessionId, record.threadId),
    );
    // No turn of the record will end now, so an undo, a retry or a turn owing a fork waiting on
    // one stops waiting.
    this.#dependencies.turnEnds.abandon(record);
    this.#dependencies.configForks.stopWaiting(record);
    return runIds;
  }

  #announceRestarted(service: CodexService, sessionIds: ReadonlySet<SessionId> | undefined): void {
    for (const sessionId of sessionIds ?? []) {
      if (this.#dependencies.slots.recordFor(sessionId)?.service === service) {
        this.#dependencies.dispatch.sendNotice(
          {
            sessionId,
            kind: "provider_restarted",
            provider: CODEX_DRIVER_NAME,
          },
          null,
        );
      }
    }
  }

  #ordered(records: CodexSessionRecord[]): CodexSessionRecord[] {
    const order = this.#options.orderRecovery;
    if (order === undefined) {
      return records;
    }
    const bySession = new Map(records.map((record) => [record.sessionId, record]));
    const ordered = order([...bySession.keys()]).flatMap((sessionId) => {
      const record = bySession.get(sessionId);
      bySession.delete(sessionId);
      return record === undefined ? [] : [record];
    });
    // A session the order left out still resumes, after the rest.
    return [...ordered, ...bySession.values()];
  }

  #reportPortFailure(
    port: "run-end" | "session-relaunched",
    sessionId: SessionId | undefined,
    cause: unknown,
  ): void {
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "port-delivery-failed",
      port,
      sessionId: sessionId ?? null,
      detail: normalizeProviderFailureDetail(cause),
    });
  }
}

/** Whether a `model/list` refusal asks for the service to restart before it can answer. */
function asksForRestart(cause: unknown): boolean {
  return (
    cause instanceof CodexProviderRequestError &&
    cause.providerErrorCode === CODEX_INVALID_REQUEST_CODE &&
    cause.providerMessage.includes(CODEX_RESTART_REQUESTED_MESSAGE)
  );
}
