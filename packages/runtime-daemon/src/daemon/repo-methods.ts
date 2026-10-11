// Builds the daemon's repository services over the session services' one database and binds every
// `repo.*` verb they answer, plus `session.setWorkingFolder`. Their start, once the daemon's
// recovery pass has ended, begins their background work: the scheduler's wake signal, the
// mount-health probe (at start, which every health read waits for up to the git timeout, then on
// wake, on its slow tick and when a watched tree's repository may have moved), the watch and fetch
// each live session's folder holds, the worktree cleanup, which first puts right the discards,
// put-backs and copies a crash cut short (at start, on wake, and after each removal and detach),
// and the clone service once git's question program is listening, where the platform has its
// launcher. Every path that retires a tree then drops its setup card.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { waitWithin } from "../bounded-wait.js";
import { settleAll } from "../settle-all.js";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { EventLogService } from "../events/log-service.js";
import { DEFAULT_GIT_FILESYSTEM } from "../git/filesystem.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, type GitCommand } from "../git/process.js";
import { KeyedLock } from "../keyed-lock.js";
import { describeRejection } from "../rejection.js";
import { BranchListReader } from "../git/worktree/branch-list.js";
import { WorktreeCopiesUnderWay } from "../git/worktree/copy-progress.js";
import { WorktreeCreator } from "../git/worktree/creation.js";
import { WorktreeNotFoundError } from "../git/worktree/errors.js";
import { WorktreeEventEmitter } from "../git/worktree/event-emitter.js";
import { BackgroundFetch } from "../git/worktree/fetch.js";
import { LiveSessionFolders } from "../git/worktree/live-session-folders.js";
import { WorktreeNaming, worktreesDirectoryOf } from "../git/worktree/naming.js";
import { MountOccupancyReader } from "../git/worktree/occupancy.js";
import { WorktreeRemoval } from "../git/worktree/removal.js";
import { RemovedWorktreeStore } from "../git/worktree/removed-store.js";
import { WorktreeService } from "../git/worktree/service.js";
import { WorktreeSetupRunner } from "../git/worktree/setup.js";
import { WorktreeStatusReader } from "../git/worktree/status.js";
import { SLOW_TICK_INTERVAL_MS, WorkingFolderWatcher } from "../git/worktree/watch.js";
import { registerRepoBranchMethods } from "../ipc/handlers/repo/branches.js";
import { registerRepoCloneMethods } from "../ipc/handlers/repo/clone.js";
import { registerRepoFolderMethods } from "../ipc/handlers/repo/folders.js";
import { registerRepoMountMethods } from "../ipc/handlers/repo/mounts.js";
import { registerRepoProjectMethods } from "../ipc/handlers/repo/projects.js";
import { registerRepoWorkingTreeMethods } from "../ipc/handlers/repo/working-tree.js";
import { registerRepoWorkspaceMethods } from "../ipc/handlers/repo/workspaces.js";
import { registerRepoWorktreeMethods } from "../ipc/handlers/repo/worktrees.js";
import type { OutboundQueue } from "../ipc/handlers/session/subscribe.js";
import { registerSessionWorkingFolder } from "../ipc/handlers/session/working-folder.js";
import type { StreamingPrimitive } from "../ipc/streaming-primitive.js";
import {
  buildCommandSpawnEnv,
  type SpawnEnvNameMatch,
  type SpawnEnvPair,
} from "../provider/spawn-env.js";
import type { SessionCreation } from "../session/create.js";
import type { RunSetupGate } from "../session/run/setup-gates.js";
import { SessionWorkingFolders } from "../session/working-folder/move.js";
import { AskpassBroker } from "../workspace/clone/askpass/broker.js";
import { CloneService } from "../workspace/clone/service.js";
import type { StreamedGitRunner } from "../workspace/clone/streamed-git.js";
import type { WorkspaceEventEmitter } from "../workspace/event-emitter.js";
import { ExecutionRootService } from "../workspace/execution-root-service.js";
import { FolderListService } from "../workspace/folder/list.js";
import type { FolderPlace } from "../workspace/folder/place.js";
import type { ProjectListFeed } from "../workspace/project/list-feed.js";
import type { ProjectRecords } from "../workspace/project/records.js";
import type { ProjectService } from "../workspace/project/service.js";
import { RepoFolderUsage } from "../workspace/folder/usage.js";
import { RepoMountHealthReprobe } from "../workspace/repo/mount-health.js";
import type { RepoMountService } from "../workspace/repo/mount-service.js";
import { RepoMountReattachService } from "../workspace/repo/reattach.js";
import type { RepoRootResolver } from "../workspace/repo/root-resolver.js";
import { ExecutionRootSetupGate } from "../workspace/run-setup-gate.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { MachineSettingsFile } from "./machine/settings/file.js";
import { Scheduler } from "./scheduler.js";

