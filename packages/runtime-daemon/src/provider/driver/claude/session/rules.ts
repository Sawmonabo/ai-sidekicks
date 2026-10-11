// A session's standing rules as Claude Code keeps them. A session rule lives in the process's flag
// settings, which carry the session's whole allow and deny lists, so a grant, a block and a revoke
// each resend the whole permissions document from the next call. A project rule lives in the
// project's `.claude/settings.local.json`: Claude Code writes an allow itself when the answer
// carries it, and the daemon writes a host's block, which a decline cannot carry, and removes a
// revoked rule.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../../../../file/atomic-write.js";
import type { ProviderAskRule } from "../../../port/permission-ask.js";
import { isPlainObject } from "../../../record-readers.js";

/** One Claude Code permission rule: its tool and, where it names one, what the rule matches. */
interface ClaudePermissionRuleValue {
  readonly toolName: string;
  readonly ruleContent?: string;
}

// The project's own settings file Claude Code keeps on this machine, beside the shared one.
const CLAUDE_LOCAL_SETTINGS_PATH = path.join(".claude", "settings.local.json");

// The local settings file is the person's own, readable as Claude Code leaves it.
const CLAUDE_LOCAL_SETTINGS_MODE = 0o644;

// A rule's path: an absolute one is written with a leading `//`, which roots it at `/`; any other
// is read from the project's folder, as the call named it.
function pathRuleContent(filePath: string): string {
  return path.isAbsolute(filePath) ? `/${filePath}` : filePath;
}

// The rules one standing rule is in Claude Code's own words. A command's covers the command alone
// and with any arguments after it, so it never reaches a longer program name.
function composeRuleValues(rule: ProviderAskRule): readonly ClaudePermissionRuleValue[] {
  switch (rule.action) {
    case "command":
      return [
        { toolName: "Bash", ruleContent: rule.subject },
        { toolName: "Bash", ruleContent: `${rule.subject} *` },
      ];
    case "file_change":
      return [{ toolName: "Edit", ruleContent: pathRuleContent(rule.subject) }];
    case "file_read":
      return [{ toolName: "Read", ruleContent: pathRuleContent(rule.subject) }];
    case "network":
      return [{ toolName: "WebFetch", ruleContent: `domain:${rule.subject}` }];
    case "tool":
      return [{ toolName: rule.subject }];
    case "command_input":
    case "plan":
      throw new TypeError(`A Claude Code rule is never kept on a ${rule.action} ask`);
  }
}

function writeRuleValue(value: ClaudePermissionRuleValue): string {
  return value.ruleContent === undefined
    ? value.toolName
    : `${value.toolName}(${value.ruleContent})`;
}

/**
 * The permission rule strings of the session's own rules, allows and blocks apart, as the flag
 * settings' `allow` and `deny` lists carry them.
 */
export function composeClaudeSessionRuleLists(rules: readonly ProviderAskRule[]): {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
} {
  const written = (sense: ProviderAskRule["sense"]): string[] =>
    rules
      .filter((rule) => rule.sense === sense)
      .flatMap((rule) => composeRuleValues(rule).map(writeRuleValue));
  return { allow: written("allow"), deny: written("block") };
}

/**
 * The permission update an approval's answer carries so Claude Code writes the project allow into
 * the project's `.claude/settings.local.json` itself.
 */
export function composeClaudeProjectAllowUpdate(rule: ProviderAskRule): Record<string, unknown> {
  return {
    type: "addRules",
    rules: composeRuleValues(rule),
    behavior: "allow",
    destination: "localSettings",
  };
}

/** Adds a host's project block to `projectFolder`'s local settings as a deny, once. */
export async function writeClaudeProjectBlock(
  projectFolder: string,
  rule: ProviderAskRule,
): Promise<void> {
  await updateClaudeLocalSettings(projectFolder, (lists) => {
    const deny = lists.get("deny") ?? [];
    const allow = lists.get("allow") ?? [];
    const written = composeRuleValues(rule).map(writeRuleValue);
    // A block replaces an allow over the same subject, so the two never stand together.
    lists.set(
      "allow",
      allow.filter((entry) => !written.includes(entry)),
    );
    lists.set("deny", [...deny, ...written.filter((entry) => !deny.includes(entry))]);
  });
}

/**
 * Removes a revoked project rule from `projectFolder`'s local settings; a missing file has none.
 */
export async function removeClaudeProjectRule(
  projectFolder: string,
  rule: ProviderAskRule,
): Promise<void> {
  const list = rule.sense === "allow" ? "allow" : "deny";
  const written = composeRuleValues(rule).map(writeRuleValue);
  await updateClaudeLocalSettings(projectFolder, (lists) => {
    lists.set(
      list,
      (lists.get(list) ?? []).filter((entry) => !written.includes(entry)),
    );
  });
}

// Reads the file's `permissions` lists, changes them and writes the file whole, keeping every
// other setting the person has in it. A file that is not a JSON object is refused rather than
// overwritten.
async function updateClaudeLocalSettings(
  projectFolder: string,
  change: (lists: Map<"allow" | "deny", string[]>) => void,
): Promise<void> {
  const filePath = path.join(projectFolder, CLAUDE_LOCAL_SETTINGS_PATH);
  const settings = await readLocalSettings(filePath);
  const permissions = isPlainObject(settings["permissions"]) ? settings["permissions"] : {};
  const lists = new Map<"allow" | "deny", string[]>();
  for (const list of ["allow", "deny"] as const) {
    const entries = permissions[list];
    lists.set(
      list,
      Array.isArray(entries)
        ? entries.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  }
  change(lists);
  // A list the file never had and the change left empty is not added to it.
  const written = Object.fromEntries(
    [...lists].filter(([list, entries]) => list in permissions || entries.length > 0),
  );
  const next = { ...settings, permissions: { ...permissions, ...written } };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(
    filePath,
    `${JSON.stringify(next, null, 2)}\n`,
    CLAUDE_LOCAL_SETTINGS_MODE,
  );
}

async function readLocalSettings(filePath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const settings: unknown = JSON.parse(text);
  if (!isPlainObject(settings)) {
    throw new TypeError(`${filePath} does not hold a settings object`);
  }
  return settings;
}
