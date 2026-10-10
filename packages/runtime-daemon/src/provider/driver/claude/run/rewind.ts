// The conversation cut on Claude Code: `rewind_conversation` cuts the live conversation in place,
// stopping a running turn first. A refusal arrives as a success carrying `rewound: false`, so the
// answer is read from `rewound`, never from the response's subtype. The person's undo cuts back to
// one of their messages, ending the run whose turn the cut took; a turn too long to fit even after
// compaction is cut back out, since every later turn would fail on it again.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject } from "../../../record-readers.js";
import type { RewindConversationResult } from "../../rewind.js";
import type { ClaudeProviderDialogs } from "../delivery/dialogs.js";
import type { ClaudeSessionSlots } from "../session/slots.js";
import type { LiveClaudeSession } from "../session/state.js";
import { ClaudeControlRequestRefusedError } from "../session/transport.js";
import type { ClaudeSentPrompts } from "./prompts.js";
import type { ClaudeRunRoutes } from "./routes.js";

/** What the conversation cuts act through. */
export interface ClaudeConversationCutsDependencies {
  readonly runRoutes: ClaudeRunRoutes;
  readonly slots: ClaudeSessionSlots;
  readonly prompts: ClaudeSentPrompts;
  readonly dialogs: ClaudeProviderDialogs;
  /** Records a cut that failed where no caller can hear it; `step` names it in plain words. */
  readonly recordReportFailure: (sessionId: SessionId, step: string, error: unknown) => void;
}

/** The person's undo and the cut of a turn too long to fit, on live Claude sessions. */
export class ClaudeConversationCuts {
  readonly #dependencies: ClaudeConversationCutsDependencies;

  constructor(dependencies: ClaudeConversationCutsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Cuts the live conversation back to before the person's message `targetMessageId`; see
   * {@link cutClaudeConversation}. A choice the running turn is held on is settled as an
   * interrupt's is, and a run whose turn the cut took ends failed before its route retires, since
   * no turn end can reach it after.
   */
  async rewind(
    live: LiveClaudeSession,
    targetMessageId: string,
  ): Promise<RewindConversationResult> {
    const { runRoutes, slots, prompts, dialogs } = this.#dependencies;
    const lead = runRoutes.leadRunOn(live.sessionId);
    if (lead !== undefined) {
      await dialogs.settleForInterrupt(live, lead.runId);
    }
    const result = await cutClaudeConversation(
      live,
      targetMessageId,
      prompts.newestFor(live.sessionId),
    );
    if (result.status === "applied") {
      slots.retireSupersededTurn(live.sessionId);
      prompts.forgetSession(live.sessionId);
    }
    return result;
  }

  /** Cuts the newest message of a turn too long to fit back out of the conversation. */
  cutTooLongTurn(live: LiveClaudeSession): void {
    const { prompts, recordReportFailure } = this.#dependencies;
    const newestPrompt = prompts.newestFor(live.sessionId);
    if (newestPrompt === undefined) {
      return;
    }
    cutClaudeConversation(live, newestPrompt, newestPrompt).then(
      (result) => {
        if (result.status === "applied") {
          prompts.forgetSession(live.sessionId);
        }
      },
      (error: unknown) => {
        recordReportFailure(live.sessionId, "the cut of a too long turn", error);
      },
    );
  }
}

/**
 * Cuts the live conversation back to before the person's message `targetMessageId`. The newest
 * message the daemon sent is named, since a cut is refused when a later prompt is one Claude Code
 * might not have seen. A refused cut is `degraded` with Claude Code's own reason; a refused request
 * throws `ClaudeControlRequestRefusedError`.
 */
async function cutClaudeConversation(
  live: LiveClaudeSession,
  targetMessageId: string,
  newestPromptUuid: string | undefined,
): Promise<RewindConversationResult> {
  const response = await live.channel.sendControlRequest({
    subtype: "rewind_conversation",
    target_message_uuid: targetMessageId,
    ...(newestPromptUuid === undefined ? {} : { last_seen_user_message_uuid: newestPromptUuid }),
    interrupt_if_running: true,
  });
  if (response.subtype === "error") {
    throw new ClaudeControlRequestRefusedError("rewind_conversation", response.error);
  }
  const reply = isPlainObject(response.response) ? response.response : {};
  if (reply["rewound"] !== true) {
    const reason = reply["reason"];
    return typeof reason === "string" && reason.length > 0
      ? { status: "degraded", fallbackAction: `rewind-refused: ${reason}` }
      : { status: "degraded" };
  }
  const prefillText = reply["prefillText"];
  return typeof prefillText === "string" && prefillText.length > 0
    ? { status: "applied", cutMessageText: prefillText }
    : { status: "applied" };
}
