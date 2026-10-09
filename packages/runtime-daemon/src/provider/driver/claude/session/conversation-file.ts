// Claude Code's own record of one conversation, `<config folder>/projects/<project>/<id>.jsonl`:
// one JSON entry per line, each with its own `uuid`. Read to find where a resume lands and which
// message a fork keeps up to; deleted on a purge with every other file Claude Code keeps for the
// conversation under the same config folder.

import { createReadStream } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import { findClaudePlanFiles } from "./plan-files.js";

/**
 * The folder a Claude Code process started in `spawnEnvironment` keeps its conversations in: the
 * account home it names, else the person's own `~/.claude`.
 */
export function claudeConfigFolderFor(spawnEnvironment: readonly SpawnEnvPair[]): string {
  const configured = spawnEnvironment.find(([name]) => name === "CLAUDE_CONFIG_DIR")?.[1];
  if (configured !== undefined) {
    return configured;
  }
  const home = spawnEnvironment.find(([name]) => name === "HOME")?.[1] ?? os.homedir();
  return path.join(home, ".claude");
}

/** The turns one conversation file holds: the last entry's uuid at the end of each turn. */
export interface ClaudeConversationOutline {
  /** Index `n` is the uuid of the last entry of turn `n + 1`, so the length is the turn count. */
  readonly turnEndUuids: readonly string[];
}

/** Finds the conversation's file under any project folder of `configFolder`, or `undefined`. */
export async function findClaudeConversationFile(
  configFolder: string,
  providerSessionId: string,
): Promise<string | undefined> {
  const projectsFolder = path.join(configFolder, "projects");
  const projectFolders = await readdir(projectsFolder, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isMissingPath(error)) {
        return [];
      }
      throw error;
    },
  );
  for (const projectFolder of projectFolders) {
    if (!projectFolder.isDirectory()) {
      continue;
    }
    const entries = await readdir(path.join(projectsFolder, projectFolder.name));
    if (entries.includes(`${providerSessionId}.jsonl`)) {
      return path.join(projectsFolder, projectFolder.name, `${providerSessionId}.jsonl`);
    }
  }
  return undefined;
}

// A person's prompt: a user entry that is no tool result and no entry Claude Code wrote itself.
function isPersonPrompt(entry: Record<string, unknown>): boolean {
  if (entry["type"] !== "user" || entry["isMeta"] === true) {
    return false;
  }
  const message = entry["message"];
  if (!isPlainObject(message)) {
    return false;
  }
  const content = message["content"];
  if (typeof content === "string") {
    return true;
  }
  return (
    Array.isArray(content) &&
    !content.some((block) => isPlainObject(block) && block["type"] === "tool_result")
  );
}

/** Reads a conversation file's turns, streaming it line by line; a malformed line is skipped. */
export async function readClaudeConversationOutline(
  filePath: string,
): Promise<ClaudeConversationOutline> {
  const turnEndUuids: string[] = [];
  let lastUuid: string | undefined;
  let promptSeen = false;
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry)) {
      continue;
    }
    if (isPersonPrompt(entry)) {
      if (promptSeen && lastUuid !== undefined) {
        turnEndUuids.push(lastUuid);
      }
      promptSeen = true;
    }
    lastUuid = readNonEmptyString(entry, "uuid") ?? lastUuid;
  }
  if (promptSeen && lastUuid !== undefined) {
    turnEndUuids.push(lastUuid);
  }
  return { turnEndUuids };
}

// A plan file's name as the conversation's entries carry it: words and hyphens only, so a name
// read off the file can never reach outside a plans folder.
const CLAUDE_PLAN_SLUG_PATTERN = /^[A-Za-z0-9-]+$/;

// The name of the conversation's plan file, the `slug` its entries carry, read up to the first one.
async function readClaudePlanSlug(filePath: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const slug = isPlainObject(entry) ? readNonEmptyString(entry, "slug") : undefined;
    if (slug !== undefined && CLAUDE_PLAN_SLUG_PATTERN.test(slug)) {
      lines.close();
      return slug;
    }
  }
  return undefined;
}

/**
 * Deletes every file Claude Code keeps for one conversation under `configFolder`, where each
 * exists: the conversation file and its folder of helper transcripts and tool results, its file
 * history, session environment, task list, debug log, and its plan files, in the plans folder the
 * settings of `configFolder` and of the project at `projectFolder` name.
 */
export async function deleteClaudeConversation(
  configFolder: string,
  projectFolder: string,
  providerSessionId: string,
): Promise<void> {
  const filePath = await findClaudeConversationFile(configFolder, providerSessionId);
  const planSlug = filePath === undefined ? undefined : await readClaudePlanSlug(filePath);
  const removed = [
    path.join(configFolder, "file-history", providerSessionId),
    path.join(configFolder, "session-env", providerSessionId),
    path.join(configFolder, "tasks", providerSessionId),
    path.join(configFolder, "debug", `${providerSessionId}.txt`),
    ...(planSlug === undefined
      ? []
      : await findClaudePlanFiles(configFolder, projectFolder, planSlug)),
    ...(filePath === undefined
      ? []
      : [filePath, path.join(path.dirname(filePath), providerSessionId)]),
  ];
  // The conversation file goes last, since it names the plan file a failed purge must find again.
  for (const removedPath of removed) {
    await rm(removedPath, { recursive: true, force: true });
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
