// The helpers a session's Codex conversation may start, as Codex's own role files: one file per
// helper in the daemon's folder for the session, each a standalone config layer Codex reads when
// the lead starts that helper, and the conversation pointed at each file by name. The folder is
// rewritten at every start and resume, and removed with the session's other daemon state.

import { mkdir, rename, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify } from "@decimalturn/toml-patch";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { SubagentDefinition } from "../../contract.js";
import { CodexDriverConfigError } from "./errors.js";

/** One helper as the conversation's config names it: its role and the file that defines it. */
export interface CodexHelperRole {
  /** The helper's name, which the lead's helper tool takes as the role. */
  readonly name: string;
  readonly description: string;
  /** The role file's absolute path. */
  readonly configFile: string;
}

/** A definition field a Codex role file has no place for, so the file carries none of it. */
export type CodexRoleFileWithheldField = "tools" | "maxTurns";

/**
 * The role file's TOML for one helper: `name`, `description` and `developer_instructions` always,
 * since Codex skips a role file without them, then `model` and `model_reasoning_effort` where the
 * definition sets them. Throws `CodexDriverConfigError` for blank instructions or description,
 * which Codex refuses.
 */
function composeCodexRoleFile(definition: SubagentDefinition): string {
  for (const field of ["prompt", "description"] as const) {
    if (definition[field].trim().length === 0) {
      throw new CodexDriverConfigError(
        `The helper "${definition.name}" cannot run on Codex: its ${field} is blank.`,
        `subagentPolicy.definitions.${field}`,
      );
    }
  }
  return stringify({
    name: definition.name,
    description: definition.description,
    developer_instructions: definition.prompt,
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.effort === undefined ? {} : { model_reasoning_effort: definition.effort }),
  });
}

/** The fields of `definition` a Codex role file cannot carry, in a fixed order. */
export function readCodexRoleFileWithheldFields(
  definition: SubagentDefinition,
): CodexRoleFileWithheldField[] {
  return [
    ...(definition.tools === undefined ? [] : (["tools"] as const)),
    ...(definition.maxTurns === undefined ? [] : (["maxTurns"] as const)),
  ];
}

/**
 * Writes one role file per definition into the session's folder under `rolesFolder` and removes
 * any file an earlier start left there; with no definitions the folder goes. Each file is replaced
 * in one rename, so a helper starting meanwhile reads a whole file. Readable by the person alone.
 * Throws what {@link composeCodexRoleFile} throws before anything is written, and any file-system
 * failure.
 */
export async function writeCodexHelperRoles(
  rolesFolder: string,
  sessionId: SessionId,
  definitions: readonly SubagentDefinition[],
): Promise<CodexHelperRole[]> {
  const files = definitions.map((definition, index) => ({
    definition,
    // The index keeps two names apart that differ only in characters a file name cannot hold.
    fileName: `${String(index + 1)}-${definition.name.replace(/[^A-Za-z0-9_-]/g, "-")}.toml`,
    text: composeCodexRoleFile(definition),
  }));
  if (files.length === 0) {
    await removeCodexHelperRoles(rolesFolder, sessionId);
    return [];
  }
  const sessionFolder = path.join(rolesFolder, sessionId);
  await mkdir(sessionFolder, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const filePath = path.join(sessionFolder, file.fileName);
    const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
    await writeFile(temporaryPath, file.text, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  }
  const kept = new Set(files.map((file) => file.fileName));
  for (const entry of await readdir(sessionFolder)) {
    if (!kept.has(entry)) {
      await rm(path.join(sessionFolder, entry), { force: true });
    }
  }
  return files.map((file) => ({
    name: file.definition.name,
    description: file.definition.description,
    configFile: path.join(sessionFolder, file.fileName),
  }));
}

/** Removes the session's role files and their folder; a session that had none resolves. */
export async function removeCodexHelperRoles(
  rolesFolder: string,
  sessionId: SessionId,
): Promise<void> {
  await rm(path.join(rolesFolder, sessionId), { recursive: true, force: true });
}
