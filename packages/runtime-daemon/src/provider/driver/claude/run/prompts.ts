// The newest message the daemon sent each Claude session: a conversation cut names it as the last
// one Claude Code saw, and a turn too long for the context window hands it back to the person.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** The newest message sent to each session's live process, by the uuid its user frame carried. */
export class ClaudeSentPrompts {
  readonly #newestBySession: Map<SessionId, string> = new Map();

  /** Records a message written to the session's process as its newest. */
  recordSent(sessionId: SessionId, messageUuid: string): void {
    this.#newestBySession.set(sessionId, messageUuid);
  }

  /** Forgets a message taken back before Claude Code read it, if it is still the newest. */
  forgetSent(sessionId: SessionId, messageUuid: string): void {
    if (this.#newestBySession.get(sessionId) === messageUuid) {
      this.#newestBySession.delete(sessionId);
    }
  }

  /** The newest message sent to the session's process, if one is known. */
  newestFor(sessionId: SessionId): string | undefined {
    return this.#newestBySession.get(sessionId);
  }

  /** Forgets the session's newest message, cut from its conversation or gone with its process. */
  forgetSession(sessionId: SessionId): void {
    this.#newestBySession.delete(sessionId);
  }
}
