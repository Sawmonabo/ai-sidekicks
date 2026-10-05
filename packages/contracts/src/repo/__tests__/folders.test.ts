// `repo/folders.ts`: browsing the machine's folders by token, and one folder's attach, read and
// detach. A listing names the folder in view; attach takes exactly one of a path or a token and
// answers the resolved root or nothing.
import { describe, expect, it } from "vitest";

import {
  RepoAttachRequestSchema,
  RepoAttachResponseSchema,
  RepoDetachResponseSchema,
  RepoFolderListResponseSchema,
  RepoMountReadResponseSchema,
} from "../folders.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

// The entered path and the resolved root differ on purpose: attaching from inside the repository
// is the case that separates them.
const LOCAL_PATH = "/Users/dev/projects/ai-sidekicks/packages/contracts";
const CANONICAL_ROOT = "/Users/dev/projects/ai-sidekicks";

describe("repo.folderList (another device's Open folder…)", () => {
  const listing = (entryCount: number) => ({
    path: "/Users/dev",
    segments: [{ name: "dev", folderToken: "token-dev" }],
    entries: Array.from({ length: entryCount }, (_, index) => ({
      name: `folder-${String(index)}`,
      folderToken: `token-${String(index)}`,
      isRepository: index === 0,
    })),
    more: false,
  });

  it("carries the folder in view", () => {
    expect(RepoFolderListResponseSchema.safeParse(listing(1)).success).toBe(true);
    expect(RepoFolderListResponseSchema.safeParse({ ...listing(1), segments: [] }).success).toBe(
      false,
    );
  });
});

describe("repo.attach (a path on this machine, or a token from another device)", () => {
  it("takes a path or a folder token, never both and never neither", () => {
    expect(RepoAttachRequestSchema.safeParse({ localPath: LOCAL_PATH }).success).toBe(true);
    expect(RepoAttachRequestSchema.safeParse({ folderToken: "token-beacon" }).success).toBe(true);
    expect(
      RepoAttachRequestSchema.safeParse({ localPath: LOCAL_PATH, folderToken: "token-beacon" })
        .success,
    ).toBe(false);
    expect(RepoAttachRequestSchema.safeParse({}).success).toBe(false);
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

  it("reads a folder, and refuses a health outside its set", () => {
    expect(RepoMountReadResponseSchema.safeParse(mountRead).success).toBe(true);
    expect(
      RepoMountReadResponseSchema.safeParse({
        ...mountRead,
        health: { status: "unknown", checkedAt: "2026-07-24T19:14:35.000Z" },
      }).success,
    ).toBe(false);
  });
});

describe("repo.detach (a project's Delete)", () => {
  it("names the archived workspaces and sessions and the forgotten project", () => {
    const detached = {
      repoMountId: REPO_MOUNT_ID,
      state: "detached",
      archivedWorkspaceIds: [WORKSPACE_ID],
      archivedSessionIds: [SESSION_ID],
      forgottenProjectId: PROJECT_ID,
    };
    expect(RepoDetachResponseSchema.safeParse(detached).success).toBe(true);
  });
});
