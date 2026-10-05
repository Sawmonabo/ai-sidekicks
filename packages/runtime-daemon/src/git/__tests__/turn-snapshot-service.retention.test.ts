// The turn-snapshot retention prune over real git and a real migrated database: it deletes the
// named run's snapshot refs and nothing else, whatever the run id, the ref store or git's listing
// says.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import { runGitWithExecFile, type GitRunner } from "../git-process.js";
import type { TurnSnapshotService } from "../turn-snapshot-service.js";
import {
  buildRecordingRunner,
  ORDINARY_CASE_TIMEOUT_MS,
  RUN_ID,
  type ServiceOverrides,
  TurnSnapshotFixture,
} from "./turn-snapshot-service.test-support.js";

vi.setConfig({ testTimeout: ORDINARY_CASE_TIMEOUT_MS });

const SESSION_ID = "0192b3c0-3333-7c4a-9b1c-1b7c5b3e8f00";
const MOUNT_ID = "0192b3c0-4444-7c4a-9b1c-1b7c5b3e8f00";
const WORKSPACE_ID = "0192b3c0-5555-7c4a-9b1c-1b7c5b3e8f00";
const SEEDED_AT = "2026-06-01T00:00:00.000Z";

// Its ref prefix starts with the pruned run's, so only a sibling like this catches an enumeration
// that matches by prefix instead of by path segment.
const SIBLING_RUN_ID = `${RUN_ID}b`;

let fixture: TurnSnapshotFixture;
let database: DatabaseType;

// A real migrated database, because the prune reads `git_common_dir` from the run's execution
// context and the schema's checks decide which companion rows a context legally has.
beforeEach(async () => {
  fixture = await TurnSnapshotFixture.create();
  database = openDatabase(join(fixture.fixtureRoot, "daemon.db"));
  database
    .prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, state, attached_at, updated_at
       ) VALUES (@id, 'node-1', @root, @root, 'attached', @now, @now)`,
    )
    .run({ id: MOUNT_ID, root: fixture.repository.root, now: SEEDED_AT });
  database
    .prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
       ) VALUES (@id, @session_id, @mount_id, 'provisioned-worktree', @root, 'ready', @now, @now)`,
    )
    .run({
      id: WORKSPACE_ID,
      session_id: SESSION_ID,
      mount_id: MOUNT_ID,
      root: fixture.repository.root,
      now: SEEDED_AT,
    });
});

afterEach(() => {
  // Closed before the fixture root that holds the database file is removed.
  if (database.open) {
    database.close();
  }
  fixture.remove();
});

/**
 * Seeds a provisioned-worktree run's execution context with the worktree and branch-context rows
 * the schema requires; the prune runs its ref operations through `gitCommonDir`.
 */
function insertRunExecutionContext(seed: {
  readonly runId: string;
  readonly executionRoot: string;
  readonly gitCommonDir: string;
}): void {
  const worktreeId = `worktree-${seed.runId}`;
  const branchContextId = `branch-context-${seed.runId}`;
  const branchName = `feature/${seed.runId}`;
  database
    .prepare(
      `INSERT INTO worktrees (
         id, repo_mount_id, created_by_session_id, created_by_run_id,
         branch_name, fs_root, state, created_at, updated_at
       ) VALUES (@id, @mount_id, @session_id, @run_id, @branch, @root, 'ready', @now, @now)`,
    )
    .run({
      id: worktreeId,
      mount_id: MOUNT_ID,
      session_id: SESSION_ID,
      run_id: seed.runId,
      branch: branchName,
      root: seed.executionRoot,
      now: SEEDED_AT,
    });
  database
    .prepare(
      `INSERT INTO branch_contexts (
         id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at
       ) VALUES (@id, @workspace_id, @worktree_id, 'main', @head, @now, @now)`,
    )
    .run({
      id: branchContextId,
      workspace_id: WORKSPACE_ID,
      worktree_id: worktreeId,
      head: branchName,
      now: SEEDED_AT,
    });
  database
    .prepare(
      `INSERT INTO run_execution_contexts (
         run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir,
         worktree_id, branch_context_id, created_at
       ) VALUES (
         @run_id, @session_id, @workspace_id, 'provisioned-worktree', @execution_root,
         @git_common_dir, @worktree_id, @branch_context_id, @now
       )`,
    )
    .run({
      run_id: seed.runId,
      session_id: SESSION_ID,
      workspace_id: WORKSPACE_ID,
      execution_root: seed.executionRoot,
      git_common_dir: seed.gitCommonDir,
      worktree_id: worktreeId,
      branch_context_id: branchContextId,
      now: SEEDED_AT,
    });
}

/** Seeds {@link RUN_ID}'s context against the base repository's own git directory. */
function insertBaseRunExecutionContext(): void {
  insertRunExecutionContext({
    runId: RUN_ID,
    executionRoot: fixture.repository.root,
    gitCommonDir: join(fixture.repository.root, ".git"),
  });
}

function buildRetentionService(overrides: ServiceOverrides = {}): TurnSnapshotService {
  return fixture.buildService({ database, now: (): string => SEEDED_AT, ...overrides });
}