/** What the repository services are built from: the session services' own, and the daemon's. */
export interface RepoMethodsDeps {
  /** The one database every repository service and the event log write through. */
  readonly database: DatabaseConnections;
  readonly eventLog: EventLogService;
  readonly workspaceEvents: WorkspaceEventEmitter;
  readonly workspaces: WorkspaceService;
  readonly repoMounts: RepoMountService;
  readonly projects: ProjectService;
  readonly projectRecords: ProjectRecords;
  readonly projectListFeed: ProjectListFeed;
  /** Finishes the sessions a create left provisioning once a clone attaches their project. */
  readonly creation: Pick<SessionCreation, "finishProvisioningSessions">;
  /** The one resolver the mount and workspace services read repositories through. */
  readonly resolver: RepoRootResolver;
  readonly git: GitCommand;
  /** The same `git`, run streamed for a clone or a fetch. */
  readonly streamedGit: StreamedGitRunner;
  readonly settingsFile: MachineSettingsFile;
  readonly homeDirectory: string;
  readonly folderPlace: FolderPlace;
  /** The login shell a project's setup commands run in; `null` runs the system's default one. */
  readonly commandShell: string | null;
  /** How this system compares environment variable names. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
  /** The login shell's environment, which a project's setup commands are built from. */
  readonly baseEnvironment: readonly SpawnEnvPair[];
  readonly streamingPrimitive: StreamingPrimitive;
  readonly outboundQueue: OutboundQueue;
  readonly writeServiceLog: (line: string) => void;
}

/** The repository services' start and stop, and the gate a run passes before it starts. */
export interface RepoMethods {
  /** Begins their background work; called once, after the daemon's recovery pass has ended. */
  readonly start: () => void;
  /**
   * Ends their background work, settling once each has finished or left what it had under way and
   * nothing more writes to the database; one failure is thrown as itself, several together.
   */
  readonly stop: () => Promise<void>;
  /** Makes a run's execution root ready before the run starts, for the run engine to register. */
  readonly setupGate: RunSetupGate;
}

/**
 * Builds the repository services and registers their verbs on `registry`. Throws when the event
 * log writes through another database writer than `database`'s, since a worktree's row then could
 * not commit in its event's own write.
 */
