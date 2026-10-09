// A re-attach on real git: it refuses, writing nothing, every mount it must not re-attach, a run
// that started after its checks refused inside its write; it moves every workspace to the new
// mount keeping its id and prepares each again; and it never costs the person a tree the daemon
// made, leaving one the new repository does not list on disk through the cleanup sweep.

import { existsSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepoMountIdSchema } from "@ai-sidekicks/contracts/repo/mount";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import type { DatabaseConnections } from "../../../database/connection/lifecycle.js";
import type { DatabaseWriter } from "../../../database/writer.js";
import { EventLogService } from "../../../events/log-service.js";
import { buildFixtureEnvironment, runFixtureGit } from "../../../git/__fixtures__/command.js";
import { WorktreeEventEmitter } from "../../../git/worktree/event-emitter.js";
import {
  openWorktreeFixture,
  type WorktreeFixture,
} from "../../../git/worktree/__fixtures__/services.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { bindReadyWorkspace } from "../../__fixtures__/bound-root.js";
import {
  attachedMountRowStatements,
  readLifecycleEnvelopes,
  readLifecycleEventTypes,
  requireWorkspaceRow,
} from "../../__fixtures__/rows.js";
import { WorkspaceEventEmitter } from "../../event-emitter.js";
import { COMMON_DIR_METADATA_PATH } from "../../row-guards.js";
import {
  RepoAlreadyAttachedError,
  RepoReattachConflictError,
  RepoReattachRefusedError,
  RepoRootResolutionError,
  TrustEnvelopeViolationError,
} from "../errors.js";
import {
  attachFolder,
  NODE_ID,
  openRepoMountHarness,
  OTHER_SESSION_ID,
  RUN_ID,
  seedUnreleasedRun,
  SESSION_ID,
  unreleasedRunStatements,
  writeRaw,
  type RepoMountHarness,
} from "./mount-service.test-support.js";
import { RepoMountReattachService } from "../reattach.js";
import { RepoRootResolver } from "../root-resolver.js";

vi.setConfig({ testTimeout: 60_000 });

const UNCOMMITTED_WORK = "notes the person has not committed\n";

let fixture: WorktreeFixture;
let harness: RepoMountHarness;
let gitFolders: { readonly fixtureRoot: string; readonly environment: NodeJS.ProcessEnv };

/** Fixture git run from the folder holding `root`. */
function gitBeside(root: string, args: readonly string[]): Promise<string> {
  return runFixtureGit(args, gitFolders.environment, dirname(root));
}

/** A repository whose git directory lives beside its folder, as `--separate-git-dir` makes it. */
async function createSeparateGitDirRepository(): Promise<string> {
  const root = join(await mkdtemp(join(gitFolders.fixtureRoot, "reattach-")), "folder");
  await gitBeside(root, ["init", "-q", `--separate-git-dir=${root}-git-directory`, root]);
  await gitBeside(root, ["-C", root, "commit", "-q", "--allow-empty", "-m", "seed"]);
  return root;
}

/** Gives the folder a fresh repository of its own, so its git common directory is another. */
async function replaceRepository(root: string): Promise<void> {
  rmSync(join(root, ".git"), { recursive: true, force: true });
  await gitBeside(root, ["init", "-q", root]);
}

function createReattachService(
  serviceLogLines: string[] = [],
  database: DatabaseConnections = harness.database,
): RepoMountReattachService {
  return new RepoMountReattachService({
    database,
    workspaces: harness.workspaces,
    events: harness.emitter,
    worktreeEvents: harness.worktreeEvents,
    resolver: new RepoRootResolver(),
    writeServiceLog: (line) => serviceLogLines.push(line),
  });
}

/** Records the seeded run's `run.queued`, which names its agent; answers that agent's id. */
async function writeRunQueued(): Promise<string> {
  const agentId = mintUuidV7();
  await writeRaw(
    harness,
    `INSERT INTO session_events (
       id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload
     ) VALUES (?, ?, 1000, '2026-01-01T00:00:00.000Z', 0, 'run_lifecycle', 'run.queued', ?)`,
    [mintUuidV7(), SESSION_ID, JSON.stringify({ runId: RUN_ID, agentId })],
  );
  return agentId;
}

