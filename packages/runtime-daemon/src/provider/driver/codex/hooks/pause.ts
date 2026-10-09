// Pause and continue on Codex by the daemon's hooks: a paused conversation's next tool call, the
// session's own or a helper's, is held at the pre-tool hook until the run continues, and the first
// call held is the pause taking effect. A helper's waiting messages reach it at its next post-tool
// hook, as words added after the call it ran.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { CodexHookAnswer, CodexHookAnswerer, CodexHookInput } from "./server.js";

/** The run a conversation's pause stops, and the binding its `paused` is delivered on. */
export interface CodexHookPause {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly bindingId: string;
}

/** One pause in force on a conversation, and the calls it holds. */
interface CodexHeldConversation {
  readonly pause: CodexHookPause;
  readonly releases: Set<() => void>;
  hasTakenEffect: boolean;
}

/** What the pauses report through. */
export interface CodexRunPausesDependencies {
  /** The pause's first held call: the run stopped there. Never throws. */
  readonly onTookEffect: (pause: CodexHookPause) => void;
  /** Whether the run is still live; a pause outliving its run holds nothing. */
  readonly isRunLive: (runId: RunId) => boolean;
}

/** Every conversation's hook pause and the words waiting for a helper's next finished call. */
export class CodexRunPauses {
  readonly #dependencies: CodexRunPausesDependencies;
  readonly #pausedByThreadId = new Map<string, CodexHeldConversation>();
  readonly #wordsByThreadId = new Map<string, { sessionId: SessionId; words: string }>();

  constructor(dependencies: CodexRunPausesDependencies) {
    this.#dependencies = dependencies;
  }

  /** The dispatch point's answerer for the pause: a held pre-tool call, or a helper's words. */
  readonly answer: CodexHookAnswerer = (input, signal) =>
    input.eventName === "PreToolUse" ? this.#holdCall(input, signal) : this.#takeWords(input);

  /** Pauses one conversation from its next tool call on; a pause already there stays. */
  pause(threadId: string, pause: CodexHookPause): void {
    if (!this.#pausedByThreadId.has(threadId)) {
      this.#pausedByThreadId.set(threadId, { pause, releases: new Set(), hasTakenEffect: false });
    }
  }

  /** The conversation a run's hook pause is on, or `undefined` when none is. */
  threadPausedFor(runId: RunId): string | undefined {
    for (const [threadId, paused] of this.#pausedByThreadId) {
      if (paused.pause.runId === runId) {
        return threadId;
      }
    }
    return undefined;
  }

  /**
   * Continues a paused conversation: its held calls run, and `words`, when given, reach it at its
   * next finished call. Answers whether the pause had taken effect.
   */
  resume(threadId: string, words: string | undefined): boolean {
    const paused = this.#pausedByThreadId.get(threadId);
    this.#pausedByThreadId.delete(threadId);
    if (paused !== undefined && words !== undefined) {
      this.#wordsByThreadId.set(threadId, { sessionId: paused.pause.sessionId, words });
    }
    for (const release of paused?.releases ?? []) {
      release();
    }
    return paused?.hasTakenEffect === true;
  }

  /** Lets go of a conversation that ended: its held calls run and its waiting words leave. */
  forgetThread(threadId: string): void {
    this.resume(threadId, undefined);
    this.#wordsByThreadId.delete(threadId);
  }

  /** Lets go of every pause and waiting word of a session whose conversation closed. */
  forgetSession(sessionId: SessionId): void {
    for (const [threadId, paused] of [...this.#pausedByThreadId]) {
      if (paused.pause.sessionId === sessionId) {
        this.resume(threadId, undefined);
      }
    }
    for (const [threadId, waiting] of [...this.#wordsByThreadId]) {
      if (waiting.sessionId === sessionId) {
        this.#wordsByThreadId.delete(threadId);
      }
    }
  }

  #holdCall(input: CodexHookInput, signal: AbortSignal): Promise<undefined> | undefined {
    const paused = this.#pausedByThreadId.get(input.threadId);
    if (paused === undefined) {
      return undefined;
    }
    // A service that crashed or a session let go leaves its pause behind with no run to stop.
    if (!this.#dependencies.isRunLive(paused.pause.runId)) {
      this.resume(input.threadId, undefined);
      return undefined;
    }
    const held = new Promise<undefined>((resolve) => {
      const release = (): void => {
        paused.releases.delete(release);
        resolve(undefined);
      };
      paused.releases.add(release);
      // The call stopped waiting (its deadline or Codex ending the hook), so the hold lets go.
      signal.addEventListener("abort", release);
    });
    if (!paused.hasTakenEffect) {
      paused.hasTakenEffect = true;
      this.#dependencies.onTookEffect(paused.pause);
    }
    return held;
  }

  #takeWords(input: CodexHookInput): CodexHookAnswer | undefined {
    const waiting = this.#wordsByThreadId.get(input.threadId);
    if (waiting === undefined) {
      return undefined;
    }
    this.#wordsByThreadId.delete(input.threadId);
    return { decision: "context", additionalContext: waiting.words };
  }
}
