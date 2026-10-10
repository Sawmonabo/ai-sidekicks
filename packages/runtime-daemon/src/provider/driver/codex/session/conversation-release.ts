// Letting go of a conversation a session moved off. Codex unloads a conversation once no client
// holds it, and the commands it still runs end with it, so the old conversation stays subscribed,
// its command rows reaching the session, until `thread/backgroundTerminals/list` reads no command
// of it running; each command's end reads the list again, with no timer, and a list that could not
// be read is read again at the conversation's next frame. A connection opened again subscribes to
// each held conversation again, and a service a build move retires stays up until it holds none.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { CODEX_COMMAND_ITEM_TYPE, readCodexFrameItem } from "../delivery/rows.js";
import { CODEX_ITEM_COMPLETED_METHOD } from "../event-normalizer.js";
import type { CodexService } from "../service/supervisor.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import { endCodexRunningCommands, listCodexRunningCommands } from "./background-terminals.js";
import { normalizeProviderFailureDetail } from "./errors.js";
import { readCodexFrameThreadId } from "./state.js";

// A conversation held only for the commands it still runs, and the session it belonged to.
interface CodexHeldConversation {
  readonly service: CodexService;
  readonly sessionId: SessionId;
  // Set when its running-command list could not be read, so its next frame reads it again.
  isListReadOwed: boolean;
}

/** The session's routing band, which admits a held conversation's command frames as its own. */
export interface CodexHeldThreadRouting {
  readonly admitHeldThread: (sessionId: SessionId, threadId: string) => void;
  readonly releaseHeldThread: (sessionId: SessionId, threadId: string) => void;
}

/** What the release reports to and routes through. */
export interface CodexConversationReleaseDependencies {
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly routing: CodexHeldThreadRouting;
}

/** Holds each conversation a session moved off until no command of it runs, then lets it go. */
export class CodexConversationRelease {
  readonly #reportDiagnostic: CodexDiagnosticSink;
  readonly #routing: CodexHeldThreadRouting;
  // By thread id; an entry leaves once its conversation is let go or its service is gone.
  readonly #held = new Map<string, CodexHeldConversation>();
  // Those waiting for a service to hold no conversation here.
  readonly #awaitingNoneHeld = new Map<CodexService, Array<() => void>>();

  constructor(dependencies: CodexConversationReleaseDependencies) {
    this.#reportDiagnostic = dependencies.reportDiagnostic;
    this.#routing = dependencies.routing;
  }

  /**
   * Lets go of `threadId` now, or once the commands it still runs have ended; until then its
   * frames stay routed to `sessionId`, its command frames as the session's own, and reach
   * {@link observeFrame}. Never throws.
   */
  async letGo(service: CodexService, threadId: string, sessionId: SessionId): Promise<void> {
    const held: CodexHeldConversation = { service, sessionId, isListReadOwed: false };
    this.#held.set(threadId, held);
    service.registerThread(threadId, sessionId);
    this.#routing.admitHeldThread(sessionId, threadId);
    await this.#releaseOnceIdle(threadId, held);
  }

  /**
   * Whether a frame belongs to a conversation held only for the commands it still runs. A
   * command's end there reads the list again, as does any frame of one whose list was unreadable.
   */
  observeFrame(service: CodexService, method: string, params: unknown): boolean {
    const threadId = readCodexFrameThreadId(method, params);
    const held = threadId === null ? undefined : this.#held.get(threadId);
    if (threadId === null || held === undefined || held.service !== service) {
      return false;
    }
    const isCommandEnd =
      method === CODEX_ITEM_COMPLETED_METHOD &&
      readCodexFrameItem(params)?.["type"] === CODEX_COMMAND_ITEM_TYPE;
    if (isCommandEnd || held.isListReadOwed) {
      held.isListReadOwed = false;
      void this.#releaseOnceIdle(threadId, held);
    }
    return true;
  }

  /**
   * Forgets every thread a session holds on `service`, its helpers' included, or only those
   * `isReleased` names, except those held here, whose frames keep reaching the daemon until their
   * commands end.
   */
  releaseSessionThreads(
    service: CodexService,
    sessionId: SessionId,
    isReleased: (threadId: string) => boolean = () => true,
  ): void {
    for (const threadId of service.threads.threadsOf(sessionId)) {
      if (!this.#held.has(threadId) && isReleased(threadId)) {
        service.threads.release(threadId);
      }
    }
  }

