// A project's standing rules as Codex keeps them: one rule file of the daemon's own in the
// project's `.codex/rules/`, which Codex reads in conversations started after a change, holding a
// command's `prefix_rule` and a host's `network_rule`. The file stays on this machine: its path is
// added to the repository's own `.git/info/exclude`, which git never commits, and the person's
// tracked `.gitignore` is never touched.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../../../file/atomic-write.js";
import type { ProviderAskRule } from "../../port/permission-ask.js";

// The daemon's rule file, from the project's folder; the exclude line names it from there too.
const CODEX_PROJECT_RULE_FILE = path.join(".codex", "rules", "sidekicks.rules");
const CODEX_PROJECT_RULE_EXCLUDE_LINE = "/.codex/rules/sidekicks.rules";

// Both files are the person's to read, as git and Codex leave such files.
const PROJECT_FILE_MODE = 0o644;

// A host's rule covers both protocols a fetch takes.
const CODEX_NETWORK_RULE_PROTOCOLS = ["https", "http"] as const;

/** Reads the repository's shared git folder for a project folder: the common one of a worktree. */
export type CodexGitFolderReader = (projectFolder: string) => Promise<string>;

// The lines one rule is in Codex's own rule language: a command's words as a prefix, a host's for
// each protocol. Any other kind of rule is one Codex keeps no project file for.
function composeRuleLines(rule: ProviderAskRule): readonly string[] {
  if (rule.action === "command") {
    const words = rule.subject.split(/\s+/u).filter((word) => word !== "");
    const decision = rule.sense === "allow" ? "allow" : "forbidden";
    return [
      `prefix_rule(pattern=[${words.map((word) => JSON.stringify(word)).join(", ")}], decision="${decision}")`,
    ];
  }
  if (rule.action === "network") {
    const decision = rule.sense === "allow" ? "allow" : "deny";
    return CODEX_NETWORK_RULE_PROTOCOLS.map(
      (protocol) =>
        `network_rule(host=${JSON.stringify(rule.subject)}, protocol="${protocol}", decision="${decision}")`,
    );
  }
  throw new TypeError(`Codex keeps no project rule on a ${rule.action} ask`);
}

/**
 * Writes `rule` into the project's rule file, replacing a rule of the other sense over the same
 * subject, and adds the file to the repository's exclude list on its first write.
 */
export async function writeCodexProjectRule(
  projectFolder: string,
  rule: ProviderAskRule,
  readGitFolder: CodexGitFolderReader,
): Promise<void> {
  const opposite = composeRuleLines({ ...rule, sense: rule.sense === "allow" ? "block" : "allow" });
  const written = composeRuleLines(rule);
  await updateRuleFile(projectFolder, (lines) => [
    ...lines.filter((line) => !opposite.includes(line) && !written.includes(line)),
    ...written,
  ]);
  await excludeRuleFile(await readGitFolder(projectFolder));
}

/** Removes a revoked rule from the project's rule file; a file that is not there holds none. */
export async function removeCodexProjectRule(
  projectFolder: string,
  rule: ProviderAskRule,
): Promise<void> {
  const removed = composeRuleLines(rule);
  await updateRuleFile(projectFolder, (lines) => lines.filter((line) => !removed.includes(line)));
}

async function updateRuleFile(
  projectFolder: string,
  change: (lines: readonly string[]) => readonly string[],
): Promise<void> {
  const filePath = path.join(projectFolder, CODEX_PROJECT_RULE_FILE);
  const lines = (await readIfPresent(filePath)).split("\n").filter((line) => line.trim() !== "");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, `${change(lines).join("\n")}\n`, PROJECT_FILE_MODE);
}

// Adds the rule file's line to `<git folder>/info/exclude` once.
async function excludeRuleFile(gitFolder: string): Promise<void> {
  const excludePath = path.join(gitFolder, "info", "exclude");
  const text = await readIfPresent(excludePath);
  if (text.split("\n").includes(CODEX_PROJECT_RULE_EXCLUDE_LINE)) {
    return;
  }
  await mkdir(path.dirname(excludePath), { recursive: true });
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  await writeFileAtomically(
    excludePath,
    `${text}${separator}${CODEX_PROJECT_RULE_EXCLUDE_LINE}\n`,
    PROJECT_FILE_MODE,
  );
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