export function registerRepoMethods(registry: MethodRegistry, deps: RepoMethodsDeps): RepoMethods {
  const { database, git, projectListFeed, projectRecords, writeServiceLog } = deps;
  if (!deps.eventLog.writesThrough(database.writer)) {
    throw new Error(
      "The repository services and the event log must write through one database writer",
    );
  }
  const scheduler = new Scheduler({ writeServiceLog });
  const worktreeEvents = new WorktreeEventEmitter({ sessionEvents: deps.eventLog });
  const readSettings = async () => (await deps.settingsFile.read()).settings;

  const backgroundFetch = new BackgroundFetch({
    scheduler,
    database,
    git,
    streamedGit: deps.streamedGit,
    writeServiceLog,
  });
  // The sessions standing in each folder, read by every service that asks.
  const occupancy = new MountOccupancyReader(database.reader);
  const watcher = new WorkingFolderWatcher({
    occupancy,
    git,
    scheduler,
    // Called only after the live folders below exist.
    readSessionWorkingFolder: (sessionId) => liveFolders.readWorkingFolder(sessionId),
    emitBranchChanged: (payload) => worktreeEvents.emitBranchChanged({ payload }),
    writeServiceLog,
  });
  const liveFolders = new LiveSessionFolders({
    reader: database.reader,
    watcher,
    fetch: backgroundFetch,
    followAll: (onCommitted, onGap) => deps.eventLog.followAll(onCommitted, onGap),
    writeServiceLog,
  });

  const setup = new WorktreeSetupRunner({
    git,
    // Called only after the worktree service below exists.
    requireWorktree: (worktreeId) => {
      worktrees.requireWorktree(worktreeId);
    },
    // A card is begun before its tree's row is written, so a tree with no row is not retired.
    isRetired: (worktreeId) => {
      try {
        return worktrees.requireWorktree(worktreeId).state === "retired";
      } catch (error) {
        if (error instanceof WorktreeNotFoundError) return false;
        throw error;
      }
    },
    readProjectSetup: async (worktreeId) => projectRecords.readSetupOfWorktree(worktreeId),
    startWatches: (target) => watcher.hold(target),
    commandShell: deps.commandShell,
    commandEnvironment: async (worktreeId) =>
      Object.fromEntries(
        buildCommandSpawnEnv({
          baseEnv: deps.baseEnvironment,
          environmentRows: {
            everyProject: (await readSettings()).environmentRows,
            project: projectRecords.readEnvironmentRowsOfWorktree(worktreeId),
          },
          hostEnvNameMatch: deps.environmentNameMatch,
        }),
      ),
    writeServiceLog,
  });
  const worktreesDirectory = worktreesDirectoryOf(deps.homeDirectory);
  const serviceDeps = {
    database,
    events: worktreeEvents,
    occupancy,
    naming: new WorktreeNaming({
      worktreesDirectory,
      sources: {
        readProjectNaming: async (repoMountId) => projectRecords.readNaming(repoMountId),
        readMachineBranchPattern: async () => (await readSettings()).branchNamePattern,
      },
    }),
  };
  const worktrees = new WorktreeService(serviceDeps);
  // One per checkout, by its `canonicalFolderPath`: a carry's last check and stash, and a run's
  // binding there, each taken inside its workspace's preparation lock.
  const checkoutLock = new KeyedLock<string>();
  const creator = new WorktreeCreator({
    ...serviceDeps,
    worktrees,
    setup,
    writeServiceLog,
    checkoutLock,
  });

  const executionRoots = new ExecutionRootService({
    database,
    workspaces: deps.workspaces,
    worktrees: {
      create: (input) => creator.create(input),
      dropCarriedStash: (stash, worktreeId) => creator.dropCarriedStash(stash, worktreeId),
      retireUnadopted: async (worktreeId) => {
        try {
          return await worktrees.retireUnadopted(worktreeId);
        } finally {
          setup.forgetRetired();
        }
      },
    },
  });
  const workingFolders = new SessionWorkingFolders({
    database,
    executionRoots,
    events: worktreeEvents,
  });
  // One per kept copy, by its id: its discard, any repair of it, its put-back and its deletion.
  const keptCopyLock = new KeyedLock<string>();
  // The copies across volumes the discards and put-backs make, which the copy stream follows.
  const worktreeCopies = new WorktreeCopiesUnderWay({ writeServiceLog });
  const removedWorktrees = new RemovedWorktreeStore({
    database,
    runGit: git,
    filesystem: DEFAULT_GIT_FILESYSTEM,
    copies: worktreeCopies,
    worktrees,
    worktreesDirectory,
    writeServiceLog,
    keptCopyLock,
  });
  const removal = new WorktreeRemoval({
    worktrees,
    removedWorktrees,
    occupancy,
    sessions: workingFolders,
    processes: [setup],
    runGit: git,
    filesystem: DEFAULT_GIT_FILESYSTEM,
    copies: worktreeCopies,
    writeServiceLog,
    worktreesDirectory,
    keptCopyLock,
  });
  const reattach = new RepoMountReattachService({
    database,
    workspaces: deps.workspaces,
    events: deps.workspaceEvents,
    worktreeEvents,
    resolver: deps.resolver,
    writeServiceLog,
  });
  const gate = new ExecutionRootSetupGate({
    database,
    executionRoots,
    workspaces: deps.workspaces,
    workingFolders,
    reattachedWorkspaces: reattach,
    checkoutLock,
  });
  const health = new RepoMountHealthReprobe({
    database,
    events: deps.workspaceEvents,
    resolver: deps.resolver,
    writeServiceLog,
  });
  // A probe's failure goes to the service log, never to a caller; the next trigger probes again.
  const followReprobe = (pass: Promise<void>): Promise<void> =>
    pass.catch((error: unknown) => {
      writeServiceLog(`The repository health re-probe failed: ${describeRejection(error)}`);
    });
  // Settles once the start probe has ended, and never rejects; resolved until the start begins it.
  let startProbeSettled: Promise<void> = Promise.resolve();

  // The broker listens before the clone service starts, and recovery runs before any clone. The
  // clone service settles `null` where it never starts: a platform with no askpass launcher, or a
  // stop before the start; each clone verb is then unavailable.
  const clonesStarting = Promise.withResolvers<CloneService | null>();
  let broker: AskpassBroker | undefined;
  let cloneService: CloneService | undefined;
  const startClones = async (): Promise<CloneService> => {
    broker = await AskpassBroker.start(writeServiceLog);
    cloneService = new CloneService({
      projects: deps.projects,
      records: projectRecords,
      askpass: broker,
      readCloneFolderSetting: async () => (await readSettings()).cloneFolder,
      homeDirectory: deps.homeDirectory,
      folderPlace: deps.folderPlace,
      git,
      streamedGit: deps.streamedGit,
      onCloneAttached: (projectId) => deps.creation.finishProvisioningSessions(projectId),
      writeServiceLog,
    });
    await cloneService.recoverInterruptedClones();
    return cloneService;
  };
  // Each clone verb answers `repo.clone_unavailable` while the service is not running; the log
  // records why.
  const canStartClones = AskpassBroker.hasLauncherOn(process.platform);
  if (!canStartClones) {
    clonesStarting.resolve(null);
    writeServiceLog(
      "The clone service was not started: git's question program has no launcher on this platform",
    );
  }
  clonesStarting.promise.catch((error: unknown) => {
    writeServiceLog(`The clone service could not start: ${describeRejection(error)}`);
  });
  // What the clone start opened closes once it settles, the clone service before the broker its
  // questions go through.
  let clonesStart: Promise<CloneService> | undefined;
  const closeClones = async (): Promise<void> => {
    await Promise.allSettled([clonesStart]);
    await cloneService?.close();
    await broker?.close();
  };

  // Requests made before a cleanup starts share it; one made while it runs starts another. Each
  // first puts right the discards, put-backs and copies a crash cut short, so one that failed is
  // tried again on the next.
  let isCleanupRequested = false;
  // Set by the stop: a retire or detach that ends during it requests nothing of the stopped
  // scheduler, whose refusal would replace that call's own answer.
  let isStopping = false;
  const requestCleanup = (): void => {
    if (isStopping || isCleanupRequested) return;
    isCleanupRequested = true;
    scheduler.schedule({
      name: "worktree cleanup",
      delayMs: 0,
      run: async (signal) => {
        isCleanupRequested = false;
        try {
          const repair = await removal.finishInterruptedKeptCopies(signal);
          for (const { removedWorktreeId, failure } of repair.failures) {
            writeServiceLog(
              `Kept worktree ${removedWorktreeId} could not be put right after a crash or a ` +
                "failed step; the next cleanup tries again: " +
                describeRejection(failure),
            );
          }
          for (const { folder, failure } of repair.leftoverCopyFailures) {
            writeServiceLog(
              `The copy a crash cut short at ${folder} could not be removed; the next cleanup ` +
                `tries again: ${describeRejection(failure)}`,
            );
          }
          // A discard put right lists its kept copy and retires its tree, and a put-back undone
          // lists its kept copy whole again.
          if (repair.repairedRemovedWorktreeIds.length > 0) projectListFeed.refresh();
          if (signal.aborted) return;
          const { retiredWorktreeIds } = await worktrees.cleanupPass(removal, signal);
          if (retiredWorktreeIds.length > 0) projectListFeed.refresh();
        } catch (failure) {
          // A pass that failed on some rows may still have retired others.
          projectListFeed.refresh();
          throw failure;
        } finally {
          setup.forgetRetired();
        }
      },
    });
  };

  registerRepoMountMethods(registry, {
    projects: {
      attachOrFind: (request) => deps.projects.attachOrFind(request),
      detach: async (request) => {
        const outcome = await deps.projects.detach(request);
        requestCleanup();
        return outcome;
      },
    },
    mounts: {
      // Answered once the start probe has ended, or once the git timeout has passed while it runs
      // on: the read probes the mount afresh either way.
      read: async (repoMountId) => {
        await waitWithin(startProbeSettled, DEFAULT_GIT_COMMAND_TIMEOUT_MS);
        return deps.repoMounts.read(repoMountId);
      },
    },
    folderUsage: new RepoFolderUsage(database.reader, occupancy, deps.folderPlace),
    reattach: {
      reattach: async (request) => {
        try {
          return await reattach.reattach(request);
        } finally {
          setup.forgetRetired();
          projectListFeed.refresh();
        }
      },
    },
  });
  registerRepoWorkspaceMethods(registry, { workspaces: deps.workspaces });
  registerRepoProjectMethods(registry, {
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    listFeed: projectListFeed,
    projects: deps.projects,
  });
  registerRepoCloneMethods(registry, {
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    clones: clonesStarting.promise,
  });
  registerRepoFolderMethods(registry, {
    folders: new FolderListService({
      homeDirectory: deps.homeDirectory,
      folderPlace: deps.folderPlace,
      git,
    }),
  });
  registerRepoBranchMethods(registry, {
    branches: new BranchListReader({ reader: database.reader, git, fetch: backgroundFetch }),
  });
  registerRepoWorkingTreeMethods(registry, {
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    watcher,
  });
  registerRepoWorktreeMethods(registry, {
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    executionRoots,
    status: new WorktreeStatusReader({
      reader: database.reader,
      occupancy,
      git,
      fetch: backgroundFetch,
      newWorktree: creator,
    }),
    removal: {
      retire: async (request) => {
        try {
          return await removal.retire(request);
        } finally {
          // A retire can fail after its retirement committed and its kept copy was listed.
          setup.forgetRetired();
          projectListFeed.refresh();
          requestCleanup();
        }
      },
    },
    removedWorktrees,
    setup,
    copies: worktreeCopies,
  });
  registerSessionWorkingFolder(registry, { workingFolders });

  // Set by the start: lets go of the triggers it hooked up.
  let detachTriggers: (() => void) | undefined;

  return {
    start: () => {
      if (isStopping) return;
      startProbeSettled = followReprobe(health.startProbe());
      if (canStartClones) {
        clonesStart = startClones();
        clonesStart.then(clonesStarting.resolve, clonesStarting.reject);
      }
      const reprobeTick = scheduler.scheduleRepeating({
        name: "repository health re-probe",
        intervalMs: SLOW_TICK_INTERVAL_MS,
        firstDelayMs: SLOW_TICK_INTERVAL_MS,
        run: () => health.reprobe(),
      });
      const detachFromRepositoryChanges = watcher.onRepositoryChange((folder) => {
        void followReprobe(health.reprobeMountsContaining(folder));
      });
      const detachFromWake = scheduler.onWake(() => {
        void followReprobe(health.reprobe());
        requestCleanup();
      });
      detachTriggers = () => {
        reprobeTick.cancel();
        detachFromWake();
        detachFromRepositoryChanges();
      };
      requestCleanup();
      liveFolders.start();
    },
    stop: async () => {
      isStopping = true;
      detachTriggers?.();
      if (clonesStart === undefined) {
        // A stop before the start leaves the clone service never started.
        clonesStarting.resolve(null);
      }
      // The health passes, the setup commands, the clone service and the fetches begin ending at
      // once, so each setup command's process group gets the daemon's whole stop window.
      try {
        await settleAll(
          [
            health.stop(),
            setup.stop(),
            closeClones(),
            backgroundFetch.stop(),
            (async () => {
              // After the folder syncs: one still running may schedule its watch's slow tick,
              // which a stopped scheduler refuses.
              await liveFolders.stop();
              // Aborts the running job's signal, so a cleanup ends at its next check.
              await scheduler.stop();
              watcher.stop();
            })(),
          ],
          "stopping the repository services",
        );
      } finally {
        // Last, so nothing writes to the database once the stop resolves; neither a size read nor
        // the deletion of a kept copy put back rejects, since each writes its own failure to the
        // service log.
        await removedWorktrees.settle();
      }
    },
    setupGate: {
      assertRunReady: async (context) => {
        try {
          await gate.assertRunReady(context);
        } finally {
          projectListFeed.refresh();
        }
      },
      onRunTerminal: async (context) => {
        try {
          await gate.onRunTerminal(context);
        } finally {
          projectListFeed.refresh();
        }
      },
    },
  };
}
