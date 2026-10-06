// What a tool's settings read, in the words the page's per-tool row says them in. The wire's
// values and sources never reach the screen.

import type { McpApprovalMode, McpToolSettingSource } from "@ai-sidekicks/contracts/mcp/mcp";
import type { IdempotencyClass } from "@ai-sidekicks/contracts/provider/driver/driver";

/** The on-screen words for each approval mode, under `Ask before running`. */
export const APPROVAL_MODE_WORDS: Readonly<Record<McpApprovalMode, string>> = {
  auto: "Run without asking",
  prompt: "Ask every time",
  writes: "Ask before it writes",
  approve: "Ask for approval",
};

/** The on-screen words for each interrupted-call class, under `If a call is interrupted`. */
export const IDEMPOTENCY_CLASS_WORDS: Readonly<Record<IdempotencyClass, string>> = {
  idempotent: "Safe to run again",
  compensable: "Can be undone",
  manual_reconcile_only: "Leave it to a person",
};

/** The on-screen words for where a tool's value in force came from. */
export const TOOL_SETTING_SOURCE_WORDS: Readonly<Record<McpToolSettingSource, string>> = {
  server: "The server's own",
  override: "Set here",
};