  /** Resolves once no conversation on `service` is held here; never rejects. */
  async whenNoneHeldOn(service: CodexService): Promise<void> {
    if (this.#isNoneHeldOn(service)) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#awaitingNoneHeld.set(service, [...(this.#awaitingNoneHeld.get(service) ?? []), resolve]);
    await promise;
  }

  /**
   * Subscribes again to each conversation held on a service whose connection was opened again,
   * since a new connection holds none of the daemon's subscriptions, before any of them is let go;
   * each then reads its list again. A conversation that cannot be subscribed to again is reported
   * and dropped: no client holds it, so Codex unloads it and its commands end with it. Never
   * throws.
   */
  async resubscribeService(service: CodexService): Promise<void> {
    for (const [threadId, held] of [...this.#held]) {
      if (held.service !== service) {
        continue;
      }
      try {
        await service.request("thread/resume", { threadId, excludeTurns: true });
      } catch (cause) {
        reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, {
          kind: "conversation-resume-failed",
          threadId,
          detail: normalizeProviderFailureDetail(cause),
        });
        if (this.#held.get(threadId) === held) {
          this.#drop(held, threadId);
          this.#settleNoneHeld(service);
        }
        continue;
      }
      service.registerThread(threadId, held.sessionId);
      await this.#releaseOnceIdle(threadId, held);
    }
  }

  /**
   * Ends the commands of each conversation a closing session still holds, as its close does for
   * its own, and lets each go.
   */
  async forgetSession(sessionId: SessionId): Promise<void> {
    for (const [threadId, held] of [...this.#held]) {
      if (held.sessionId !== sessionId) {
        continue;
      }
      this.#held.delete(threadId);
      if (held.service.isRunning) {
        await endCodexRunningCommands(held.service, threadId, this.#reportDiagnostic, {
          clean: true,
        });
      }
      await this.#release(held, threadId);
    }
  }

  /**
   * Forgets the conversations held on a service whose process ended, or which the daemon stopped
   * or lost: the commands they ran ended with it.
   */
  forgetService(service: CodexService): void {
    for (const [threadId, held] of [...this.#held]) {
      if (held.service === service) {
        this.#drop(held, threadId);
      }
    }
    this.#settleNoneHeld(service);
  }

  // Reads the list and lets the conversation go once it is empty. An unreadable list keeps it
  // held, reported, and its next frame reads the list again: letting it go would end a command
  // that may still run.
  async #releaseOnceIdle(threadId: string, held: CodexHeldConversation): Promise<void> {
    if (held.service.isRunning) {
      try {
        if ((await listCodexRunningCommands(held.service, threadId)).length > 0) {
          return;
        }
      } catch (cause) {
        reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, {
          kind: "teardown-step-failed",
          step: "background-terminal-list",
          detail: normalizeProviderFailureDetail(cause),
        });
        held.isListReadOwed = true;
        return;
      }
    }
    // Another read, or the session's close, let it go first.
    if (this.#held.get(threadId) !== held) {
      return;
    }
    this.#held.delete(threadId);
    await this.#release(held, threadId);
  }

  async #release(held: CodexHeldConversation, threadId: string): Promise<void> {
    held.service.threads.release(threadId);
    this.#routing.releaseHeldThread(held.sessionId, threadId);
    await unsubscribeCodexThreadQuietly(held.service, threadId, this.#reportDiagnostic);
    this.#settleNoneHeld(held.service);
  }

  // Forgets a held conversation with no request to Codex, which no longer holds it for the daemon.
  #drop(held: CodexHeldConversation, threadId: string): void {
    this.#held.delete(threadId);
    held.service.threads.release(threadId);
    this.#routing.releaseHeldThread(held.sessionId, threadId);
  }

  #isNoneHeldOn(service: CodexService): boolean {
    return [...this.#held.values()].every((held) => held.service !== service);
  }

  #settleNoneHeld(service: CodexService): void {
    if (!this.#isNoneHeldOn(service)) {
      return;
    }
    const waiting = this.#awaitingNoneHeld.get(service);
    this.#awaitingNoneHeld.delete(service);
    for (const resolve of waiting ?? []) {
      resolve();
    }
  }
}

/**
 * Unsubscribes the daemon from `threadId` on a running service, so Codex unloads it once no
 * client holds it; a refusal is reported, since the caller's own outcome must stand.
 */
export async function unsubscribeCodexThreadQuietly(
  service: CodexService,
  threadId: string,
  reportDiagnostic: CodexDiagnosticSink,
): Promise<void> {
  if (!service.isRunning) {
    return;
  }
  try {
    await service.request("thread/unsubscribe", { threadId });
  } catch (cause) {
    reportDiagnosticFromDetachedFrame(reportDiagnostic, {
      kind: "teardown-step-failed",
      step: "thread-unsubscribe",
      detail: normalizeProviderFailureDetail(cause),
    });
  }
}
