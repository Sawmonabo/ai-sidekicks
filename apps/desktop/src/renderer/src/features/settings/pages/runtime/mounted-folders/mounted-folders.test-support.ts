// The cast both mounted-folders suites drive the block and its inventory with: one session,
// one machine, two mounts, and the read shapes.
//
// The ids are UUIDs because request ids are branded UUID scalars that a shipped call parses;
// they are named so cases read as "the first mount".

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo-folders";
import type { WorkspaceListResponse } from "@ai-sidekicks/contracts/workspace";

/** The session both suites read for. */
export const SESSION_ID = "019b7911-0000-7000-8000-000000000001";

/** The machine every mount below is attached on, as the wire's `nodeId` names it. */
const NODE_ID = "019b7911-0003-7000-8000-000000000001";

/** The project every mount below belongs to. */
export const PROJECT_ID = "019b7911-0005-7000-8000-000000000001";

/** The first mount, named so a case reads as a mount rather than as a hex string. */
export const MOUNT_A = "019b7911-0001-7000-8000-00000000000a";

/** The second mount, for the cases that need two. */
export const MOUNT_B = "019b7911-0001-7000-8000-00000000000b";

/** One workspace id, derived from its position so a list of any length is on-contract. */
export function workspaceIdAt(index: number): WorkspaceListResponse["workspaces"][number]["id"] {
  const suffix = String(index).padStart(12, "0");
  return `019b7911-0002-7000-8000-${suffix}` as WorkspaceListResponse["workspaces"][number]["id"];
}

/** One mount id, derived from its position so a list of any length is on-contract. */
export function mountIdAt(index: number): string {
  return `019b7911-0004-7000-8000-${String(index).padStart(12, "0")}`;
}

/** A workspace list naming each of `mountIds`, in order. */
export function workspaceListWith(mountIds: readonly string[]): WorkspaceListResponse {
  return {
    workspaces: mountIds.map((repoMountId, index) => ({
      id: workspaceIdAt(index),
      repoMountId: repoMountId as WorkspaceListResponse["workspaces"][number]["repoMountId"],
      executionMode: "provisioned-worktree",
      state: "ready",
    })),
  };
}

/**
 * One healthy attached mount, with the overrides a case needs to make it otherwise.
 *
 * The overrides land last, so a case writes only the field it moved.
 */
export function mountReadFor(
  repoMountId: string,
  overrides: Partial<RepoMountReadResponse> = {},
): RepoMountReadResponse {
  return {
    id: repoMountId as RepoMountReadResponse["id"],
    nodeId: NODE_ID as RepoMountReadResponse["nodeId"],
    localPath: `/repos/${repoMountId}`,
    canonicalRoot: `/repos/${repoMountId}`,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-09-02T10:00:00.000Z" },
    attachedAt: "2026-09-01T10:00:00.000Z",
    origin: {
      kind: "attached",
      repoMountId: repoMountId as RepoMountReadResponse["id"],
      projectId: PROJECT_ID as ProjectId,
    },
    usedBy: [{ sessionId: SESSION_ID as RepoMountReadResponse["usedBy"][number]["sessionId"] }],
    ...overrides,
  };
}
