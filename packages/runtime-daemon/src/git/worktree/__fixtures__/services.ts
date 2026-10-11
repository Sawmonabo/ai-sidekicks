// The worktree, workspace and working-folder services wired the way the daemon wires them, over a
// scratch database and one fixture repository attached as a project's mount.

import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { SessionWorkingFolders } from "../../../session/working-folder/move.js";
import { KeyedLock } from "../../../keyed-lock.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { attachedMountRowStatements } from "../../../workspace/__fixtures__/rows.js";
import {
  BOUND_ROOT_METADATA_PATH,
  CHECKOUT_ROOT_METADATA_PATH,
} from "../../../workspace/row-guards.js";
import { WorkspaceEventEmitter } from "../../../workspace/event-emitter.js";
import { ExecutionRootService } from "../../../workspace/execution-root-service.js";
import { WorkspaceService } from "../../../workspace/service.js";
import { DEFAULT_GIT_FILESYSTEM, type GitFilesystem } from "../../filesystem.js";
import { createGitCommand, type GitCommand } from "../../process.js";
import { WorktreeCopiesUnderWay } from "../copy-progress.js";
import { WorktreeCreator, type WorktreeCreatorDeps } from "../creation.js";
import { WorktreeEventEmitter } from "../event-emitter.js";
import { WorktreeNaming } from "../naming.js";
import { MountOccupancyReader } from "../occupancy.js";
import { RemovedWorktreeStore } from "../removed-store.js";
import { WorktreeRemoval } from "../removal.js";
import { WorktreeService } from "../service.js";
import { createFixtureRepository, type FixtureRepository } from "./repository.js";

/** The fixture project's slug, the folder its trees go in. */
export const FIXTURE_PROJECT_SLUG = "fixture-project";
/** The branch pattern the fixture machine names trees with. */
export const FIXTURE_BRANCH_PATTERN = "sidekicks/{session}/{title}";

const SEEDED_AT = "2026-08-04T00:00:00.000Z";
const FIXTURE_GIT_TIMEOUT_MS = 30_000;

/** A workspace row to seed, in a state the services then move. */
interface WorkspaceSeed {
  readonly sessionId: string;
  readonly executionMode: "bound-root" | "provisioned-worktree";
  readonly state: "preparing" | "ready";
  /** The root a `ready` workspace works in; `null` while preparing. */
  readonly fsRoot: string | null;
  readonly boundRoot: string;
  readonly checkoutRoot: string;
}

/** Everything a worktree test drives, and the rows it seeds. */
export interface WorktreeFixture {
  readonly repository: FixtureRepository;
  readonly scratch: ScratchDatabase;
  /** The test's own read-write connection, for seeding rows and reading them back. */
  readonly db: DatabaseType;
  readonly runGit: GitCommand;
  readonly worktreesDirectory: string;
  readonly repoMountId: string;
  readonly worktrees: WorktreeService;
  readonly creator: WorktreeCreator;
  /** The setup card the creator drives, with no project steps: each made tree succeeds at once. */
  readonly setup: WorktreeCreatorDeps["setup"];
  readonly removedWorktrees: RemovedWorktreeStore;
  /** Where the kept copy's copies across volumes report, for a store or a move a test makes. */
  readonly copies: WorktreeCopiesUnderWay;
  readonly removal: WorktreeRemoval;
  readonly workspaces: WorkspaceService;
  readonly executionRoots: ExecutionRootService;
  readonly workingFolders: SessionWorkingFolders;
  /** Every folder the removal asked to end processes in, in order. */
  readonly endedProcessFolders: string[];
  /** Seeds a project session and answers its id. */
  seedSession(name?: string | null): string;
  /** Seeds a workspace on the fixture mount and answers its id. */
  seedWorkspace(seed: WorkspaceSeed): string;
  close(): Promise<void>;
}

/**
 * Opens the services over a new repository. `rename` and `removePath` replace the kept copy's
 * folder move and removal, for a test of a move the system refuses or leaves half done;
 * `newWorktreeId` replaces the id each new tree's row takes.
 */