describe("TurnSnapshotService retention prune", () => {
  it("deletes only the named run's refs; branches, symref targets, sibling runs stay", async () => {
    const { repository } = fixture;
    const service = buildRetentionService();
    fixture.applyTurnEffects();
    const first = await fixture.captureTurn(service, { epoch: 0, turnOrdinal: 1 });
    const second = await fixture.captureTurn(service, { epoch: 1, turnOrdinal: 2 });
    const sibling = await fixture.captureTurn(service, { runId: SIBLING_RUN_ID });
    await repository.git(["branch", "release/1.0"]);
    // A well-formed in-namespace name pointing at the checked-out branch. The listing resolves it
    // to the branch's object id, so only `--no-deref` keeps the delete off the branch.
    const plantedRef = `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-9`;
    await repository.git(["symbolic-ref", plantedRef, "refs/heads/main"]);
    const headsBefore: string = await repository.refListing("refs/heads/");
    insertBaseRunExecutionContext();

    const pruned = await service.pruneSnapshotsForRun(RUN_ID);

    expect(pruned.skipped).toBeNull();
    expect([...pruned.deletedRefs].sort()).toEqual([first.ref, second.ref, plantedRef].sort());
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${sibling.snapshotCommit} ${sibling.ref}`,
    );
  });

  it("refuses a namespace-escaping run id before any git call", async () => {
    const { repository } = fixture;
    const unsafeRunId = "../../heads/main";
    const invocations: string[][] = [];
    const service = buildRetentionService({ git: buildRecordingRunner(invocations) });
    const headsBefore: string = await repository.refListing("refs/heads/");
    // A hostile row as well as a hostile argument: the lookup finds it, so only the id check stops
    // it. Git's own bad-name refusal would report a successful prune of nothing.
    insertRunExecutionContext({
      runId: unsafeRunId,
      executionRoot: repository.root,
      gitCommonDir: join(repository.root, ".git"),
    });

    const pruned = await service.pruneSnapshotsForRun(unsafeRunId);

    expect(pruned).toMatchObject({
      deletedRefs: [],
      skipped: { runId: unsafeRunId, reason: "unsafe-run-id" },
    });
    expect(invocations).toEqual([]);
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
  });

  it("drops a listing entry outside the run's prefix or with a forged object id", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    const captured = await fixture.captureTurn(buildRetentionService());
    const headCommit: string = await repository.git(["rev-parse", "HEAD"]);
    const refsBefore: string = await repository.refListing();
    insertBaseRunExecutionContext();
    // A `for-each-ref` that matched more than asked, and a line whose object-id field carries a
    // git option into `update-ref -d <ref> <oid>`.
    const hostileListings: readonly string[] = [
      `${headCommit} refs/heads/main`,
      `--upload-pack=x ${captured.ref}`,
    ];

    for (const listing of hostileListings) {
      const deletions: string[][] = [];
      const hostileListingRunner: GitRunner = async (argv, options) => {
        if (argv.includes("for-each-ref")) {
          return { stdout: Buffer.from(`${listing}\n`, "utf8"), stderr: "" };
        }
        if (argv.includes("update-ref")) {
          deletions.push([...argv]);
        }
        return runGitWithExecFile(argv, options);
      };

      const pruned = await buildRetentionService({
        git: hostileListingRunner,
      }).pruneSnapshotsForRun(RUN_ID);

      expect(pruned, listing).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
      expect(deletions, listing).toEqual([]);
    }
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("prunes a removed worktree's refs via git_common_dir, skipping a removed repo", async () => {
    const { repository } = fixture;
    const service = buildRetentionService();
    const worktree = await fixture.addLinkedWorktree("linked-worktree", "feature/run");
    // Read as the context records it, so the fixture cannot agree with the service by accident.
    const recordedCommonDirectory: string = await worktree.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const captured = await fixture.captureTurn(service, { executionRoot: worktree.root });
    insertRunExecutionContext({
      runId: RUN_ID,
      executionRoot: worktree.root,
      gitCommonDir: recordedCommonDirectory,
    });
    // The worktree is retired and removed while its refs remain in the shared store; a prune
    // through the execution root would find nothing and leak them.
    rmSync(worktree.root, { recursive: true, force: true });
    await repository.git(["worktree", "prune"]);
    expect(existsSync(worktree.root)).toBe(false);
    // A repository that is gone entirely skips the run instead of failing the sweep.
    const removedRepositoryRoot: string = join(fixture.fixtureRoot, "removed-repo");
    insertRunExecutionContext({
      runId: SIBLING_RUN_ID,
      executionRoot: removedRepositoryRoot,
      gitCommonDir: join(removedRepositoryRoot, ".git"),
    });

    expect(await service.pruneSnapshotsForRun(RUN_ID)).toEqual({
      runId: RUN_ID,
      deletedRefs: [captured.ref],
      skipped: null,
    });
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
    expect(await service.pruneSnapshotsForRun(SIBLING_RUN_ID)).toMatchObject({
      deletedRefs: [],
      skipped: { runId: SIBLING_RUN_ID, reason: "git-dir-absent" },
    });
  });
});
