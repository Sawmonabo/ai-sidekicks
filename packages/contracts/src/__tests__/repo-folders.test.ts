// `repo-folders.ts`: the folders the service can reach with their origins,
// browsing the machine's folders by token, and one folder's attach, read and
// detach.
import { describe, expect, it } from "vitest";

import {
  FOLDER_LIST_ENTRY_LIMIT,
  RepoAttachRequestSchema,
  RepoAttachResponseSchema,
  RepoDetachResponseSchema,
  RepoFolderListRequestSchema,
  RepoFolderListResponseSchema,
  RepoMountListResponseSchema,
  RepoMountReadResponseSchema,
} from "../repo-folders.js";
import { FILE_PATH_MAX_LEN } from "../session.js";

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

// The entered path and the resolved root differ on purpose: attaching from
// inside the repository is the case that separates them.
const LOCAL_PATH = "/Users/dev/projects/ai-sidekicks/packages/contracts";
const CANONICAL_ROOT = "/Users/dev/projects/ai-sidekicks";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";

describe("repo.attach (a path on this machine, or a token from another device)", () => {
  it("takes a path or a folder token, never both and never neither", () => {
    expect(RepoAttachRequestSchema.safeParse({ localPath: LOCAL_PATH }).success).toBe(true);
    expect(RepoAttachRequestSchema.safeParse({ folderToken: "token-beacon" }).success).toBe(true);
    expect(
      RepoAttachRequestSchema.safeParse({ localPath: LOCAL_PATH, folderToken: "token-beacon" })
        .success,
    ).toBe(false);
    expect(RepoAttachRequestSchema.safeParse({}).success).toBe(false);
    expect(RepoAttachRequestSchema.safeParse({ folderToken: "" }).success).toBe(false);
  });

  it("bounds the path and refuses a blank or NUL-bearing one", () => {
    const parsePath = (localPath: string) => RepoAttachRequestSchema.safeParse({ localPath });
    expect(parsePath("/".repeat(FILE_PATH_MAX_LEN)).success).toBe(true);
    expect(parsePath("/".repeat(FILE_PATH_MAX_LEN + 1)).success).toBe(false);
    expect(parsePath("   ").success).toBe(false);
    expect(parsePath(`/safe/dir${String.fromCharCode(0)}/../../etc`).success).toBe(false);
  });

  it.each([
    ["a relative path", "repos/ai-sidekicks"],
    ["a parent-traversal path", "../sibling/repo"],
    ["a Windows absolute path", "C:\\repos\\ai-sidekicks"],
    ["a tilde-prefixed path", "~/projects/repo"],
  ])("admits %s: the daemon's resolver judges it, not the schema", (_label, localPath) => {
    expect(RepoAttachRequestSchema.safeParse({ localPath }).success).toBe(true);
  });

  it("answers the resolved root, and never a partial success without one", () => {
    const reply = {
      repoMountId: REPO_MOUNT_ID,
      state: "attached",
      vcsType: "git",
      canonicalRoot: CANONICAL_ROOT,
    };
    expect(RepoAttachResponseSchema.safeParse(reply).success).toBe(true);
    expect(RepoAttachResponseSchema.safeParse({ ...reply, canonicalRoot: "" }).success).toBe(false);
    const { canonicalRoot: _omitted, ...withoutRoot } = reply;
    expect(RepoAttachResponseSchema.safeParse(withoutRoot).success).toBe(false);
  });
});

describe("repo.mountRead (one folder, where it came from, and what uses it)", () => {
  const mountRead = {
    id: REPO_MOUNT_ID,
    nodeId: "node-alpha-01",
    localPath: LOCAL_PATH,
    canonicalRoot: CANONICAL_ROOT,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-07-24T19:14:35.000Z" },
    attachedAt: "2026-07-24T19:14:35.000Z",
    origin: { kind: "attached", repoMountId: REPO_MOUNT_ID, projectId: PROJECT_ID },
    displayName: "beacon",
    usedBy: [{ sessionId: SESSION_ID }],
  };

  it("reads a project's folder with its origin, its project's name and its users", () => {
    expect(RepoMountReadResponseSchema.safeParse(mountRead).success).toBe(true);
  });

  it("reads a chat's own workspace, which names its chat and no project", () => {
    const { displayName: _projectName, ...chatWorkspace } = mountRead;
    expect(
      RepoMountReadResponseSchema.safeParse({
        ...chatWorkspace,
        origin: { kind: "managed", repoMountId: REPO_MOUNT_ID, sessionId: SESSION_ID },
        usedBy: [],
      }).success,
    ).toBe(true);
  });

  it("requires the origin and the users", () => {
    const { origin: _origin, ...withoutOrigin } = mountRead;
    const { usedBy: _usedBy, ...withoutUsers } = mountRead;
    expect(RepoMountReadResponseSchema.safeParse(withoutOrigin).success).toBe(false);
    expect(RepoMountReadResponseSchema.safeParse(withoutUsers).success).toBe(false);
  });

  it("names its key `id`, not `repoMountId`", () => {
    const { id: _id, ...withoutId } = mountRead;
    expect(
      RepoMountReadResponseSchema.safeParse({ ...withoutId, repoMountId: REPO_MOUNT_ID }).success,
    ).toBe(false);
  });

  it("takes the node id as an opaque string, and refuses a health or state outside its set", () => {
    expect(
      RepoMountReadResponseSchema.safeParse({ ...mountRead, nodeId: "cli-daemon@host.local" })
        .success,
    ).toBe(true);
    expect(
      RepoMountReadResponseSchema.safeParse({
        ...mountRead,
        health: { status: "unknown", checkedAt: "2026-07-24T19:14:35.000Z" },
      }).success,
    ).toBe(false);
    expect(
      RepoMountReadResponseSchema.safeParse({ ...mountRead, state: "preparing" }).success,
    ).toBe(false);
    expect(RepoMountReadResponseSchema.safeParse({ ...mountRead, vcsType: "hg" }).success).toBe(
      false,
    );
  });
});

describe("repo.detach (a project's Delete)", () => {
  const detached = {
    repoMountId: REPO_MOUNT_ID,
    state: "detached",
    archivedWorkspaceIds: [WORKSPACE_ID],
    archivedSessionIds: [SESSION_ID],
    forgottenProjectId: PROJECT_ID,
  };

  it("names the archived workspaces and sessions and the forgotten project", () => {
    expect(RepoDetachResponseSchema.safeParse(detached).success).toBe(true);
  });

  it("answers a repeat on a detached folder with nothing archived and no project forgotten", () => {
    expect(
      RepoDetachResponseSchema.safeParse({
        ...detached,
        archivedWorkspaceIds: [],
        archivedSessionIds: [],
        forgottenProjectId: null,
      }).success,
    ).toBe(true);
  });

  it("requires the archived sessions and the forgotten project, and refuses a malformed id", () => {
    const { archivedSessionIds: _sessions, ...withoutSessions } = detached;
    const { forgottenProjectId: _project, ...withoutProject } = detached;
    expect(RepoDetachResponseSchema.safeParse(withoutSessions).success).toBe(false);
    expect(RepoDetachResponseSchema.safeParse(withoutProject).success).toBe(false);
    expect(
      RepoDetachResponseSchema.safeParse({ ...detached, archivedSessionIds: ["session-2"] })
        .success,
    ).toBe(false);
  });
});
