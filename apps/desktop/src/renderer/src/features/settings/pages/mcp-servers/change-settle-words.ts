// When a change made on the MCP servers page takes effect, in the one line the page settles it
// with for each grade the background service answered. The grade itself never reaches the screen.

import type { McpApplicationGrade } from "@ai-sidekicks/contracts/mcp/server";

/**
 * The line a change settles with for one grade, naming by `providerName` the provider whose
 * settings it reached.
 */
export function settleLineFor(grade: McpApplicationGrade, providerName: string): string {
  switch (grade) {
    case "liveReconcile":
      return "Applied to running sessions.";
    case "userConfigWrite":
      return `Saved to ${providerName}'s settings. New sessions use it.`;
    case "nextRun":
      return "Saved. The next session uses it.";
    case "daemonEnforced":
      return "In force now.";
  }
}
