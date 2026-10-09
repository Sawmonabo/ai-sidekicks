// The person's `Helpers at once` on Claude Code: the pre-tool hook on the helper tool lets a new
// helper start while fewer than the limit run, and holds its start unanswered until one of the
// session's running helpers finishes. Claude Code has no limit of its own to set.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** One session's helpers: its limit, admitted starts, running helpers and held starts. */
interface ClaudeSessionHelpers {
  readonly limit: number;
  // Helper-tool calls let through whose helper has not announced itself yet, by tool call id.
  readonly admittedStarts: Set<string>;
  readonly runningHelperIds: Set<string>;
  // Held starts in arrival order: the callback's request id and its tool call id.
  readonly heldStarts: { readonly requestId: string; readonly toolUseId: string }[];
}

/** How the limit answers one helper-tool callback: let it through now, or hold it. */
export type ClaudeHelperStartAnswer = "admit" | "hold";

/** Every session's helper limit and the starts it holds. */
export class ClaudeHelperLimit {
  readonly #sessions: Map<SessionId, ClaudeSessionHelpers> = new Map();

  /** Sets the session's limit, a positive number of helpers running at once. */
  limitSession(sessionId: SessionId, limit: number): void {
    this.#sessions.set(sessionId, {
      limit,
      admittedStarts: new Set(),
      runningHelperIds: new Set(),
      heldStarts: [],
    });
  }

  /** Answers a new helper's start: admitted while the session runs fewer than its limit. */
  answerStart(sessionId: SessionId, requestId: string, toolUseId: string): ClaudeHelperStartAnswer {
    const helpers = this.#sessions.get(sessionId);
    if (helpers === undefined || occupied(helpers) < helpers.limit) {
      helpers?.admittedStarts.add(toolUseId);
      return "admit";
    }
    helpers.heldStarts.push({ requestId, toolUseId });
    return "hold";
  }

  /** Records a helper's announcement, by the helper-tool call that started it. */
  helperStarted(sessionId: SessionId, helperId: string, parentToolUseId: string | null): void {
    const helpers = this.#sessions.get(sessionId);
    if (helpers === undefined) {
      return;
    }
    if (parentToolUseId !== null) {
      helpers.admittedStarts.delete(parentToolUseId);
    }
    helpers.runningHelperIds.add(helperId);
  }

  /**
   * Records a helper's end and answers the held starts it frees, oldest first, each now admitted.
   */
  helperFinished(sessionId: SessionId, helperId: string): string[] {
    const helpers = this.#sessions.get(sessionId);
    if (helpers === undefined) {
      return [];
    }
    helpers.runningHelperIds.delete(helperId);
    return admitHeldStarts(helpers);
  }

  /**
   * At the end of the lead's turn, an admitted start that never announced a helper never will:
   * it is let go, and the held starts it frees are answered.
   */
  turnEnded(sessionId: SessionId): string[] {
    const helpers = this.#sessions.get(sessionId);
    if (helpers === undefined) {
      return [];
    }
    helpers.admittedStarts.clear();
    return admitHeldStarts(helpers);
  }

  /** Drops a held start Claude Code withdrew. */
  withdrawStart(sessionId: SessionId, requestId: string): void {
    const helpers = this.#sessions.get(sessionId);
    if (helpers === undefined) {
      return;
    }
    const index = helpers.heldStarts.findIndex((held) => held.requestId === requestId);
    if (index >= 0) {
      helpers.heldStarts.splice(index, 1);
    }
  }

  /** Forgets a session whose process is gone; its helpers went with it. */
  forgetSession(sessionId: SessionId): void {
    this.#sessions.delete(sessionId);
  }
}

function occupied(helpers: ClaudeSessionHelpers): number {
  return helpers.admittedStarts.size + helpers.runningHelperIds.size;
}

// Admits held starts while the session has room, and answers their request ids.
function admitHeldStarts(helpers: ClaudeSessionHelpers): string[] {
  const admitted: string[] = [];
  while (occupied(helpers) < helpers.limit) {
    const next = helpers.heldStarts.shift();
    if (next === undefined) {
      break;
    }
    helpers.admittedStarts.add(next.toolUseId);
    admitted.push(next.requestId);
  }
  return admitted;
}
