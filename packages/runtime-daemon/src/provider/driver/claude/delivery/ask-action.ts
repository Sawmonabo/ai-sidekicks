// What a Claude Code tool call held on a permission ask would do, read from its tool and input,
// and the scopes a rule on it may take: Claude Code keeps a rule of every kind for the session and
// in the project's `.claude/settings.local.json`, but none on the plan it asks to leave plan mode
// with, which is a verdict and not a permission.

import type { RememberedScopeKind } from "@ai-sidekicks/contracts/approval";

import type { ProviderAskAction } from "../../../port/permission-ask.js";
import { readNonEmptyString } from "../../../record-readers.js";
import { CLAUDE_PLAN_EXIT_TOOL_NAME } from "../event-normalizer.js";
import { isClaudeFileChangingTool } from "./patches.js";

// The tools that read one file or search under one folder, by the input member naming it.
const CLAUDE_READ_PATH_MEMBER_BY_TOOL: ReadonlyMap<string, string> = new Map([
  ["Read", "file_path"],
  ["Glob", "path"],
  ["Grep", "path"],
]);

const EVERY_RULE_SCOPE: readonly RememberedScopeKind[] = ["session", "project"];

/** What a held Claude Code call would do, and the scopes a rule on it may take. */
export interface ClaudeAskReading {
  readonly action: ProviderAskAction;
  readonly ruleScopes: readonly RememberedScopeKind[];
}

/** Reads a held call's action from Claude Code's own tool name and input. */
export function readClaudeAskAction(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ClaudeAskReading {
  if (toolName === CLAUDE_PLAN_EXIT_TOOL_NAME) {
    return { action: { kind: "plan" }, ruleScopes: [] };
  }
  return { action: readAction(toolName, input), ruleScopes: EVERY_RULE_SCOPE };
}

function readAction(toolName: string, input: Readonly<Record<string, unknown>>): ProviderAskAction {
  const command = toolName === "Bash" ? readNonEmptyString(input, "command") : undefined;
  if (command !== undefined) {
    return { kind: "command", command };
  }
  if (isClaudeFileChangingTool(toolName)) {
    const path =
      readNonEmptyString(input, "file_path") ?? readNonEmptyString(input, "notebook_path");
    if (path !== undefined) {
      return { kind: "file_change", paths: [path] };
    }
  }
  const readMember = CLAUDE_READ_PATH_MEMBER_BY_TOOL.get(toolName);
  const readPath = readMember === undefined ? undefined : readNonEmptyString(input, readMember);
  if (readPath !== undefined) {
    return { kind: "file_read", path: readPath };
  }
  const host = toolName === "WebFetch" ? readHost(input["url"]) : undefined;
  if (host !== undefined) {
    return { kind: "network", host };
  }
  return { kind: "tool", toolName };
}

// The host a fetch names, or `undefined` for a URL that does not parse.
function readHost(url: unknown): string | undefined {
  if (typeof url !== "string" || !URL.canParse(url)) {
    return undefined;
  }
  const host = new URL(url).hostname;
  return host === "" ? undefined : host;
}
