// Which session each conversation on one Codex service belongs to. Every frame and server request
// a service sends names its thread, so this is where a shared service's traffic is told apart: a
// session's own thread, and every child thread a helper opened beneath it.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** A frame the service sent, held while a start or fork that may claim its thread is in flight. */
export interface CodexHeldThreadFrame {
  readonly method: string;
  readonly params: unknown;
  readonly threadId: string;
}

/**
 * The thread-to-session index of one service, and the bounded hold for frames that name a thread
 * a start or fork in flight is about to claim (a `thread/started` can come before its reply).
 */
export class CodexServiceThreads {
  readonly #maxHeldFrames: number;
  readonly #sessionByThread = new Map<string, SessionId>();
  readonly #heldFrames: CodexHeldThreadFrame[] = [];
  #claimsInFlight = 0;

  /** `maxHeldFrames` bounds the hold; past it the oldest held frame is dropped and returned. */
  constructor(maxHeldFrames: number) {
    this.#maxHeldFrames = maxHeldFrames;
  }

  /** The session a thread belongs to, or `undefined` for one no session on this service holds. */
  sessionFor(threadId: string): SessionId | undefined {
    return this.#sessionByThread.get(threadId);
  }

  /** Every session holding a conversation on this service, each once. */
  sessions(): SessionId[] {
    return [...new Set(this.#sessionByThread.values())];
  }

  /** Every thread one session holds here: its own and its helpers'. */
  threadsOf(sessionId: SessionId): string[] {
    return [...this.#sessionByThread].filter(([, owner]) => owner === sessionId).map(([id]) => id);
  }

  /**
   * Records a thread as the session's, and returns the frames held for it, in arrival order, for
   * the caller to deliver now.
   */
  register(threadId: string, sessionId: SessionId): CodexHeldThreadFrame[] {
    this.#sessionByThread.set(threadId, sessionId);
    const released: CodexHeldThreadFrame[] = [];
    for (let index = 0; index < this.#heldFrames.length; ) {
      const held = this.#heldFrames[index];
      if (held !== undefined && held.threadId === threadId) {
        this.#heldFrames.splice(index, 1);
        released.push(held);
      } else {
        index += 1;
      }
    }
    return released;
  }

  /** Forgets one thread. */
  release(threadId: string): void {
    this.#sessionByThread.delete(threadId);
  }

  /**
   * Opens a claim for a start or fork whose thread is not known yet; the returned function closes
   * it and returns the frames no claim took once none is left open, for the caller to report.
   */
  beginClaim(): () => CodexHeldThreadFrame[] {
    this.#claimsInFlight += 1;
    let closed = false;
    return () => {
      if (closed) {
        return [];
      }
      closed = true;
      this.#claimsInFlight -= 1;
      if (this.#claimsInFlight > 0) {
        return [];
      }
      return this.#heldFrames.splice(0, this.#heldFrames.length);
    };
  }

  /**
   * Holds a frame for an unknown thread while a claim is open. Answers `not-held` with no claim
   * open, else `held`, or the frame the bound pushed out.
   */
  hold(frame: CodexHeldThreadFrame): "not-held" | "held" | CodexHeldThreadFrame {
    if (this.#claimsInFlight === 0) {
      return "not-held";
    }
    this.#heldFrames.push(frame);
    if (this.#heldFrames.length <= this.#maxHeldFrames) {
      return "held";
    }
    return this.#heldFrames.shift() ?? "held";
  }
}
