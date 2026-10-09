// Deleting Codex's own copy of a session's conversations, each on the service of the account
// home it ran in, and the session's helper role files. Codex refuses to delete a conversation a
// fork still builds on, so they go newest first, as the daemon lists them. The person's own Codex
// folder keeps its conversations.

import type { PurgeSessionParams } from "../../session-control.js";
import type { CodexServiceRegistry } from "../service/registry.js";
import { removeCodexHelperRoles } from "./helper-roles.js";

/**
 * Deletes every conversation the session opened with `thread/delete` and the session's role files
 * under `helperRolesFolder`, trying each before it throws, so one refusal leaves nothing else
 * behind; several failures throw together.
 */
export async function purgeCodexConversations(
  services: CodexServiceRegistry,
  helperRolesFolder: string,
  params: PurgeSessionParams,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await removeCodexHelperRoles(helperRolesFolder, params.sessionId);
  } catch (cause) {
    failures.push(cause);
  }
  for (const conversation of params.conversations) {
    try {
      const service = await services.serviceFor(conversation.providerAccountId);
      if (!service.home.isManaged) {
        continue;
      }
      await service.ensureStarted();
      await service.request("thread/delete", { threadId: conversation.resumeHandle });
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} Codex conversations were not deleted.`);
  }
}
