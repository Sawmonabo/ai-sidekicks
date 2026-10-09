// Proves the `repo_mounts` and `workspaces` constraints: each CHECK admits exactly its contract
// union, a managed mount names its one chat, a workspace needs a real mount, and the active-root
// key is per node. Each attached mount serves a project of its own, so the one-mount-per-project
// key never refuses a row these tests mean to admit.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExecutionMode,
  RepoMountState,
  VcsType,
  WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";

import { openDatabase } from "../migration-runner.js";

const FIXTURE_TIMESTAMP: string = "2026-08-04T00:00:00.000Z";
const FIXTURE_CANONICAL_ROOT: string = "/repos/acme-payments";

// Values for the CHECK loops below, typed exhaustively against the contracts unions. The DDL
// CHECK and the wire union encode one vocabulary and only the union is type-checked, so a new
// member added without the paired CHECK edit would otherwise surface only at persist time.
// `Record<T, true>` makes a new member a typecheck error here, and its accept arm fails if the
// CHECK was not widened.
const REPO_MOUNT_STATES: Record<RepoMountState, true> = {
  attached: true,
  detached: true,
  archived: true,
};
const WORKSPACE_STATES: Record<WorkspaceState, true> = {
  preparing: true,
  ready: true,
  stale: true,
  archived: true,
};
const VCS_TYPES: Record<VcsType, true> = { git: true };
const EXECUTION_MODES: Record<ExecutionMode, true> = {
  "bound-root": true,
  "provisioned-worktree": true,
};

