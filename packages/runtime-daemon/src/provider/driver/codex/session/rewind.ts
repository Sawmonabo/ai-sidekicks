// Cutting a Codex conversation back in place with `thread/revert`: to before one of the person's
// messages, and to before a turn too long for the model's window.

import type { RewindConversationParams, RewindConversationResult } from "../../rewind.js";
import type { CodexRunControl } from "../run/control.js";
import type { CodexTurnEndWaiters } from "../run/turn-end-waiters.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { CodexConfigForks } from "./config-fork.js";
import { CodexTransportError, normalizeProviderFailureDetail } from "./errors.js";
import { readCodexTurnIdByClientMessageId } from "./history.js";
import type { CodexSessionSlots } from "./slots.js";
import type { CodexSessionRecord } from "./state.js";

/** What cutting a conversation back reads and acts through. */
export interface CodexConversationRewindDependencies {
  readonly slots: CodexSessionSlots;
  readonly configForks: Pick<CodexConfigForks, "requireAfterForks">;
  readonly runControl: CodexRunControl;
  readonly turnEnds: CodexTurnEndWaiters;
  readonly reportDiagnostic: CodexDiagnosticSink;
}

/** Cuts a session's conversation back in place, inside its claimed slot. */
export class CodexConversationRewind {
  readonly #dependencies: CodexConversationRewindDependencies;

  constructor(dependencies: CodexConversationRewindDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Cuts the conversation back to before one of the person's messages; a running turn is stopped
   * and its end awaited first, up to the request deadline. Degrades for a message not in the
   * conversation and for a turn that did not stop; throws `CodexTransportError` when the session
   * was re-established meanwhile.
   */
  async rewind(params: RewindConversationParams): Promise<RewindConversationResult> {
    const { slots } = this.#dependencies;
    const record = await this.#dependencies.configForks.requireAfterForks(params.sessionId);
    const beforeTurnId = await this.#readMessageTurnId(record, params.targetMessageId);
    if (beforeTurnId === undefined) {
      return { status: "degraded", fallbackAction: "rewind-target-not-a-recorded-boundary" };
    }
    if (!(await this.#stopRunningTurns(record))) {
      return { status: "degraded", fallbackAction: "rewind-deferred-turn-in-progress" };
    }
    return await slots.claim(
      params.sessionId,
      "establishing",
      async (): Promise<RewindConversationResult> => {
        if (slots.recordFor(params.sessionId) !== record) {
          throw new CodexTransportError(
            `Codex session "${params.sessionId}" was re-established while its turn was stopping.`,
            { sessionId: params.sessionId, method: "thread/revert" },
          );
        }
        await revertBefore(record, beforeTurnId);
        return { status: "applied" };
      },
    );
  }

  /**
   * Hands a turn too long for the model's window back by cutting it out of the conversation, so
   * the next message does not carry it again. A failure is recorded; the run already failed.
   */
  async cutOversizedTurn(record: CodexSessionRecord, turnId: string): Promise<void> {
    const { slots } = this.#dependencies;
    try {
      await slots.claim(record.sessionId, "establishing", async () => {
        if (slots.recordFor(record.sessionId) === record) {
          await revertBefore(record, turnId);
        }
      });
    } catch (cause) {
      reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
        kind: "oversized-turn-cut-failed",
        sessionId: record.sessionId,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  // Interrupts every running turn and waits for each to end; false when one outlived the deadline.
  async #stopRunningTurns(record: CodexSessionRecord): Promise<boolean> {
    const runningTurns = [...record.runIdByActiveTurnId];
    for (const [, runId] of runningTurns) {
      await this.#dependencies.runControl.interruptRun({ runId });
    }
    const ended = await Promise.all(
      runningTurns.map(
        async ([turnId]) => await this.#dependencies.turnEnds.waitForEnd(record, turnId),
      ),
    );
    return ended.every(Boolean);
  }

  // The turn one of the person's messages started: the daemon's own map, else the conversation's
  // history, which also serves a conversation this daemon did not start or has forked.
  async #readMessageTurnId(
    record: CodexSessionRecord,
    messageId: string,
  ): Promise<string | undefined> {
    const known = record.turnIdByClientMessageId.get(messageId);
    if (known !== undefined && record.turnBoundaries.includes(known)) {
      return known;
    }
    const fromHistory = await readCodexTurnIdByClientMessageId(record.service, record.threadId);
    for (const [historyMessageId, turnId] of fromHistory) {
      record.turnIdByClientMessageId.set(historyMessageId, turnId);
    }
    return fromHistory.get(messageId);
  }
}

// Cuts the conversation back to before a turn and drops the turns and messages it removed.
async function revertBefore(record: CodexSessionRecord, beforeTurnId: string): Promise<void> {
  await record.service.request("thread/revert", { threadId: record.threadId, beforeTurnId });
  const cut = record.turnBoundaries.indexOf(beforeTurnId);
  if (cut >= 0) {
    record.turnBoundaries.length = cut;
  }
  const keptTurnIds = new Set(record.turnBoundaries);
  for (const [messageId, turnId] of record.turnIdByClientMessageId) {
    if (!keptTurnIds.has(turnId)) {
      record.turnIdByClientMessageId.delete(messageId);
    }
  }
}
