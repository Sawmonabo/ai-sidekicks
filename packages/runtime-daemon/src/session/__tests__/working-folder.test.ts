// A project session's working folder on real git: an idle move re-roots the same workspace at
// once; a move asked while a run is live waits on the session's row, a later request replaces it,
// the folder the session is in clears it, and the run's boundary applies it; and removing a tree
// sweeps every session in it back to the repository's checkout, one record per session, passing
// over one whose run is still bound there until that run is released.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { WorktreeIdSchema } from "@ai-sidekicks/contracts/worktree/lifecycle";

import {
  openWorktreeFixture,
  type WorktreeFixture,
} from "../../git/worktree/__fixtures__/services.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { requireWorkspaceRow } from "../../workspace/__fixtures__/rows.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

beforeEach(async () => {
  fixture = await openWorktreeFixture();
});

afterEach(async () => {
  await fixture.close();
});

async function createTree(tail: string): Promise<{ worktreeId: string; fsRoot: string }> {
  return fixture.creator.create({
    repoMountId: fixture.repoMountId,
    sessionId: fixture.seedSession(),
    name: { kind: "tail", tail },
    onCollision: "refuse",
  });
}

function seedSessionAt(folder: string): { sessionId: string; workspaceId: string } {
  const sessionId = fixture.seedSession();
  const workspaceId = fixture.seedWorkspace({
    sessionId,
    executionMode: "bound-root",
    state: "ready",
    fsRoot: folder,
    boundRoot: folder,
    checkoutRoot: folder,
  });
  return { sessionId, workspaceId };
}

function readPending(sessionId: string): string | null {
  return fixture.db
    .prepare("SELECT pending_working_folder FROM sessions WHERE id = ?")
    .pluck()
    .get(sessionId) as string | null;
}

// A run of the session is live: its context is written and not yet released.
function startRun(sessionId: string, workspaceId: string, folder: string): void {
  const branchContextId = mintUuidV7();
  fixture.db
    .prepare(
      `INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at,
         updated_at) VALUES (?, ?, 'main', 'main', 'now', 'now')`,
    )
    .run(branchContextId, workspaceId);
  fixture.db
    .prepare(
      `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
         execution_root, checkout_root, git_common_dir, branch_context_id, created_at)
       VALUES (?, ?, ?, 'bound-root', ?, ?, ?, ?, 'now')`,
    )
    .run(mintUuidV7(), sessionId, workspaceId, folder, folder, folder, branchContextId);
}

