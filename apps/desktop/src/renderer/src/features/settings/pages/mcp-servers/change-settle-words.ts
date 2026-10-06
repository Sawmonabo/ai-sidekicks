// When a change made on the MCP servers page takes effect, in the one line the page settles it
// with for each grade the background service answered. The grade itself never reaches the screen.

import type { McpApplicationGrade } from "@ai-sidekicks/contracts/mcp/server";
import { PROVIDER_LABELS, type ProviderName } from "@ai-sidekicks/contracts/provider/name";

/** The line a change settles with for one grade, naming the provider whose settings it reached. */
export function settleLineFor(grade: McpApplicationGrade, provider: ProviderName): string {
  switch (grade) {
    case "live_reconcile":
      return "Applied to running sessions.";
    case "user_config_write":
      return `Saved to ${PROVIDER_LABELS[provider]}'s settings. New sessions use it.`;
    case "next_run":
      return "Saved. The next session uses it.";
    case "daemon_enforced":
      return "In force now.";
  }
}
