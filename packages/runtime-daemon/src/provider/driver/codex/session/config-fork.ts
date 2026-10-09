// Moving a conversation onto a changed config: a level's config keys and the window reach a Codex
// conversation only through a start, resume or fork, so a change is taken at once and forks the
// whole conversation with its new config, at once when the session is idle and when its running
// turn settles otherwise. Several changes before that make one fork. A turn never starts while the
// fork is owed: it waits for the running turn to settle and for the fork, then starts on the fork.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { reportDiagnosticFromDetachedFrame } from "../transport/diagnostics.js";
import { CodexTransportError, normalizeProviderFailureDetail } from "./errors.js";
import type { CodexConversationForks } from "./fork.js";
import type { CodexSessionSlots } from "./slots.js";
import { type CodexLifecycleOptions, type CodexSessionRecord, isTurnInFlight } from "./state.js";

/** What the config forks act through. */
export interface CodexConfigForksDependencies {
  readonly options: Pick<CodexLifecycleOptions, "reportDiagnostic">;
  readonly slots: CodexSessionSlots;
  readonly forks: CodexConversationForks;
}

/**
 * Forks each session's conversation onto the config its record holds once it changed, never while
 * a turn runs or starts on it.
 */
export class CodexConfigForks {
  readonly #dependencies: CodexConfigForksDependencies;
  // The fork in flight on each session, resolving `false` when it did not run because the session
  // was closed or established anew, or a turn started on it, first.
  readonly #running = new Map<SessionId, Promise<boolean>>();
  // The turns waiting for a record's running turn to stop before the fork they owe can run.
  readonly #awaitingTurnStop = new Map<CodexSessionRecord, Array<() => void>>();

  constructor(dependencies: CodexConfigForksDependencies) {
    this.#dependencies = dependencies;
  }

  /** Owes the session a fork onto the config its record holds now; an idle one forks at once. */
  owe(record: CodexSessionRecord): void {
    record.isConfigForkOwed = true;
    this.noteTurnSettled(record);
  }

  /** Runs an owed fork once the session's turn settled and nothing else runs on it. */
  noteTurnSettled(record: CodexSessionRecord): void {
    this.stopWaiting(record);
    if (!record.isConfigForkOwed || isTurnInFlight(record)) {
      return;
    }
    this.#fork(record).then(
      (hasForked) => {
        // A change made while the fork was in flight is still owed.
        if (hasForked) {
          this.noteTurnSettled(record);
        }
      },
      (cause: unknown) => {
        // Still owed: the session's next turn forks again first, and fails with the fork's error.
        reportDiagnosticFromDetachedFrame(this.#dependencies.options.reportDiagnostic, {
          kind: "conversation-fork-failed",
          threadId: record.threadId,
          detail: normalizeProviderFailureDetail(cause),
        });
      },
    );
  }

  /**
   * Wakes the turns waiting on the record's running turn: its turns were dropped unended, or the
   * record left its slot. Each woken turn looks again at what the session owes.
   */
  stopWaiting(record: CodexSessionRecord): void {
    const waiting = this.#awaitingTurnStop.get(record);
    this.#awaitingTurnStop.delete(record);
    for (const wake of waiting ?? []) {
      wake();
    }
  }

  /**
   * Waits for the forks in flight on the session, a change made meanwhile forking again. Throws
   * the fork's failure.
   */
  async join(sessionId: SessionId): Promise<void> {
    for (
      let inFlight = this.#running.get(sessionId);
      inFlight !== undefined;
      inFlight = this.#running.get(sessionId)
    ) {
      await inFlight;
    }
  }

  /**
   * The session's live record once the config forks in flight on it ended, a change made meanwhile
   * forking again, so a call made while the conversation moves onto its config acts on the fork.
   * Throws the fork's failure, and as {@link CodexSessionSlots.require} does.
   */
  async requireAfterForks(sessionId: SessionId): Promise<CodexSessionRecord> {
    await this.join(sessionId);
    return this.#dependencies.slots.require(sessionId);
  }

  /**
   * Brings the conversation onto its config before a turn starts on it: waits for a fork in
   * flight, then for a running turn to settle, then runs an owed fork. The caller starts its turn
   * without awaiting anything after it. Throws the fork's failure, and `CodexTransportError` once
   * the session was closed or established anew meanwhile.
   */
  async forkBeforeTurn(record: CodexSessionRecord): Promise<void> {
    const { sessionId } = record;
    for (;;) {
      await this.join(sessionId);
      if (this.#dependencies.slots.recordFor(sessionId) !== record) {
        throw new CodexTransportError(
          `Codex session "${sessionId}" was closed or established anew while its conversation ` +
            `moved onto its new config.`,
          { sessionId, method: "thread/fork" },
        );
      }
      if (!record.isConfigForkOwed) {
        return;
      }
      if (isTurnInFlight(record)) {
        await this.#turnStopped(record);
      } else {
        await this.#fork(record);
      }
    }
  }

  #turnStopped(record: CodexSessionRecord): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#awaitingTurnStop.set(record, [...(this.#awaitingTurnStop.get(record) ?? []), resolve]);
    return promise;
  }

  // One fork per session at a time; a caller arriving meanwhile shares it. Not async, so a
  // continuation on the fork runs before a joiner's and can publish the next fork first.
  #fork(record: CodexSessionRecord): Promise<boolean> {
    const { sessionId } = record;
    const inFlight = this.#running.get(sessionId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const running = this.#dependencies.slots
      .claim(sessionId, "establishing", async (): Promise<boolean> => {
        // A session closed or established anew while it waited owes nothing now; one whose turn
        // started meanwhile still owes the fork, which runs once that turn settles.
        if (this.#dependencies.slots.recordFor(sessionId) !== record || isTurnInFlight(record)) {
          return false;
        }
        await this.#dependencies.forks.establishFork(record);
        return true;
      })
      .finally(() => {
        if (this.#running.get(sessionId) === running) {
          this.#running.delete(sessionId);
        }
      });
    this.#running.set(sessionId, running);
    return running;
  }
}
