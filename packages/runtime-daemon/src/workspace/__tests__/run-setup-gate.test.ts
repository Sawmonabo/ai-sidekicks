// The run-setup gate on real git: the run's context records the working tree's top level even
// when the run works in a folder nested inside it, a session's first run makes its tree from the
// session's title, the run's end releases the context, and a workspace that cannot be bound ends
// the run with the gate's own refusal wrapping why: one whose root is gone, whose mount folder
// holds another repository (before a first root as well), whose folder is another repository's
// checkout, or whose workspace, mount or tree moved before the context was written.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueueItemIdSchema, type QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import { captureRejection } from "../../__fixtures__/capture-failure.js";
import { WorkspaceExecutionRootUnresolvedError } from "../../git/worktree/errors.js";
import { shortIdOf } from "../../git/worktree/naming.js";
import {
  openWorktreeFixture,
  type WorktreeFixture,
} from "../../git/worktree/__fixtures__/services.js";
import type { GitRunner } from "../../git/process.js";
import { KeyedLock } from "../../keyed-lock.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { requireWorkspaceRow } from "../__fixtures__/rows.js";
import { COMMON_DIR_METADATA_PATH } from "../row-guards.js";
import { ExecutionRootSetupGate } from "../run-setup-gate.js";

vi.setConfig({ testTimeout: 60_000 });

const NOW = "2026-08-04T00:00:00.000Z";

let fixture: WorktreeFixture;
let gate: ExecutionRootSetupGate;

// No workspace here was moved by a re-attach, so the gate never admits one again.
const NO_REATTACHED_WORKSPACES = {
  prepareMovedWorkspace: (): Promise<void> =>
    Promise.reject(new Error("no workspace here was moved by a re-attach")),
};

function openGate(
  options: { readonly git?: GitRunner; readonly checkoutLock?: KeyedLock<string> } = {},
): ExecutionRootSetupGate {
  return new ExecutionRootSetupGate({
    database: fixture.scratch,
    executionRoots: fixture.executionRoots,
    workspaces: fixture.workspaces,
    workingFolders: fixture.workingFolders,
    reattachedWorkspaces: NO_REATTACHED_WORKSPACES,
    checkoutLock: options.checkoutLock ?? new KeyedLock<string>(),
    git: options.git ?? fixture.repository.runner,
  });
}

beforeEach(async () => {
  fixture = await openWorktreeFixture();
  gate = openGate();
});

afterEach(async () => {
  await fixture.close();
});

// A gate whose git makes `interfere`'s write just before the run's git folder is read, the last
// step before the context is written.
function interferingGate(interfere: () => void): ExecutionRootSetupGate {
  const git: GitRunner = (argv, options) => {
    if (argv.includes("--git-common-dir")) {
      interfere();
    }
    return fixture.repository.runner(argv, options);
  };
  return openGate({ git });
}

// The checkout's lock, taken just before the context is written, retires every tree first: a
// removal that commits after the binding read its tree.
class RetiringCheckoutLock extends KeyedLock<string> {
  override async run<T>(key: string, critical: () => Promise<T>): Promise<T> {
    fixture.db.prepare("UPDATE worktrees SET state = 'retired'").run();
    return super.run(key, critical);
  }
}

function setUp(
  sessionId: string,
  runGate: ExecutionRootSetupGate = gate,
): { runId: RunId; run: () => Promise<void> } {
  const runId = RunIdSchema.parse(mintUuidV7());
  const queueItem: QueueItemSummary = {
    id: QueueItemIdSchema.parse(mintUuidV7()),
    state: "admitted",
    priority: 0,
    content: "please fix the flaky test",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    runId,
    run: () =>
      runGate.assertRunReady({ runId, sessionId: SessionIdSchema.parse(sessionId), queueItem }),
  };
}

interface RunContextRow {
  readonly execution_mode: string;
  readonly execution_root: string;
  readonly checkout_root: string;
  readonly git_common_dir: string;
  readonly worktree_id: string | null;
  readonly released_at: string | null;
}

function readRunContext(runId: string): RunContextRow | undefined {
  return fixture.db
    .prepare<[string], RunContextRow>(
      `SELECT execution_mode, execution_root, checkout_root, git_common_dir, worktree_id,
              released_at
         FROM run_execution_contexts WHERE run_id = ?`,
    )
    .get(runId);
}

