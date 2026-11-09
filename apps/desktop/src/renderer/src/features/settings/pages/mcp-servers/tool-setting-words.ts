// What a tool's settings read, in the words the page's per-tool row says them in. The wire's
// values and sources never reach the screen.

import type {
  McpApprovalMode,
  McpToolOverrideFacet,
  McpToolReading,
} from "@ai-sidekicks/contracts/mcp/server";
import type { IdempotencyClass } from "@ai-sidekicks/contracts/provider/driver/tools";

/**
 * One facet of a tool's reading: its value in force, and whether that is the server's own or set
 * here, with the server's own beside an override.
 */
export type McpToolSetting = McpToolReading[McpToolOverrideFacet];

/** Where a facet's value in force came from: the server's own, or set here. */
export type McpToolSettingSource = McpToolSetting["source"];

/** The on-screen words for each approval mode, under `Ask before running`. */
export const APPROVAL_MODE_WORDS: Readonly<Record<McpApprovalMode, string>> = {
  auto: "Codex decides from the tool's annotations",
  prompt: "Always asks",
  writes: "Asks before a tool that writes",
  approve: "Pre-approved, never asks",
};

/** The on-screen words for each interrupted-call class, under `If a call is interrupted`. */
export const IDEMPOTENCY_CLASS_WORDS: Readonly<Record<IdempotencyClass, string>> = {
  idempotent: "Safe to run again",
  compensable: "Can be undone",
  manualReconcileOnly: "Leave it to a person",
};

/** The on-screen words for where a tool's value in force came from. */
export const TOOL_SETTING_SOURCE_WORDS: Readonly<Record<McpToolSettingSource, string>> = {
  server: "The server's own",
  override: "Set here",
};
