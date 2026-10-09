// The purge of Claude Code's own copy of a session's conversations, from the home each one ran
// in. Every conversation is tried; the ones that failed throw together after.

import type { PurgeSessionParams } from "../../session-control.js";
import type { SpawnEnvNameMatch, SpawnEnvPair } from "../../../spawn-env.js";
import { composeClaudeSpawnEnvironment } from "../spawn/environment.js";
import { claudeConfigFolderFor, deleteClaudeConversation } from "./conversation-file.js";
import type { ClaudeSpawnContextResolver } from "./state.js";

/**
 * Deletes every file Claude Code keeps for each conversation from the home it ran in, resolved as a
 * spawn on its account would be. Throws an `AggregateError` of every conversation that failed,
 * after the rest.
 */
export async function purgeClaudeConversations(
  params: PurgeSessionParams,
  spawnContext: ClaudeSpawnContextResolver,
  providerBaseEnvironment: readonly SpawnEnvPair[],
  environmentNameMatch: SpawnEnvNameMatch,
): Promise<void> {
  const failures: unknown[] = [];
  for (const conversation of params.conversations) {
    try {
      const context = await spawnContext.resolveSpawnContext(
        params.sessionId,
        conversation.providerAccountId,
      );
      const spawnEnvironment = composeClaudeSpawnEnvironment({
        providerBaseEnvironment,
        environmentNameMatch,
        environmentRows: context.environmentRows,
        accountFolders: context.accountFolders,
      });
      await deleteClaudeConversation(
        claudeConfigFolderFor(spawnEnvironment),
        context.workingDirectory,
        conversation.resumeHandle,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${String(failures.length)} of the session's Claude Code conversations could not be deleted.`,
    );
  }
}