describe("the run-setup gate", () => {
  it("records the working tree's top level for a run bound to a nested folder, and releases it", async () => {
    const sessionId = fixture.seedSession();
    const nested = join(fixture.repository.root, "src");
    fixture.seedWorkspace({
      sessionId,
      executionMode: "bound-root",
      state: "preparing",
      fsRoot: null,
      boundRoot: nested,
      checkoutRoot: fixture.repository.root,
    });
    const { runId, run } = setUp(sessionId);

    await run();

    expect(readRunContext(runId)).toEqual({
      execution_mode: "bound-root",
      execution_root: nested,
      checkout_root: fixture.repository.root,
      git_common_dir: join(fixture.repository.root, ".git"),
      worktree_id: null,
      released_at: null,
    });
    await gate.onRunTerminal({
      runId,
      sessionId: SessionIdSchema.parse(sessionId),
      terminalState: "completed",
      runVersion: 1,
    });
    expect(readRunContext(runId)?.released_at).not.toBeNull();
  });

  it("makes a session's first tree from its title and roots the run there", async () => {
    const sessionId = fixture.seedSession("Fix the login redirect");
    fixture.seedWorkspace({
      sessionId,
      executionMode: "provisioned-worktree",
      state: "preparing",
      fsRoot: null,
      boundRoot: fixture.repository.root,
      checkoutRoot: fixture.repository.root,
    });
    const { runId, run } = setUp(sessionId);

    await run();

    const context = readRunContext(runId);
    const tree = fixture.db
      .prepare<
        [],
        { id: string; branch_name: string; fs_root: string }
      >("SELECT id, branch_name, fs_root FROM worktrees")
      .get();
    expect(tree?.branch_name).toBe(`sidekicks/${shortIdOf(sessionId)}/fix-the-login-redirect`);
    expect(context).toMatchObject({
      execution_mode: "provisioned-worktree",
      execution_root: tree?.fs_root,
      checkout_root: tree?.fs_root,
      git_common_dir: join(fixture.repository.root, ".git"),
      worktree_id: tree?.id,
    });
  });

  it("ends the run with execution_root_unresolved wrapping why the workspace cannot be bound", async () => {
    const sessionId = fixture.seedSession();
    const gone = join(fixture.repository.fixtureRoot, "gone");
    fixture.seedWorkspace({
      sessionId,
      executionMode: "bound-root",
      state: "ready",
      fsRoot: gone,
      boundRoot: gone,
      checkoutRoot: gone,
    });
    const { runId, run } = setUp(sessionId);

    const refusal = await captureRejection(run);

    expect(refusal).toBeInstanceOf(WorkspaceExecutionRootUnresolvedError);
    expect(refusal).toMatchObject({ causeCode: "workspace.stale" });
    expect(readRunContext(runId)).toBeUndefined();
  });

  it("refuses the run when the mount folder holds another repository, before a first root as well", async () => {
    // The mount was attached as another repository than the one its folder holds.
    fixture.db
      .prepare(`UPDATE repo_mounts SET metadata = json_set(metadata, ?, ?) WHERE id = ?`)
      .run(
        COMMON_DIR_METADATA_PATH,
        join(fixture.repository.fixtureRoot, "other-repository.git"),
        fixture.repoMountId,
      );

    // A ready workspace is staled, since only a re-attach repairs it.
    const readySessionId = fixture.seedSession();
    const readyWorkspaceId = fixture.seedWorkspace({
      sessionId: readySessionId,
      executionMode: "bound-root",
      state: "ready",
      fsRoot: fixture.repository.root,
      boundRoot: fixture.repository.root,
      checkoutRoot: fixture.repository.root,
    });
    const readyRun = setUp(readySessionId);

    const readyRefusal = await captureRejection(readyRun.run);

    expect(readyRefusal).toBeInstanceOf(WorkspaceExecutionRootUnresolvedError);
    expect(readyRefusal).toMatchObject({ causeCode: "workspace.stale" });
    expect(readRunContext(readyRun.runId)).toBeUndefined();
    expect(requireWorkspaceRow(fixture.db, readyWorkspaceId).state).toBe("stale");

    // A first run makes no tree in the other repository; the workspace stays preparing, so a
    // run after a re-attach prepares it on the new mount.
    const firstSessionId = fixture.seedSession("Fix the login redirect");
    const firstWorkspaceId = fixture.seedWorkspace({
      sessionId: firstSessionId,
      executionMode: "provisioned-worktree",
      state: "preparing",
      fsRoot: null,
      boundRoot: fixture.repository.root,
      checkoutRoot: fixture.repository.root,
    });
    const firstRun = setUp(firstSessionId);

    const firstRefusal = await captureRejection(firstRun.run);

    expect(firstRefusal).toBeInstanceOf(WorkspaceExecutionRootUnresolvedError);
    expect(firstRefusal).toMatchObject({ causeCode: "repo.root_resolution_failed" });
    expect(readRunContext(firstRun.runId)).toBeUndefined();
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM worktrees").get()).toEqual({
      count: 0,
    });
    expect(requireWorkspaceRow(fixture.db, firstWorkspaceId).state).toBe("preparing");
  });

  it("refuses a run whose folder is another repository's checkout", async () => {
    const otherRepository = join(fixture.repository.fixtureRoot, "other-repository");
    mkdirSync(otherRepository);
    await fixture.repository.git(["init", "-q", "-b", "main", "."], otherRepository);
    await fixture.repository.git(["commit", "-q", "--allow-empty", "-m", "first"], otherRepository);
    const sessionId = fixture.seedSession();
    fixture.seedWorkspace({
      sessionId,
      executionMode: "bound-root",
      state: "preparing",
      fsRoot: null,
      boundRoot: otherRepository,
      checkoutRoot: otherRepository,
    });
    const { runId, run } = setUp(sessionId);

    const refusal = await captureRejection(run);

    expect(refusal).toBeInstanceOf(WorkspaceExecutionRootUnresolvedError);
    expect(refusal).toMatchObject({ causeCode: "repo.root_resolution_failed" });
    expect(readRunContext(runId)).toBeUndefined();
  });

  it("writes no context into a tree whose removal commits after the binding read it", async () => {
    const sessionId = fixture.seedSession("Fix the login redirect");
    fixture.seedWorkspace({
      sessionId,
      executionMode: "provisioned-worktree",
      state: "preparing",
      fsRoot: null,
      boundRoot: fixture.repository.root,
      checkoutRoot: fixture.repository.root,
    });
    const { runId, run } = setUp(sessionId, openGate({ checkoutLock: new RetiringCheckoutLock() }));

    const refusal = await captureRejection(run);

    expect(refusal).toBeInstanceOf(WorkspaceExecutionRootUnresolvedError);
    expect(readRunContext(runId)).toBeUndefined();
  });

  it("writes no context when the workspace leaves ready or its mount is detached before the write", async () => {
    const interferences: readonly {
      readonly name: string;
      readonly interfere: (sessionId: string) => void;
    }[] = [
      {
        name: "workspace",
        interfere: (sessionId) => {
          fixture.db
            .prepare("UPDATE workspaces SET state = 'stale' WHERE session_id = ?")
            .run(sessionId);
        },
      },
      {
        name: "mount",
        interfere: () => {
          fixture.db
            .prepare("UPDATE repo_mounts SET state = 'detached' WHERE id = ?")
            .run(fixture.repoMountId);
        },
      },
    ];
    for (const interference of interferences) {
      const sessionId = fixture.seedSession();
      // `preparing`, so the binding's own preparation writes the branch context the write needs.
      fixture.seedWorkspace({
        sessionId,
        executionMode: "bound-root",
        state: "preparing",
        fsRoot: null,
        boundRoot: fixture.repository.root,
        checkoutRoot: fixture.repository.root,
      });
      const { runId, run } = setUp(
        sessionId,
        interferingGate(() => interference.interfere(sessionId)),
      );

      const refusal = await captureRejection(run);

      expect(refusal, interference.name).toBeInstanceOf(WorkspaceExecutionRootUnresolvedError);
      expect(readRunContext(runId), interference.name).toBeUndefined();
    }
  });
});