describe("repo_mounts and workspaces constraints", () => {
  let db: DatabaseType;

  beforeEach(() => {
    // `openDatabase` accepts ":memory:", so the pragma and migration order is not re-derived.
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // Helpers insert fully populated valid rows; tests override one constraint-relevant field at a
  // time. Parent rows are created first, so a rejection is never a dangling FK.

  function insertProjectRow(id: string): void {
    db.prepare(
      `INSERT INTO projects
         (id, name, slug, folder_path, state, setup, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(id, id, id, `/repos/${id}`, FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP);
  }

  function insertRepoMountRow(overrides: {
    id: string;
    nodeId?: string;
    canonicalRoot?: string;
    vcsType?: string;
    origin?: string;
    managedSessionId?: string | null;
    state?: string;
  }): void {
    const origin = overrides.origin ?? "attached";
    const projectId = origin === "attached" ? `project-of-${overrides.id}` : null;
    if (projectId !== null) {
      insertProjectRow(projectId);
    }
    db.prepare(
      `INSERT INTO repo_mounts
         (id, node_id, local_path, canonical_root, vcs_type, origin, managed_session_id,
          project_id, state, attached_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      overrides.nodeId ?? "node-alpha",
      // The entered path is a subdirectory of the canonical root, so the columns differ.
      `${overrides.canonicalRoot ?? FIXTURE_CANONICAL_ROOT}/src/services`,
      overrides.canonicalRoot ?? FIXTURE_CANONICAL_ROOT,
      overrides.vcsType ?? "git",
      origin,
      overrides.managedSessionId ?? null,
      projectId,
      overrides.state ?? "attached",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  function insertWorkspaceRow(overrides: {
    id: string;
    sessionId?: string;
    repoMountId?: string;
    executionMode?: string;
    state?: string;
  }): void {
    db.prepare(
      `INSERT INTO workspaces
         (id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      overrides.sessionId ?? "session-1",
      overrides.repoMountId ?? "mount-1",
      overrides.executionMode ?? "bound-root",
      FIXTURE_CANONICAL_ROOT,
      overrides.state ?? "ready",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  it("enforces the state CHECK on `repo_mounts`", () => {
    for (const state of Object.keys(REPO_MOUNT_STATES)) {
      expect(() => {
        insertRepoMountRow({
          id: `mount-state-${state}`,
          canonicalRoot: `/repos/state-${state}`,
          state,
        });
      }).not.toThrow();
    }
    // 'ready' is valid for `workspaces` and must still be rejected here: the two tables' state
    // vocabularies are disjoint.
    expect(() => {
      insertRepoMountRow({
        id: "mount-state-ready",
        canonicalRoot: "/repos/state-ready",
        state: "ready",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the vcs_type CHECK on `repo_mounts`", () => {
    // Each row gets its own canonical root: every row is `attached`, so a shared root would make
    // the `hg` reject fail on UNIQUE instead of on the CHECK under test.
    for (const vcsType of Object.keys(VCS_TYPES)) {
      expect(() => {
        insertRepoMountRow({
          id: `mount-vcs-${vcsType}`,
          canonicalRoot: `/repos/vcs-${vcsType}`,
          vcsType,
        });
      }).not.toThrow();
    }
    expect(() => {
      insertRepoMountRow({ id: "mount-vcs-hg", canonicalRoot: "/repos/vcs-hg", vcsType: "hg" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("ties a mount's origin to the chat it is managed for, one mount per chat", () => {
    // No contract union names the origin yet, so its two members are listed here.
    insertRepoMountRow({ id: "mount-attached", canonicalRoot: "/repos/attached" });
    insertRepoMountRow({
      id: "mount-managed",
      canonicalRoot: "/workspaces/chat-1",
      origin: "managed",
      managedSessionId: "chat-1",
    });
    expect(() => {
      insertRepoMountRow({ id: "mount-cloned", canonicalRoot: "/repos/cloned", origin: "cloned" });
    }).toThrow(/CHECK constraint failed/i);
    // A managed mount names its chat; an attached one names none.
    expect(() => {
      insertRepoMountRow({ id: "mount-orphan", canonicalRoot: "/workspaces/x", origin: "managed" });
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertRepoMountRow({
        id: "mount-claimed",
        canonicalRoot: "/repos/claimed",
        managedSessionId: "chat-2",
      });
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertRepoMountRow({
        id: "mount-second-for-chat",
        canonicalRoot: "/workspaces/chat-1-again",
        origin: "managed",
        managedSessionId: "chat-1",
      });
    }).toThrow(/UNIQUE constraint failed: repo_mounts.managed_session_id/i);
  });

  it("enforces the state CHECK on `workspaces`", () => {
    insertRepoMountRow({ id: "mount-1" });
    for (const state of Object.keys(WORKSPACE_STATES)) {
      expect(() => {
        insertWorkspaceRow({
          id: `workspace-state-${state}`,
          sessionId: `session-${state}`,
          state,
        });
      }).not.toThrow();
    }
    // 'attached' is a valid repo-mount state that must not leak into the workspace vocabulary.
    expect(() => {
      insertWorkspaceRow({ id: "workspace-state-attached", state: "attached" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the execution_mode CHECK on `workspaces`", () => {
    insertRepoMountRow({ id: "mount-1" });
    for (const executionMode of Object.keys(EXECUTION_MODES)) {
      expect(() => {
        insertWorkspaceRow({
          id: `workspace-mode-${executionMode}`,
          sessionId: `session-${executionMode}`,
          executionMode,
        });
      }).not.toThrow();
    }
    expect(() => {
      insertWorkspaceRow({ id: "workspace-mode-not-a-member", executionMode: "not-a-member" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the workspaces.repo_mount_id foreign key against `repo_mounts`", () => {
    // Negative control first: with enforcement live, the accept below passes because the parent
    // exists, not because enforcement is off.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => {
      insertWorkspaceRow({ id: "workspace-dangling", repoMountId: "missing-mount" });
    }).toThrow(/FOREIGN KEY constraint failed/i);

    insertRepoMountRow({ id: "mount-1" });
    expect(() => {
      insertWorkspaceRow({ id: "workspace-bound" });
    }).not.toThrow();
  });

  it("admits an active mount that differs in exactly one key column", () => {
    // Each accept varies one member of the index key and holds the other fixed: a different
    // node is a different filesystem, a different canonical root a different repository.
    insertRepoMountRow({ id: "mount-baseline" });
    expect(() => {
      insertRepoMountRow({ id: "mount-other-node", nodeId: "node-beta" });
    }).not.toThrow();
    expect(() => {
      insertRepoMountRow({ id: "mount-other-root", canonicalRoot: "/repos/other-repository" });
    }).not.toThrow();
  });
});
