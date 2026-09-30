// What every mounts case is driven against: the scripted daemon, tracked readers and their
// disposal, the clock-driven `settle`, and the wire records the cards are drawn from. Each suite
// keeps its own `afterEach(disposeTrackedReaders)`, since registering one here would bind this
// module's import to a suite lifecycle its importer cannot see.

import type {
  BranchContextId,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorktreeId,
  WorktreeStatusRecord,
} from "@ai-sidekicks/contracts";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../repo-operations.js";
import { scriptedRepoOperations } from "../repo-operations.test-support.js";
import type { PrepareOperations } from "./execution-roots/prepare-controller.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";

const trackedReaders: RepoMountsReader[] = [];

/** Hold a reader a case built itself, so the teardown reaches it too. */
export function trackReader(reader: RepoMountsReader): RepoMountsReader {
  trackedReaders.push(reader);
  return reader;
}

/** Dispose every reader this file's cases opened. One `afterEach` per suite. */
export function disposeTrackedReaders(): void {
  while (trackedReaders.length > 0) {
    trackedReaders.pop()?.dispose();
  }
}

/** A reader over scripted calls, tracked for disposal. */
export function openReader(
  operations: RepoOperations,
  clock: ManualClock,
  // Defaulted so cases that only care about the read say nothing about the store.
  sessionStore: SessionStore = new SessionStore({ sessionId: SESSION_ID }),
): RepoMountsReader {
  return trackReader(new RepoMountsReader({ operations, sessionStore, clock }));
}

/**
 * Drive the frozen clock past the debounce and let the read's promises settle. Queued
 * continuations drain before the clock moves too: the scheduler re-arms inside a `finally`, so a
 * second read requested while the first lands would otherwise advance past a timer not yet
 * armed. The post-clock loop stops at the reading, so its count is only a ceiling.
 */
export async function settle(clock: ManualClock, reader: RepoMountsReader): Promise<void> {
  await crossMacrotaskBoundary();
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 400 && reader.snapshot.status !== "read"; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Overrides as a case writes them. Wire ids are branded and tests never mint one, so this
 * loosens the branded ids to `string` alone; every union member and nested shape stays exact.
 */
type Unbranded<TValue> = TValue extends { readonly __brand: string } ? string : TValue;
type WireOverrides<TRecord> = { readonly [Member in keyof TRecord]?: Unbranded<TRecord[Member]> };

/** The session every mounts case belongs to. */
export const SESSION_ID = "session-repos";

/** The root a mount resolves to. */
export const CANONICAL_ROOT = "/Users/dev/code/ai-sidekicks";

/** The deeper path a user entered, which resolves to the canonical root. */
export const ENTERED_PATH = "/Users/dev/code/ai-sidekicks/packages/contracts";

/** One mount as the wire reads it, healthy and attached unless a case says otherwise. */
export function buildMount(
  overrides: WireOverrides<RepoMountReadResponse> = {},
): RepoMountReadResponse {
  return {
    id: "mount-sidekicks",
    nodeId: "node-workstation",
    localPath: ENTERED_PATH,
    canonicalRoot: CANONICAL_ROOT,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
    attachedAt: "2026-01-01T09:05:00.200Z",
    origin: { kind: "attached", repoMountId: "mount-sidekicks", projectId: "project-sidekicks" },
    displayName: "ai-sidekicks",
    usedBy: [{ sessionId: SESSION_ID }],
    ...overrides,
  } as RepoMountReadResponse;
}

/** One workspace row as the roster reads it, in the mode most cases want. */
export function workspaceRow(overrides: WireOverrides<RepoWorkspaceRow> = {}): RepoWorkspaceRow {
  return {
    id: "workspace-sidekicks",
    repoMountId: "mount-sidekicks",
    executionMode: "bound-root",
    state: "ready",
    fsRoot: CANONICAL_ROOT,
    ...overrides,
  } as RepoWorkspaceRow;
}

/** One worktree root as the wire reads it. */
export function worktreeRecord(
  overrides: WireOverrides<WorktreeStatusRecord> = {},
): WorktreeStatusRecord {
  return {
    worktreeId: "worktree-01",
    repoMountId: "mount-sidekicks",
    name: "abc123-rate-limit-wiring",
    branchName: "sidekicks/abc123/rate-limit-wiring",
    baseBranchName: "main",
    fsRoot: "/Users/dev/.desktopBridge/roots/worktree-01",
    state: "ready",
    uncommittedFileCount: 0,
    unpushedCommitCount: 0,
    occupyingSessionIds: [],
    runningSessionId: null,
    createdBySessionId: "session-repos",
    createdByRunId: "run-01",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:04:00.000Z",
    ...overrides,
  } as WorktreeStatusRecord;
}

/** The healthy mount's id. */
export const HEALTHY_MOUNT_ID = "mount-sidekicks";

/** The id of the mount whose root stopped answering. */
export const UNREACHABLE_MOUNT_ID = "mount-unreachable";

/** The id of the mount whose root is no longer the repository it was attached as. */
export const DRIFTED_MOUNT_ID = "mount-drifted";

/** The healthy mount's workspace. */
export const HEALTHY_WORKSPACE_ID = "workspace-sidekicks";

/** The three mounts a session holds: healthy, unreachable, and no longer the repository. */
export const MOUNTS: readonly RepoMountReadResponse[] = [
  buildMount({ id: HEALTHY_MOUNT_ID }),
  buildMount({
    id: UNREACHABLE_MOUNT_ID,
    canonicalRoot: "/Users/dev/code/notes",
    localPath: "/Users/dev/code/notes",
    health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" },
  }),
  buildMount({
    id: DRIFTED_MOUNT_ID,
    canonicalRoot: "/Users/dev/code/moved",
    localPath: "/Users/dev/code/moved",
    health: { status: "identity_mismatch", checkedAt: "2026-01-01T09:05:01.000Z" },
  }),
];

/** One workspace per mount, in the mode most cases want. */
export const WORKSPACES: readonly RepoWorkspaceRow[] = [
  workspaceRow({ id: HEALTHY_WORKSPACE_ID, repoMountId: HEALTHY_MOUNT_ID }),
  workspaceRow({ id: "workspace-unreachable", repoMountId: UNREACHABLE_MOUNT_ID }),
  workspaceRow({ id: "workspace-drifted", repoMountId: DRIFTED_MOUNT_ID }),
];

/** Both modes, with the provisioned worktree the default. */
export const ALL_MODES_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};

