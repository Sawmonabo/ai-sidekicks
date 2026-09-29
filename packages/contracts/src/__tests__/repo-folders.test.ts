// `repo-folders.ts`: the folders the service can reach with their origins, and
// browsing the machine's folders by token.
import { describe, expect, it } from "vitest";

import {
  FOLDER_LIST_ENTRY_LIMIT,
  RepoFolderListRequestSchema,
  RepoFolderListResponseSchema,
  RepoMountListResponseSchema,
} from "../repo-folders.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

describe("repo.mountList (every folder the service can reach, with its origin)", () => {
  it("lists a project's folder, a chat's managed workspace and an app-made worktree", () => {
    const mounts = [
      {
        path: "/Users/dev/code/beacon",
        origin: { kind: "attached", repoMountId: REPO_MOUNT_ID, projectId: PROJECT_ID },
        usingSessionCount: 2,
        onOtherSideDisk: false,
      },
      {
        path: `/Users/dev/.ai-sidekicks/workspaces/${SESSION_ID}`,
        origin: { kind: "managed", repoMountId: REPO_MOUNT_ID, sessionId: SESSION_ID },
        usingSessionCount: 1,
        onOtherSideDisk: false,
      },
      {
        path: "/Users/dev/.ai-sidekicks/worktrees/beacon/550e8400-fix-login",
        origin: { kind: "worktree", worktreeId: WORKTREE_ID, projectId: PROJECT_ID },
        usingSessionCount: 0,
        onOtherSideDisk: true,
      },
    ];
    expect(RepoMountListResponseSchema.safeParse({ mounts }).success).toBe(true);
  });

  it("refuses a managed workspace that names no chat, and an origin outside the three", () => {
    const entry = (origin: unknown) => ({
      mounts: [{ path: "/p", origin, usingSessionCount: 0, onOtherSideDisk: false }],
    });
    expect(
      RepoMountListResponseSchema.safeParse(entry({ kind: "managed", repoMountId: REPO_MOUNT_ID }))
        .success,
    ).toBe(false);
    expect(
      RepoMountListResponseSchema.safeParse(
        entry({ kind: "plain", repoMountId: REPO_MOUNT_ID, projectId: PROJECT_ID }),
      ).success,
    ).toBe(false);
  });
});

describe("repo.folderList (another device's Open folder…)", () => {
  const segment = { name: "dev", folderToken: "token-dev" };
  const listing = (entryCount: number) => ({
    path: "/Users/dev",
    segments: [segment],
    entries: Array.from({ length: entryCount }, (_, index) => ({
      name: `folder-${String(index)}`,
      folderToken: `token-${String(index)}`,
      isRepository: index === 0,
    })),
    more: false,
  });

  it("takes a token, a filter and the hidden switch, or nothing for the home folder", () => {
    expect(RepoFolderListRequestSchema.safeParse({}).success).toBe(true);
    expect(
      RepoFolderListRequestSchema.safeParse({
        folderToken: "token-dev",
        filter: "pay",
        showHidden: true,
      }).success,
    ).toBe(true);
    expect(RepoFolderListRequestSchema.safeParse({ path: "/etc" }).success).toBe(false);
  });

  it("carries at most the entry limit and the folder in view", () => {
    expect(RepoFolderListResponseSchema.safeParse(listing(FOLDER_LIST_ENTRY_LIMIT)).success).toBe(
      true,
    );
    expect(
      RepoFolderListResponseSchema.safeParse(listing(FOLDER_LIST_ENTRY_LIMIT + 1)).success,
    ).toBe(false);
    expect(RepoFolderListResponseSchema.safeParse({ ...listing(1), segments: [] }).success).toBe(
      false,
    );
  });
});
