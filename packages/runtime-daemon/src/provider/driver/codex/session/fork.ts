// Forking a Codex conversation: the whole of it, onto a changed config or at a daemon restart; to
// a recorded boundary, for a rewind; or to just before a held turn, for the faster-model retry. A
// fork is a new thread carrying every setting the session holds. The session's runtime binding is
// pointed at it as soon as it answers, so a daemon restart resumes the fork, and the conversation
// the session leaves is let go once no command of it runs.

import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import type { LeftConversation } from "../../../left-conversations.js";
import type { CodexNotificationRouting } from "../notification-routing.js";
import { composeCodexServiceTier, type CodexOutputSpeed } from "../output-speed.js";
import type { CodexService } from "../service/supervisor.js";
import { composeCodexThreadParams } from "../thread/settings.js";
import { composeCodexThreadPermissionProfiles } from "../thread/permission-profiles.js";
import { assertCodexThreadProfile, readThread, readThreadReasoningEffort } from "../thread/view.js";
import { reportDiagnosticFromDetachedFrame } from "../transport/diagnostics.js";
import {
  MoveSessionToForkResultSchema,
  type MoveSessionToForkParams,
  type MoveSessionToForkResult,
} from "../../contract.js";
import {
  type CodexConversationRelease,
  unsubscribeCodexThreadQuietly,
} from "./conversation-release.js";
import { updateCodexSessionMode } from "./controls.js";
import { classifyRewindForkFailure, CodexTransportError } from "./errors.js";
import { readCodexTurns } from "./history.js";
import type { CodexSessionSlots } from "./slots.js";
import {
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexSessionRecord,
} from "./state.js";

/** A new thread a fork answered: its reply and its turn ids, oldest first. */
export interface CodexForkedThread {
  readonly response: unknown;
  readonly threadId: string;
  readonly turnIds: string[];
}

/** What a fork is composed from: the session's settings, its speed request and its mode. */
export type CodexForkSource = Pick<
  CodexSessionRecord,
  "sessionId" | "threadSettings" | "outputSpeedRequest" | "sessionMode"
>;

/** What the forks read and write. */
export interface CodexConversationForksDependencies {
  readonly options: Pick<
    CodexLifecycleOptions,
    "reportDiagnostic" | "toolServerRoute" | "rebindRuntimeBinding"
  >;
  readonly slots: CodexSessionSlots;
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly outputSpeed: CodexOutputSpeed;
  readonly notificationRouting: CodexNotificationRouting;
  readonly release: CodexConversationRelease;
}

/** Forks a session's conversation and moves the session onto the fork. */
export class CodexConversationForks {
  readonly #dependencies: CodexConversationForksDependencies;
  readonly #options: CodexConversationForksDependencies["options"];

  constructor(dependencies: CodexConversationForksDependencies) {
    this.#dependencies = dependencies;
    this.#options = dependencies.options;
  }

  /**
   * Forks `threadId` on `service` with every setting `source` holds, whole or to just before
   * `beforeTurnId`, then starts the fork in the session's mode and reads its turns. The caller
   * holds a thread claim on `service` until it registers the fork. Throws the request's failure,
   * and `CodexTransportError` for a reply that names no new thread or another permission profile;
   * a fork that fails a check after it was made is let go first.
   */
  async forkThread(
    service: CodexService,
    threadId: string,
    source: CodexForkSource,
    beforeTurnId?: string,
  ): Promise<CodexForkedThread> {
    // Resolved afresh against the model's tier list, which can change.
    const outputSpeed = await this.#dependencies.outputSpeed.resolveLevel(
      service,
      source.threadSettings.model,
      source.outputSpeedRequest,
    );
    const response = await service.request("thread/fork", {
      threadId,
      ...(beforeTurnId === undefined ? {} : { beforeTurnId }),
      excludeTurns: true,
      ...composeCodexThreadParams(source.threadSettings, this.#options.toolServerRoute.port),
      ...composeCodexServiceTier(outputSpeed),
    });
    const forked = readThread(response, "thread/fork");
    const usage = this.#dependencies.slots.usageAccountantFor(source.sessionId);
    if (forked.id === threadId || usage.hasThread(forked.id)) {
      throw new CodexTransportError("The Codex fork did not start a new conversation.", {
        method: "thread/fork",
        threadId: forked.id,
      });
    }
    const turnIds = await this.#readForkOrLetItGo(service, source, response, forked.id);
    return { response, threadId: forked.id, turnIds };
  }

