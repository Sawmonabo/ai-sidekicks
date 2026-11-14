// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a transcript operation could not carry, named so a client shows the loss rather than a silent gap.

/** Every declared loss kind. */
export const DECLARED_LOSS_KINDS = [
  "providerPrivateReasoning",
  "contextTruncated",
  "toolCallHistoryRepaired",
  "conversationHistorySummarized",
  "helperConversations",
  "toolOutputBodies",
  "liveToolCalls",
  "providerSkillAndCommandNames",
  "turnContentUnavailable",
] as const;

/**
 * One thing a transcript operation could not carry. A new kind is a deliberate addition; an empty
 * list claims nothing was dropped, so a driver that does not know what it lost may not send one.
 */
export type DeclaredLossKind =
  | "providerPrivateReasoning"
  | "contextTruncated"
  | "toolCallHistoryRepaired"
  | "conversationHistorySummarized"
  | "helperConversations"
  | "toolOutputBodies"
  | "liveToolCalls"
  | "providerSkillAndCommandNames"
  | "turnContentUnavailable";

export { validateDeclaredLossKind } from "../../checks/provider/driver/declared-loss.js";
