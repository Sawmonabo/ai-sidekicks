// The config warnings one Codex service sends, which name no conversation and belong to every
// session it holds. The service sends them again to each new connection, so each warning is kept by
// its content with the sessions already told it: a resume, a reconnect or a late attach tells a
// session only what it has not heard.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** One service's config warnings and the sessions each was delivered to. */
export class CodexConfigWarnings {
  // The current connection's warnings, by their content, in arrival order.
  #current = new Map<string, unknown>();
  // The sessions told each warning, by its content; kept across connections.
  readonly #toldByWarning = new Map<string, Set<SessionId>>();

  /** Starts a new connection's list: the service sends its warnings again to each connection. */
  startConnection(): void {
    this.#current = new Map();
  }

  /**
   * Records a warning the service just sent and answers the sessions among `sessionIds` that have
   * not been told it, marking them told.
   */
  recordWarning(params: unknown, sessionIds: readonly SessionId[]): SessionId[] {
    const key = JSON.stringify(params);
    this.#current.set(key, params);
    const told = this.#toldByWarning.get(key) ?? new Set<SessionId>();
    this.#toldByWarning.set(key, told);
    const owed = sessionIds.filter((sessionId) => !told.has(sessionId));
    for (const sessionId of owed) {
      told.add(sessionId);
    }
    return owed;
  }

  /** The current warnings a session has not been told, marking it told of each. */
  takeOwed(sessionId: SessionId): unknown[] {
    const owed: unknown[] = [];
    for (const [key, params] of this.#current) {
      const told = this.#toldByWarning.get(key) ?? new Set<SessionId>();
      this.#toldByWarning.set(key, told);
      if (!told.has(sessionId)) {
        told.add(sessionId);
        owed.push(params);
      }
    }
    return owed;
  }

  /** Forgets a closed session, so a later session under its id hears every warning again. */
  forgetSession(sessionId: SessionId): void {
    for (const told of this.#toldByWarning.values()) {
      told.delete(sessionId);
    }
  }
}
