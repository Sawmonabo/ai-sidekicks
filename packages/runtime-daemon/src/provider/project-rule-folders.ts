// Writes a project rule into each working folder of its project, so it reaches every session of
// the project, and takes it back out of those already written when one write fails, so no folder
// keeps a rule the daemon never recorded.

import type { ProviderAskRule } from "./port/permission-ask.js";

/** Writes one rule into, or removes it from, one working folder's provider file. */
export type ProjectRuleFileChange = (projectFolder: string, rule: ProviderAskRule) => Promise<void>;

/**
 * Writes `rule` into each of `projectFolders` with `write`. When a write fails, removes the rule
 * with `remove` from the folders already written, `writtenAlready` among them, those the rule
 * reached another way, and throws what failed, beside the removal's own failure when that failed
 * too.
 */
export async function writeIntoProjectFolders(
  projectFolders: readonly string[],
  rule: ProviderAskRule,
  write: ProjectRuleFileChange,
  remove: ProjectRuleFileChange,
  writtenAlready: readonly string[] = [],
): Promise<void> {
  const written = [...writtenAlready];
  try {
    for (const projectFolder of projectFolders) {
      await write(projectFolder, rule);
      written.push(projectFolder);
    }
  } catch (writeFailure) {
    try {
      for (const projectFolder of written) {
        await remove(projectFolder, rule);
      }
    } catch (removeFailure) {
      throw new AggregateError(
        [writeFailure, removeFailure],
        "The project rule could not be written into every folder, nor taken back out of those it was",
        { cause: removeFailure },
      );
    }
    throw writeFailure;
  }
}