/**
 * The daemon answering for the session above: its workspaces, each mount, each
 * workspace's modes and the execution roots. A case scripts only what it is about.
 */
export function sessionOperations(script: Partial<RepoOperations> = {}): RepoOperations {
  return scriptedRepoOperations({
    listWorkspaces: () => Promise.resolve({ workspaces: WORKSPACES.map((row) => ({ ...row })) }),
    readMount: (repoMountId) => {
      const found = MOUNTS.find((held) => held.id === repoMountId);
      if (found === undefined) {
        return Promise.reject(new Error(`the session holds no mount ${repoMountId}`));
      }
      return Promise.resolve(found);
    },
    readWorkspaceExecutionModes: () => Promise.resolve(ALL_MODES_CAPABILITIES),
    readWorktreeStatus: (repoMountId) =>
      Promise.resolve({
        repoRoot: { path: CANONICAL_ROOT, branchName: "main" },
        worktrees:
          repoMountId === HEALTHY_MOUNT_ID
            ? [worktreeRecord(), worktreeRecord({ worktreeId: "worktree-02" })]
            : [],
      }),
    ...script,
  });
}

/** A branch with a live, dirty, compatible checkout — the consent case. */
export const DIRTY_BRANCH = "feat/rate-limit-wiring";

/** A branch whose checkout belongs to another workspace, which admits no consent. */
export const INCOMPATIBLE_BRANCH = "review/rate-limit-wiring";

/**
 * The daemon's answers to the prepare form: a dirty candidate and an incompatible one. Any
 * other branch is free.
 */
export function preparingDaemon(): PrepareOperations {
  return {
    checkWorktreeReuse: (_repoMountId, branchName) => {
      if (branchName === DIRTY_BRANCH) {
        return Promise.resolve({
          available: true,
          worktreeId: "worktree-dirty" as WorktreeId,
          state: "dirty",
          branchName,
          isClean: false,
          compatible: true,
        });
      }
      if (branchName === INCOMPATIBLE_BRANCH) {
        return Promise.resolve({
          available: true,
          worktreeId: "worktree-other" as WorktreeId,
          state: "ready",
          branchName,
          isClean: true,
          compatible: false,
          reason: "That checkout belongs to another workspace.",
        });
      }
      return Promise.resolve({ available: false });
    },
    prepareExecutionRoot: () =>
      Promise.resolve({
        executionRoot: "/Users/dev/roots/fresh",
        state: "ready",
        branchContextId: "branch-context-fresh" as BranchContextId,
      }),
  };
}