function readSweepPayloads(): readonly Record<string, unknown>[] {
  return fixture.db
    .prepare<[], string>(
      `SELECT payload FROM session_events WHERE type = 'session.swept_to_repo_root'
        ORDER BY sequence`,
    )
    .pluck()
    .all()
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("a working-folder move", () => {
  it("re-roots the same workspace in the tree at once while no run is live", async () => {
    const tree = await createTree("target");
    const session = seedSessionAt(fixture.repository.root);

    const response = await fixture.workingFolders.set({
      sessionId: SessionIdSchema.parse(session.sessionId),
      path: tree.fsRoot,
    });

    expect(response.disposition).toBe("applied");
    expect(requireWorkspaceRow(fixture.db, session.workspaceId)).toMatchObject({
      fs_root: tree.fsRoot,
      execution_mode: "provisioned-worktree",
      state: "ready",
    });
  });

  it("waits on the row while a run is live, replaced by a later request, cleared by the current folder, applied at the boundary", async () => {
    const first = await createTree("first");
    const second = await createTree("second");
    const session = seedSessionAt(fixture.repository.root);
    startRun(session.sessionId, session.workspaceId, fixture.repository.root);
    const sessionId = SessionIdSchema.parse(session.sessionId);

    expect((await fixture.workingFolders.set({ sessionId, path: first.fsRoot })).disposition).toBe(
      "pending",
    );
    expect((await fixture.workingFolders.set({ sessionId, path: second.fsRoot })).disposition).toBe(
      "pending",
    );
    expect(readPending(session.sessionId)).toBe(second.fsRoot);
    expect(requireWorkspaceRow(fixture.db, session.workspaceId).fs_root).toBe(
      fixture.repository.root,
    );
    expect(
      (await fixture.workingFolders.set({ sessionId, path: fixture.repository.root })).disposition,
    ).toBe("applied");
    expect(readPending(session.sessionId)).toBeNull();

    await fixture.workingFolders.set({ sessionId, path: second.fsRoot });
    fixture.db.prepare("UPDATE run_execution_contexts SET released_at = 'now'").run();
    await fixture.workingFolders.applyPending(session.sessionId);

    expect(readPending(session.sessionId)).toBeNull();
    expect(requireWorkspaceRow(fixture.db, session.workspaceId).fs_root).toBe(second.fsRoot);
  });
});

describe("a removed tree's sweep", () => {
  it("moves each session in the tree to the repository's checkout and clears moves to it, one record each", async () => {
    const tree = await createTree("removed");
    const standingFirst = seedSessionAt(tree.fsRoot);
    const standingSecond = seedSessionAt(tree.fsRoot);
    const waiting = seedSessionAt(fixture.repository.root);
    fixture.db
      .prepare("UPDATE sessions SET pending_working_folder = ? WHERE id = ?")
      .run(tree.fsRoot, waiting.sessionId);
    const bystander = seedSessionAt(fixture.repository.root);

    await fixture.removal.retire({
      worktreeId: WorktreeIdSchema.parse(tree.worktreeId),
      discard: false,
    });

    for (const standing of [standingFirst, standingSecond]) {
      expect(requireWorkspaceRow(fixture.db, standing.workspaceId).fs_root).toBe(
        fixture.repository.root,
      );
    }
    expect(readPending(waiting.sessionId)).toBeNull();
    const payloads = readSweepPayloads();
    expect(payloads).toHaveLength(3);
    expect(payloads).toEqual(
      expect.arrayContaining([
        {
          sessionId: standingFirst.sessionId,
          repoMountId: fixture.repoMountId,
          worktreeId: tree.worktreeId,
        },
        {
          sessionId: standingSecond.sessionId,
          repoMountId: fixture.repoMountId,
          worktreeId: tree.worktreeId,
        },
        {
          sessionId: waiting.sessionId,
          repoMountId: fixture.repoMountId,
          worktreeId: tree.worktreeId,
          pendingMoveCleared: true,
        },
      ]),
    );
    expect(payloads.map((payload) => payload["sessionId"])).not.toContain(bystander.sessionId);
  });

  it("never moves a folder a run is still bound to, and sweeps it once that run is released", async () => {
    const tree = await createTree("removed");
    const running = seedSessionAt(tree.fsRoot);
    startRun(running.sessionId, running.workspaceId, tree.fsRoot);
    // The removal committed after the run bound, so its sweep meets a bound run.
    fixture.db.prepare("UPDATE worktrees SET state = 'retired' WHERE id = ?").run(tree.worktreeId);

    await fixture.workingFolders.sweepToRepoRoot({
      repoMountId: fixture.repoMountId,
      worktreeId: WorktreeIdSchema.parse(tree.worktreeId),
      folder: tree.fsRoot,
    });

    expect(requireWorkspaceRow(fixture.db, running.workspaceId).fs_root).toBe(tree.fsRoot);
    expect(readSweepPayloads()).toEqual([]);

    fixture.db.prepare("UPDATE run_execution_contexts SET released_at = 'now'").run();
    await fixture.workingFolders.sweepFromRemovedTree(running.sessionId);

    expect(requireWorkspaceRow(fixture.db, running.workspaceId).fs_root).toBe(
      fixture.repository.root,
    );
    expect(readSweepPayloads()).toEqual([
      {
        sessionId: running.sessionId,
        repoMountId: fixture.repoMountId,
        worktreeId: tree.worktreeId,
      },
    ]);
  });
});