/** Every mount and workspace row and the event count, to prove a refusal wrote nothing. */
function snapshotRows(): unknown {
  const reader = harness.database.reader;
  return {
    mounts: reader.prepare("SELECT * FROM repo_mounts ORDER BY id").all(),
    workspaces: reader.prepare("SELECT * FROM workspaces ORDER BY id").all(),
    events: reader.prepare("SELECT COUNT(*) AS total FROM session_events").get(),
  };
}

function readMountFacts(repoMountId: string): {
  readonly state: string;
  readonly canonical_root: string;
  readonly project_id: string | null;
  readonly common_dir: string | null;
} {
  return harness.database.reader
    .prepare(
      `SELECT state, canonical_root, project_id,
              json_extract(metadata, '$.commonDir') AS common_dir
         FROM repo_mounts WHERE id = ?`,
    )
    .get(repoMountId) as ReturnType<typeof readMountFacts>;
}

describe("RepoMountReattachService.reattach", () => {
  beforeEach(async () => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "aisk-reattach-")));
    gitFolders = { fixtureRoot, environment: buildFixtureEnvironment(fixtureRoot) };
    harness = await openRepoMountHarness();
  });

  afterEach(async () => {
    await harness.database.close();
    rmSync(gitFolders.fixtureRoot, { recursive: true, force: true });
  });

  it("refuses, writing nothing, every mount it must not re-attach", async () => {
    const root = await createSeparateGitDirRepository();
    const attached = await attachFolder(harness, root);
    const workspaceId = await bindReadyWorkspace(
      harness.workspaces,
      SESSION_ID,
      attached.repoMountId,
      root,
    );
    const serviceLogLines: string[] = [];
    const service = createReattachService(serviceLogLines);
    const reattach = (): Promise<unknown> =>
      captureRejection(() => service.reattach({ repoMountId: attached.repoMountId }));

    // The folder still holds the repository attached there.
    let before = snapshotRows();
    const matching = await reattach();
    expect(matching).toBeInstanceOf(RepoReattachRefusedError);
    expect((matching as RepoReattachRefusedError).detail).toEqual({ reason: "identity_matches" });
    expect(snapshotRows()).toEqual(before);

    // The folder is no repository at all.
    rmSync(join(root, ".git"), { force: true });
    const plain = await reattach();
    expect(plain).toBeInstanceOf(RepoRootResolutionError);
    expect((plain as RepoRootResolutionError).reason).toBe("not_a_repository");
    expect(snapshotRows()).toEqual(before);

    // An agent runs in the project; the refusal names it and its session.
    await replaceRepository(root);
    await seedUnreleasedRun(harness, workspaceId, SESSION_ID, root);
    const agentId = await writeRunQueued();
    before = snapshotRows();
    const running = await reattach();
    expect(running).toBeInstanceOf(RepoReattachConflictError);
    expect((running as RepoReattachConflictError).runningSessionId).toBe(SESSION_ID);
    expect((running as RepoReattachConflictError).runningAgentId).toBe(agentId);
    expect(snapshotRows()).toEqual(before);

    // Another attached mount holds the repository the folder holds now.
    await writeRaw(harness, "UPDATE run_execution_contexts SET released_at = ? WHERE run_id = ?", [
      "2026-01-01T00:00:01.000Z",
      RUN_ID,
    ]);
    const holderId = "0190f9a1-0000-7000-8000-0000000000bb";
    await harness.database.writer.write(
      attachedMountRowStatements({
        id: holderId,
        nodeId: NODE_ID,
        canonicalRoot: join(dirname(root), "holder"),
        commonDir: await realpath(join(root, ".git")),
      }),
    );
    before = snapshotRows();
    const held = await reattach();
    expect(held).toBeInstanceOf(RepoAlreadyAttachedError);
    expect((held as RepoAlreadyAttachedError).conflictingRepoMountId).toBe(holderId);
    expect(snapshotRows()).toEqual(before);
    expect(serviceLogLines).toEqual([]);
  });

  it("moves every workspace to the new mount keeping its id, and prepares each again", async () => {
    const root = await createSeparateGitDirRepository();
    const worktreeRoot = join(dirname(root), "worktree");
    await gitBeside(root, ["-C", root, "worktree", "add", "-q", "-b", "feature", worktreeRoot]);
    const attached = await attachFolder(harness, root);
    const oldMount = readMountFacts(attached.repoMountId);
    const checkoutWorkspaceId = await bindReadyWorkspace(
      harness.workspaces,
      SESSION_ID,
      attached.repoMountId,
      root,
    );
    // A workspace in a worktree of the repository the folder held before.
    const worktreeWorkspaceId = await bindReadyWorkspace(
      harness.workspaces,
      OTHER_SESSION_ID,
      attached.repoMountId,
      root,
    );
    await harness.workspaces.beginRootPreparation(worktreeWorkspaceId, "provisioned-worktree");
    await harness.workspaces.completeRootPreparation(worktreeWorkspaceId, worktreeRoot, {
      checkoutRoot: worktreeRoot,
    });
    const eventsBefore = new Map(
      [SESSION_ID, OTHER_SESSION_ID].map((sessionId) => [
        sessionId,
        readLifecycleEventTypes(harness.database.reader, sessionId),
      ]),
    );

    await replaceRepository(root);
    const serviceLogLines: string[] = [];
    const reattached = await createReattachService(serviceLogLines).reattach({
      repoMountId: attached.repoMountId,
    });

    // A new row at the same root under the same project, anchored on the repository now there.
    expect(reattached.repoMountId).not.toBe(attached.repoMountId);
    expect(readMountFacts(attached.repoMountId).state).toBe("detached");
    expect(readMountFacts(reattached.repoMountId)).toEqual({
      state: "attached",
      canonical_root: oldMount.canonical_root,
      project_id: oldMount.project_id,
      common_dir: await realpath(join(root, ".git")),
    });

    // Every workspace keeps its id; the checkout is ready again, the old repository's worktree is
    // one git does not list for the new repository.
    const checkoutRow = requireWorkspaceRow(harness.database.reader, checkoutWorkspaceId);
    expect(checkoutRow).toMatchObject({
      repo_mount_id: reattached.repoMountId,
      state: "ready",
      fs_root: root,
    });
    const worktreeRow = requireWorkspaceRow(harness.database.reader, worktreeWorkspaceId);
    expect(worktreeRow).toMatchObject({ repo_mount_id: reattached.repoMountId, state: "stale" });
    expect((JSON.parse(worktreeRow.metadata) as Record<string, unknown>)["lastError"]).toBe(
      new TrustEnvelopeViolationError().message,
    );

    // Each session hears its workspace prepared again and the new mount healthy.
    expect(readLifecycleEventTypes(harness.database.reader, SESSION_ID)).toEqual([
      ...(eventsBefore.get(SESSION_ID) ?? []),
      "workspace.preparing",
      "workspace.ready",
      "repo.mount_health_changed",
    ]);
    expect(readLifecycleEventTypes(harness.database.reader, OTHER_SESSION_ID)).toEqual([
      ...(eventsBefore.get(OTHER_SESSION_ID) ?? []),
      "workspace.preparing",
      "workspace.stale",
      "repo.mount_health_changed",
    ]);
    const healthPayload = JSON.parse(
      readLifecycleEnvelopes(harness.database.reader, SESSION_ID).at(-1)?.payload ?? "{}",
    ) as { readonly repoMountId?: string; readonly health?: { readonly status?: string } };
    expect(healthPayload.repoMountId).toBe(reattached.repoMountId);
    expect(healthPayload.health?.status).toBe("healthy");
    expect(serviceLogLines).toHaveLength(1);
    expect(serviceLogLines[0]).toContain("repo.attached");
  });

  it("refuses inside its write a run that started after its checks, writing nothing", async () => {
    const root = await createSeparateGitDirRepository();
    const attached = await attachFolder(harness, root);
    const workspaceId = await bindReadyWorkspace(
      harness.workspaces,
      SESSION_ID,
      attached.repoMountId,
      root,
    );
    await replaceRepository(root);
    const agentId = await writeRunQueued();
    // The run's rows commit after the checks read none, just before the re-attach's own write.
    const writer = harness.database.writer;
    const interferingWriter = Object.create(writer) as DatabaseWriter;
    let isRunSeeded = false;
    interferingWriter.write = async (statements) => {
      if (!isRunSeeded) {
        isRunSeeded = true;
        await writer.write(unreleasedRunStatements(workspaceId, SESSION_ID, root));
      }
      return writer.write(statements);
    };
    const before = snapshotRows();

    const refusal = await captureRejection(() =>
      createReattachService([], {
        reader: harness.database.reader,
        writer: interferingWriter,
      }).reattach({ repoMountId: attached.repoMountId }),
    );

    expect(refusal).toBeInstanceOf(RepoReattachConflictError);
    expect((refusal as RepoReattachConflictError).runningSessionId).toBe(SESSION_ID);
    expect((refusal as RepoReattachConflictError).runningAgentId).toBe(agentId);
    expect(snapshotRows()).toEqual(before);
  });
});