  /**
   * Forks the record's conversation, whole or to just before `beforeTurnId`, on the settings the
   * record holds now, and moves the record onto the fork under `bindingId`, the record's own by
   * default. A config change owed before the fork is carried by it; one made after its request was
   * composed stays owed. Throws as {@link forkThread} does, and as the binding's write does, the
   * record unchanged.
   */
  async establishFork(
    record: CodexSessionRecord,
    beforeTurnId?: string,
    bindingId: string | undefined = record.bindingId,
  ): Promise<void> {
    const preForkThreadId = record.threadId;
    const service = record.service;
    const wasConfigForkOwed = record.isConfigForkOwed;
    // Cleared before the request is composed, so a change made while it is in flight stays owed.
    record.isConfigForkOwed = false;
    const closeClaim = service.beginThreadClaim();
    try {
      const forked = await this.forkThread(service, preForkThreadId, record, beforeTurnId);
      await this.#moveRecordToFork(
        record,
        forked.response,
        { preForkThreadId, forkedThreadId: forked.threadId },
        bindingId,
      );
      record.turnBoundaries.splice(0, record.turnBoundaries.length, ...forked.turnIds);
    } catch (cause) {
      record.isConfigForkOwed ||= wasConfigForkOwed;
      throw cause;
    } finally {
      closeClaim();
    }
  }

  /**
   * Forks the thread at a recorded boundary and re-points the session's record, and the run's
   * binding the params name, at the fork. Throws as the binding's write does, the record unchanged.
   */
  async establishRewoundSession(
    params: MoveSessionToForkParams,
    record: CodexSessionRecord,
    boundaryTurnId: string,
  ): Promise<MoveSessionToForkResult> {
    // Resolved afresh against the model's tier list. The fork holds the session's slot, so no
    // resume or close replaces this record during the read.
    const outputSpeed = await this.#dependencies.outputSpeed.resolveLevel(
      record.service,
      record.threadSettings.model,
      record.outputSpeedRequest,
    );
    // One read of the mutable field: both the fork source and the usage-base key.
    const preForkThreadId = record.threadId;
    const service = record.service;
    const closeClaim = service.beginThreadClaim();
    try {
      // Wraps the dispatch alone: a malformed result is not a missing capability.
      let response: unknown;
      try {
        response = await service.request("thread/fork", {
          threadId: preForkThreadId,
          lastTurnId: boundaryTurnId,
          excludeTurns: true,
          // A new thread carries every setting again, as a resume does.
          ...composeCodexThreadParams(record.threadSettings, this.#options.toolServerRoute.port),
          ...composeCodexServiceTier(outputSpeed),
        });
      } catch (cause) {
        // A build without `ThreadForkParams.lastTurnId` becomes `driver.capability_unsupported`;
        // any other failure is rethrown as it arrived. Nothing has mutated yet.
        throw classifyRewindForkFailure(cause);
      }
      const forkedThread = readThread(response, "thread/fork");
      if (forkedThread.id === preForkThreadId) {
        return { status: "degraded", fallbackAction: "rewind-not-forked" };
      }
      const usage = this.#dependencies.slots.usageAccountantFor(params.sessionId);
      if (usage.hasThread(forkedThread.id)) {
        return { status: "degraded", fallbackAction: "rewind-target-thread-already-registered" };
      }
      const forkedTurnIds = await this.#readForkOrLetItGo(
        service,
        record,
        response,
        forkedThread.id,
      );
      // Re-read after the awaits, before the first mutation; rebinding under a live turn would
      // strand the turn.
      if (record.runIdByActiveTurnId.size > 0) {
        await unsubscribeCodexThreadQuietly(
          service,
          forkedThread.id,
          this.#options.reportDiagnostic,
        );
        return { status: "degraded", fallbackAction: "rewind-deferred-turn-in-progress" };
      }
      // The run's live binding, as the daemon resolved it, is the one the fork moves.
      await this.#moveRecordToFork(
        record,
        response,
        { preForkThreadId, forkedThreadId: forkedThread.id },
        params.bindingId,
      );
      if (forkedTurnIds.length !== params.position) {
        reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
          kind: "fork-turn-ledger-unconfirmed",
          expectedTurnCount: params.position,
          confirmedTurnCount: forkedTurnIds.length,
        });
      }
      if (forkedTurnIds.length > 0) {
        // The provider's account of the forked history wins over the local ordinal.
        record.turnBoundaries.splice(0, record.turnBoundaries.length, ...forkedTurnIds);
      } else {
        record.turnBoundaries.length = params.position;
      }
      return MoveSessionToForkResultSchema.parse({
        status: "applied",
        sessionPosition: params.position,
      });
    } finally {
      closeClaim();
    }
  }

  /**
   * Checks a new fork's profile, starts it in the session's mode and reads its turn ids; a fork
   * that fails any of these is let go before the failure is rethrown.
   */
  async #readForkOrLetItGo(
    service: CodexService,
    source: CodexForkSource,
    response: unknown,
    forkedThreadId: string,
  ): Promise<string[]> {
    try {
      assertCodexThreadProfile(response, source.threadSettings, "thread/fork");
      // A fork starts in the mode the session holds, before the session moves onto it.
      await updateCodexSessionMode(
        {
          service,
          threadId: forkedThreadId,
          threadSettings: source.threadSettings,
          reasoningEffort: readThreadReasoningEffort(response),
        },
        source.sessionMode,
      );
      return (await readCodexTurns(service, forkedThreadId)).map((listed) => listed.id);
    } catch (cause) {
      await unsubscribeCodexThreadQuietly(service, forkedThreadId, this.#options.reportDiagnostic);
      throw cause;
    }
  }

  /**
   * Points the binding of the session's first run at the conversation the session is on, and
   * records with it each conversation a fork left before the session had a binding. Throws as the
   * binding's write does, the conversations still owed to the next write.
   */
  async bindFirstRun(record: CodexSessionRecord, bindingId: string): Promise<void> {
    const leftThreadIds = record.leftThreadIdsAwaitingBinding;
    if (leftThreadIds.length === 0) {
      return;
    }
    await this.#options.rebindRuntimeBinding({
      bindingId,
      resumeHandle: record.threadId,
      leftConversations: composeLeftConversations(record, leftThreadIds),
    });
    leftThreadIds.length = 0;
  }

  /**
   * Re-points a record at its fork: `bindingId` first, then usage based on the thread it left,
   * the routing band and the service bound to the fork, the left thread's helpers released, and
   * the thread it left let go once no command of it runs. The message-to-turn map is dropped,
   * since a fork's turns carry their own ids; an undo rebuilds it from the fork's history. A
   * failed binding write lets the fork go and rethrows, the record unchanged.
   */
  async #moveRecordToFork(
    record: CodexSessionRecord,
    response: unknown,
    { preForkThreadId, forkedThreadId }: { preForkThreadId: string; forkedThreadId: string },
    bindingId: string | undefined,
  ): Promise<void> {
    const sessionId = record.sessionId;
    const service = record.service;
    await this.#recordForkInBinding(record, bindingId, preForkThreadId, forkedThreadId);
    record.bindingId = bindingId;
    record.threadId = forkedThreadId;
    record.permissionProfiles = composeCodexThreadPermissionProfiles(record.threadSettings);
    record.declaredOutputSpeed = this.#dependencies.outputSpeed.readDeclaredTier(
      sessionId,
      response,
    );
    record.reasoningEffort = readThreadReasoningEffort(response);
    record.turnIdByClientMessageId.clear();
    // Based like a resume on the pre-fork thread, the only key the earlier spend exists under.
    this.#dependencies.notificationRouting.bindSessionThread(sessionId, forkedThreadId, {
      mode: "resume",
      priorEmittedThreadId: preForkThreadId,
    });
    this.#dependencies.slots.usageAccountantFor(sessionId).releaseThread(preForkThreadId);
    this.#dependencies.pendingCompactions.releaseBinding(
      codexCompactionWaitKey(sessionId, preForkThreadId),
    );
    // The helpers of the conversation the session leaves go with it, those whose commands still
    // run excepted; a side question's copy is no helper and stays.
    const router = this.#dependencies.slots.frameRouterFor(sessionId);
    this.#dependencies.release.releaseSessionThreads(
      service,
      sessionId,
      (threadId) => router.childAttributionFor(threadId) !== undefined,
    );
    service.registerThread(forkedThreadId, sessionId);
    await this.#dependencies.release.letGo(service, preForkThreadId, sessionId);
  }

  // Durable before anything lets go of the thread the session leaves, so a daemon restart never
  // resumes a conversation the session moved off; the left thread is recorded in the same write.
  // Before the session's first run there is no binding, so its first run's binding records it.
  async #recordForkInBinding(
    record: CodexSessionRecord,
    bindingId: string | undefined,
    preForkThreadId: string,
    forkedThreadId: string,
  ): Promise<void> {
    const leftThreadIds = [...record.leftThreadIdsAwaitingBinding, preForkThreadId];
    if (bindingId === undefined) {
      record.leftThreadIdsAwaitingBinding.push(preForkThreadId);
      return;
    }
    try {
      await this.#options.rebindRuntimeBinding({
        bindingId,
        resumeHandle: forkedThreadId,
        leftConversations: composeLeftConversations(record, leftThreadIds),
      });
    } catch (cause) {
      await unsubscribeCodexThreadQuietly(
        record.service,
        forkedThreadId,
        this.#options.reportDiagnostic,
      );
      throw cause;
    }
    record.leftThreadIdsAwaitingBinding.length = 0;
  }
}

// The conversations a session left, on the account its record runs on.
function composeLeftConversations(
  record: CodexSessionRecord,
  threadIds: readonly string[],
): LeftConversation[] {
  return threadIds.map((conversationId) => ({
    sessionId: record.sessionId,
    providerAccountId: record.providerAccountId,
    conversationId,
  }));
}
