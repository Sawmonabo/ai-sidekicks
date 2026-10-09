// The conversation half of an undo: the provider's own cut of the bound conversation, in place,
// back to before one of the person's messages. Files are never the driver's; the daemon's file
// checkpoints put them back.
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * Params of `rewindConversation` (gated on `rollback`). `targetMessageId` is the stable id of the
 * person's message the cut lands before: that message and everything after it leave the
 * conversation. The driver maps it to its provider's own anchor, so no position crosses this seam.
 * `bindingId` is the session's live binding, resolved by the daemon at dispatch.
 */
export interface RewindConversationParams {
  sessionId: SessionId;
  bindingId: string;
  targetMessageId: string;
}

/**
 * What a rewind did. `applied` carries the text of the message the cut removed, for the composer,
 * where the provider returned it, and `bindingId` when the cut restarted the process on a fork of
 * the conversation and so minted a new binding (Claude Code, for a point before its last
 * compaction). `degraded` is a driver that was invoked and took a fallback instead.
 */
export type RewindConversationResult =
  | { status: "applied"; bindingId?: string | undefined; cutMessageText?: string | undefined }
  | { status: "degraded"; fallbackAction?: string | undefined };