describe("a re-attach", () => {
  beforeEach(async () => {
    fixture = await openWorktreeFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("leaves a tree the new repository does not list on disk through the next cleanup sweep", async () => {
    const tree = await fixture.creator.create({
      repoMountId: fixture.repoMountId,
      sessionId: fixture.seedSession(),
      name: { kind: "tail", tail: "kept" },
      onCollision: "refuse",
    });
    await fixture.repository.write(tree.fsRoot, "notes.txt", UNCOMMITTED_WORK);
    const root = fixture.repository.root;
    const fixtureRoot = fixture.repository.fixtureRoot;
    // The mount is anchored on the repository its folder holds; then the folder gets another,
    // whose git folder lives elsewhere, so its identity differs from the anchor.
    const anchor = realpathSync(join(root, ".git"));
    fixture.db
      .prepare("UPDATE repo_mounts SET metadata = json_set(metadata, ?, ?) WHERE id = ?")
      .run(COMMON_DIR_METADATA_PATH, anchor, fixture.repoMountId);
    renameSync(anchor, join(fixtureRoot, "previous-repository.git"));
    const replacement = join(fixtureRoot, "replacement-repository.git");
    await fixture.repository.git(["init", "-q", "-b", "main", `--separate-git-dir=${replacement}`]);
    expect(realpathSync(replacement)).not.toBe(anchor);

    const sessionEvents = new EventLogService({
      writer: fixture.scratch.writer,
      reader: fixture.scratch.reader,
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    const reattach = new RepoMountReattachService({
      database: fixture.scratch,
      workspaces: fixture.workspaces,
      events: new WorkspaceEventEmitter({ sessionEvents }),
      worktreeEvents: new WorktreeEventEmitter({ sessionEvents }),
      resolver: new RepoRootResolver({ git: fixture.repository.runner }),
      writeServiceLog: () => {},
    });
    await reattach.reattach({ repoMountId: RepoMountIdSchema.parse(fixture.repoMountId) });
    // The re-attach's own write stamped the tree cleaned, before any sweep ran.
    const cleanedAt: unknown = fixture.db
      .prepare("SELECT cleaned_at FROM worktrees WHERE id = ?")
      .pluck()
      .get(tree.worktreeId);
    expect(cleanedAt).not.toBeNull();
    await fixture.worktrees.cleanupPass(fixture.removal, new AbortController().signal);

    expect(existsSync(tree.fsRoot)).toBe(true);
    expect(readFileSync(join(tree.fsRoot, "notes.txt"), "utf8")).toBe(UNCOMMITTED_WORK);
  });
});
