// What a Claude Code tool call held on a permission ask would do, read from its tool and input,
// and the scopes a rule on it may take: Claude Code keeps a rule of every kind for the session and
// in the project's `.claude/settings.local.json`, but none on the plan it asks to leave plan mode
// with, which is a verdict and not a permission, and none on a call its own safety check flagged
// (`suppress_always_allow_rule`), which only a person may allow, each time.

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

// The member of an ask Claude Code's safety check set to offer no standing allow.
const CLAUDE_SUPPRESS_ALLOW_MEMBER = "suppress_always_allow_rule";

/**
 * What a held Claude Code call would do, the scopes a rule on it may take, and whether Claude Code
 * flagged it as one no standing allow may answer.
 */
export interface ClaudeAskReading {
  readonly action: ProviderAskAction;
  readonly ruleScopes: readonly RememberedScopeKind[];
  readonly isProviderFlagged: boolean;
}

/** Reads a held call's action from its `can_use_tool` request's tool name, input and flags. */
export function readClaudeAskAction(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  request: Readonly<Record<string, unknown>>,
): ClaudeAskReading {
  if (toolName === CLAUDE_PLAN_EXIT_TOOL_NAME) {
    return { action: { kind: "plan" }, ruleScopes: [], isProviderFlagged: false };
  }
  const isProviderFlagged = request[CLAUDE_SUPPRESS_ALLOW_MEMBER] === true;
  return {
    action: readAction(toolName, input),
    ruleScopes: isProviderFlagged ? [] : EVERY_RULE_SCOPE,
    isProviderFlagged,
  };
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