export async function openWorktreeFixture(
  options: {
    readonly rename?: GitFilesystem["rename"];
    readonly removePath?: GitFilesystem["removePath"];
    readonly newWorktreeId?: () => string;
  } = {},
): Promise<WorktreeFixture> {
  const repository = await createFixtureRepository();
  const scratch = await openScratchDatabase();
  const db = new Database(scratch.databasePath);
  const repoMountId = mintUuidV7();
  for (const statement of attachedMountRowStatements({
    id: repoMountId,
    canonicalRoot: repository.root,
    commonDir: join(repository.root, ".git"),
  })) {
    db.prepare(statement.sql).run(statement.bindings ?? {});
  }

  const eventLog = new EventLogService({
    writer: scratch.writer,
    reader: scratch.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  const worktreeEvents = new WorktreeEventEmitter({ sessionEvents: eventLog });
  const worktreesDirectory = join(repository.fixtureRoot, "worktrees");
  const naming = new WorktreeNaming({
    worktreesDirectory,
    sources: {
      readProjectNaming: async () => ({ slug: FIXTURE_PROJECT_SLUG, branchPattern: null }),
      readMachineBranchPattern: async () => FIXTURE_BRANCH_PATTERN,
    },
  });
  const runGit = createGitCommand({ git: repository.runner, timeoutMs: FIXTURE_GIT_TIMEOUT_MS });
  const occupancy = new MountOccupancyReader(scratch.reader);
  const serviceDeps = {
    database: scratch,
    events: worktreeEvents,
    naming,
    occupancy,
    git: repository.runner,
    gitCommandTimeoutMs: FIXTURE_GIT_TIMEOUT_MS,
    ...(options.newWorktreeId === undefined ? {} : { newWorktreeId: options.newWorktreeId }),
  };
  const worktrees = new WorktreeService(serviceDeps);
  const setup: WorktreeCreatorDeps["setup"] = {
    begin: () => {},
    treeFailed: () => {},
    forget: () => {},
    treeMade: async (made) => ({ worktreeId: made.worktreeId, state: "succeeded", steps: [] }),
  };
  const creator = new WorktreeCreator({
    ...serviceDeps,
    worktrees,
    setup,
    checkoutLock: new KeyedLock<string>(),
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  const keptCopyFilesystem = {
    rename: options.rename ?? DEFAULT_GIT_FILESYSTEM.rename,
    removePath: options.removePath ?? DEFAULT_GIT_FILESYSTEM.removePath,
  };
  const keptCopyLock = new KeyedLock<string>();
  const worktreeCopies = new WorktreeCopiesUnderWay({
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  const removedWorktrees = new RemovedWorktreeStore({
    database: scratch,
    runGit,
    filesystem: keptCopyFilesystem,
    copies: worktreeCopies,
    worktrees,
    worktreesDirectory,
    keptCopyLock,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  const workspaces = new WorkspaceService({
    database: scratch,
    events: new WorkspaceEventEmitter({ sessionEvents: eventLog }),
  });
  const executionRoots = new ExecutionRootService({
    database: scratch,
    workspaces,
    worktrees: {
      create: (input) => creator.create(input),
      dropCarriedStash: (stash, worktreeId) => creator.dropCarriedStash(stash, worktreeId),
      retireUnadopted: (worktreeId) => worktrees.retireUnadopted(worktreeId),
    },
    git: repository.runner,
    gitCommandTimeoutMs: FIXTURE_GIT_TIMEOUT_MS,
  });
  const workingFolders = new SessionWorkingFolders({
    database: scratch,
    executionRoots,
    events: worktreeEvents,
  });
  const endedProcessFolders: string[] = [];
  const removal = new WorktreeRemoval({
    worktrees,
    removedWorktrees,
    worktreesDirectory,
    occupancy,
    processes: [
      {
        endProcessesInFolder: async (folder) => {
          endedProcessFolders.push(folder);
        },
      },
    ],
    sessions: workingFolders,
    runGit,
    filesystem: keptCopyFilesystem,
    copies: worktreeCopies,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
    keptCopyLock,
  });

  return {
    repository,
    scratch,
    db,
    runGit,
    worktreesDirectory,
    repoMountId,
    worktrees,
    creator,
    setup,
    removedWorktrees,
    copies: worktreeCopies,
    removal,
    workspaces,
    executionRoots,
    workingFolders,
    endedProcessFolders,
    seedSession: (name = null) => {
      const sessionId = mintUuidV7();
      db.prepare(
        `INSERT INTO sessions (id, shape, state, name, created_at, updated_at, last_activity_at)
         VALUES (?, 'project', 'active', ?, ?, ?, ?)`,
      ).run(sessionId, name, SEEDED_AT, SEEDED_AT, SEEDED_AT);
      return sessionId;
    },
    seedWorkspace: (seed) => {
      const workspaceId = mintUuidV7();
      db.prepare(
        `INSERT INTO workspaces (
           id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?,
                   json_set('{}', '${BOUND_ROOT_METADATA_PATH}', ?, '${CHECKOUT_ROOT_METADATA_PATH}', ?),
                   ?, ?)`,
      ).run(
        workspaceId,
        seed.sessionId,
        repoMountId,
        seed.executionMode,
        seed.fsRoot,
        seed.state,
        seed.boundRoot,
        seed.checkoutRoot,
        SEEDED_AT,
        SEEDED_AT,
      );
      return workspaceId;
    },
    close: async () => {
      await removedWorktrees.settle();
      db.close();
      await scratch.close();
      repository.remove();
    },
  };
}
