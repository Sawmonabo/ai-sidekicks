// What a tool override pins, in the words the page's per-tool row says it in. The wire's facet
// values never reach the screen.

import type { McpApprovalMode, McpToolOverride } from "@ai-sidekicks/contracts/mcp/mcp";

/** The on-screen words for each approval mode, under `Ask before running`. */
export const APPROVAL_MODE_WORDS: Readonly<Record<McpApprovalMode, string>> = {
  auto: "Run without asking",
  prompt: "Ask every time",
  writes: "Ask before it writes",
  approve: "Ask for approval",
};

/** The on-screen words for each pinned idempotency class, under `If a call is interrupted`. */
export const IDEMPOTENCY_CLASS_WORDS: Readonly<
  Record<NonNullable<McpToolOverride["idempotencyClass"]>, string>
> = {
  idempotent: "Safe to run again",
  compensable: "Can be undone",
};
