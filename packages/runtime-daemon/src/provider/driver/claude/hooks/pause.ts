// Pause and continue on Claude Code, by the two hooks the daemon registers. A paused lead's batch
// hook ends its turn after the step in flight and its tool hook denies; a paused helper's next
// tool hook is held unanswered until it continues. Each pause reports when it took effect.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** The reason a paused lead's hooks give Claude Code, which the model reads. */
const CLAUDE_PAUSED_REASON = "Paused by you";

/** A pre-tool callback a paused helper is held on, answered when it continues. */
interface ClaudeHeldToolCallback {
  readonly requestId: string;
  readonly agentId: string;
}

/**
 * How the pause answers one callback: at once with `response`, or held with no answer yet;
 * `tookEffect` marks the first hold of a helper's pause, the moment it took effect.
 */
export type ClaudePauseAnswer =
  | { readonly kind: "answer"; readonly response: Record<string, unknown> }
  | { readonly kind: "hold"; readonly tookEffect: boolean };

/** One held callback a continue answers, and what it is answered with. */
export interface ClaudeReleasedCallback {
  readonly requestId: string;
  readonly response: Record<string, unknown>;
}

const PASS: ClaudePauseAnswer = { kind: "answer", response: {} };

/** The session's lead pause: its run, and whether a hook has stopped the turn on it yet. */
interface ClaudeLeadPause {
  readonly runId: RunId;
  stopAnswered: boolean;
  effectReported: boolean;
}

/** Every session's pauses, the lead's and each helper's, and the callbacks the pauses hold. */
export class ClaudeRunPauses {
  readonly #leadPauses: Map<SessionId, ClaudeLeadPause> = new Map();
  readonly #pausedAgents: Map<SessionId, Set<string>> = new Map();
  readonly #heldCallbacks: Map<SessionId, ClaudeHeldToolCallback[]> = new Map();

  /** Pauses the session's lead run from its next hook on. */
  pauseLead(sessionId: SessionId, runId: RunId): void {
    if (!this.#leadPauses.has(sessionId)) {
      this.#leadPauses.set(sessionId, { runId, stopAnswered: false, effectReported: false });
    }
  }

  /** Pauses one helper from its next tool call on. */
  pauseHelper(sessionId: SessionId, agentId: string): void {
    const paused = this.#pausedAgents.get(sessionId) ?? new Set<string>();
    paused.add(agentId);
    this.#pausedAgents.set(sessionId, paused);
  }

  /**
   * Answers a pre-tool callback: a paused lead's is denied, a paused helper's is held, any other
   * passes with no decision. `agentId` is the helper's, `null` on the lead.
   */
  answerBeforeTool(
    sessionId: SessionId,
    agentId: string | null,
    requestId: string,
  ): ClaudePauseAnswer {
    if (agentId === null) {
      return this.#leadPauses.has(sessionId) ? denyWith(CLAUDE_PAUSED_REASON) : PASS;
    }
    if (this.#pausedAgents.get(sessionId)?.has(agentId) !== true) {
      return PASS;
    }
    const held = this.#heldCallbacks.get(sessionId) ?? [];
    const tookEffect = !held.some((callback) => callback.agentId === agentId);
    held.push({ requestId, agentId });
    this.#heldCallbacks.set(sessionId, held);
    return { kind: "hold", tookEffect };
  }

  /**
   * Answers a post-batch callback: a paused lead's ends the turn after the step in flight. Never
   * used on a helper, where it would end the helper's run and the lead would invent its result.
   */
  answerAfterBatch(sessionId: SessionId, agentId: string | null): ClaudePauseAnswer {
    const leadPause = agentId === null ? this.#leadPauses.get(sessionId) : undefined;
    if (leadPause === undefined) {
      return PASS;
    }
    leadPause.stopAnswered = true;
    return { kind: "answer", response: { continue: false, stopReason: CLAUDE_PAUSED_REASON } };
  }

  /**
   * The paused run whose turn just ended on its pause, or `undefined`. A turn that ended on its own
   * leaves the pause armed for the next; the pause is reported once, so a turn Claude Code starts
   * by itself and the pause stops again reports nothing new.
   */
  takeLeadPauseEffect(sessionId: SessionId): RunId | undefined {
    const leadPause = this.#leadPauses.get(sessionId);
    if (leadPause === undefined || !leadPause.stopAnswered || leadPause.effectReported) {
      return undefined;
    }
    leadPause.effectReported = true;
    return leadPause.runId;
  }

  /** Continues the lead; a pause that had not yet stopped a turn is dropped. */
  resumeLead(sessionId: SessionId): void {
    this.#leadPauses.delete(sessionId);
  }

  /**
   * Continues one helper and answers the callbacks it was held on: with no decision, or denied
   * with `steer` as the reason, which the helper reads as the person's words.
   */
  resumeHelper(
    sessionId: SessionId,
    agentId: string,
    steer: string | undefined,
  ): ClaudeReleasedCallback[] {
    this.#pausedAgents.get(sessionId)?.delete(agentId);
    const held = this.#heldCallbacks.get(sessionId) ?? [];
    const released = held.filter((callback) => callback.agentId === agentId);
    this.#heldCallbacks.set(
      sessionId,
      held.filter((callback) => callback.agentId !== agentId),
    );
    const response = steer === undefined ? {} : denyWith(steer).response;
    return released.map((callback) => ({ requestId: callback.requestId, response }));
  }

  /** Drops a callback Claude Code withdrew; it will not be answered. */
  withdrawCallback(sessionId: SessionId, requestId: string): void {
    const held = this.#heldCallbacks.get(sessionId);
    if (held !== undefined) {
      this.#heldCallbacks.set(
        sessionId,
        held.filter((callback) => callback.requestId !== requestId),
      );
    }
  }

  /** Forgets a session whose process is gone; its holds went with it. */
  forgetSession(sessionId: SessionId): void {
    this.#leadPauses.delete(sessionId);
    this.#pausedAgents.delete(sessionId);
    this.#heldCallbacks.delete(sessionId);
  }
}

function denyWith(reason: string): { readonly kind: "answer"; response: Record<string, unknown> } {
  return {
    kind: "answer",
    response: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    },
  };
}
