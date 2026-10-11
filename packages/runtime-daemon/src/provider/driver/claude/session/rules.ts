// A session's standing rules as Claude Code keeps them. A session rule lives in the process's flag
// settings, which carry the session's whole allow and deny lists, so a grant, a block and a revoke
// each resend the whole permissions document from the next call. A project rule lives in each
// working folder's `.claude/settings.local.json`: Claude Code writes an allow into its own folder
// when the answer carries it, and the daemon writes it into the project's other folders, writes a
// host's block, which a decline cannot carry, and removes a revoked rule. A command allow a prefix
// rule would stretch over a force push or a branch delete is never handed over: the daemon answers
// each ask it covers.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { DiskFlush } from "../../../../disk-flush/contract.js";
import { writeFileAtomically } from "../../../../file/atomic-write.js";
import { coversDestructiveGit } from "../../../../policy/destructive-git.js";
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
// and with any arguments after it, so it never reaches a longer program name; one that would also
// cover a destructive git command is none.
function composeRuleValues(rule: ProviderAskRule): readonly ClaudePermissionRuleValue[] {
  switch (rule.action) {
    case "command":
      return coversDestructiveGit(rule)
        ? []
        : [
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
 * its own folder's `.claude/settings.local.json`, or `undefined` for an allow never handed over.
 */
export function composeClaudeProjectAllowUpdate(
  rule: ProviderAskRule,
): Record<string, unknown> | undefined {
  const rules = composeRuleValues(rule);
  return rules.length === 0
    ? undefined
    : { type: "addRules", rules, behavior: "allow", destination: "localSettings" };
}

/**
 * Adds a project rule to `projectFolder`'s local settings once, in the list of its sense, and takes
 * the same entries out of the other list, so an allow and a block never stand together.
 */
export async function writeClaudeProjectRule(
  projectFolder: string,
  rule: ProviderAskRule,
  diskFlush: DiskFlush,
): Promise<void> {
  const written = composeRuleValues(rule).map(writeRuleValue);
  if (written.length === 0) {
    return;
  }
  const [list, other] =
    rule.sense === "allow" ? (["allow", "deny"] as const) : (["deny", "allow"] as const);
  await updateClaudeLocalSettings(
    projectFolder,
    (lists) => {
      const entries = lists.get(list) ?? [];
      lists.set(
        other,
        (lists.get(other) ?? []).filter((entry) => !written.includes(entry)),
      );
      lists.set(list, [...entries, ...written.filter((entry) => !entries.includes(entry))]);
    },
    true,
    diskFlush,
  );
}

/**
 * Removes a revoked project rule from `projectFolder`'s local settings; a folder with no such file
 * holds none, and no file is made for it.
 */
export async function removeClaudeProjectRule(
  projectFolder: string,
  rule: ProviderAskRule,
  diskFlush: DiskFlush,
): Promise<void> {
  const list = rule.sense === "allow" ? "allow" : "deny";
  const written = composeRuleValues(rule).map(writeRuleValue);
  await updateClaudeLocalSettings(
    projectFolder,
    (lists) => {
      lists.set(
        list,
        (lists.get(list) ?? []).filter((entry) => !written.includes(entry)),
      );
    },
    false,
    diskFlush,
  );
}

// Reads the file's `permissions` lists, changes them and writes the file whole, keeping every
// other setting the person has in it; with `canCreate` false a missing file is left missing. A
// file that is not a JSON object is refused rather than overwritten.
async function updateClaudeLocalSettings(
  projectFolder: string,
  change: (lists: Map<"allow" | "deny", string[]>) => void,
  canCreate: boolean,
  diskFlush: DiskFlush,
): Promise<void> {
  const filePath = path.join(projectFolder, CLAUDE_LOCAL_SETTINGS_PATH);
  const settings = await readLocalSettings(filePath);
  if (settings === undefined && !canCreate) {
    return;
  }
  const permissionsSetting = settings?.["permissions"];
  const permissions = isPlainObject(permissionsSetting) ? permissionsSetting : {};
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
  const next = { ...(settings ?? {}), permissions: { ...permissions, ...written } };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(
    filePath,
    `${JSON.stringify(next, null, 2)}\n`,
    CLAUDE_LOCAL_SETTINGS_MODE,
    diskFlush,
  );
}

// The file's settings, or `undefined` where there is no file.
async function readLocalSettings(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const settings: unknown = JSON.parse(text);
  if (!isPlainObject(settings)) {
    throw new TypeError(`${filePath} does not hold a settings object`);
  }
  return settings;
}
