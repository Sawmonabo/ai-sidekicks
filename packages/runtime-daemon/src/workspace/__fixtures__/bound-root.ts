import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WorkspaceService } from "../service.js";

/**
 * Binds a bound-root workspace and completes its preparation at `fsRoot`, its own checkout, so it
 * is `ready`.
 */
export async function bindReadyWorkspace(
  workspaces: WorkspaceService,
  sessionId: SessionId,
  repoMountId: RepoMountId,
  fsRoot: string,
): Promise<string> {
  const bound = await workspaces.bind({ sessionId, repoMountId, executionMode: "bound-root" });
  await workspaces.completeRootPreparation(bound.workspaceId, fsRoot, { checkoutRoot: fsRoot });
  return String(bound.workspaceId);
}
