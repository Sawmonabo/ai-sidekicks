// The working-folder watch: tells each subscriber on a folder when the tree there changed, and
// writes a branch changed outside the app back to every session standing in the folder.
//
//   * One watch per folder, shared by every session standing in it and every subscriber; it starts
//     with the first hold and stops with the last release.
//   * The tree is watched through the operating system's own change feed (one recursive watch),
//     leaving out what git ignores (`node_modules`, build output): a change there is no change to
//     the tree. On Linux, where the watch takes one of the account's watches per file and folder,
//     a tree that would take more than are left beside the other folders' is checked on a slow
//     tick instead, comparing what `git status` reports; each change says which of the two found
//     it. What git ignores is read again when a `.gitignore` changes or a new folder appears.
//   * The tree's own git folder is watched alone, not recursively, for its HEAD and its index: a
//     linked tree's git folder sits inside the repository's, out of reach of the tree's watch.
//   * Changes arriving together reach each subscriber as one change; a staleness raised for a
//     session's folder from outside the watch goes through the same path.
//   * The tree's repository may have moved or gone only when its git folder or its root entry
//     changes, so only those changes reach the repository-change listeners.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import { fdir } from "fdir";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkingTreeChange } from "@ai-sidekicks/contracts/repo/git-reads";
import type { SessionBranchChangedPayload } from "@ai-sidekicks/contracts/worktree/events";
import { RepoMountIdSchema } from "@ai-sidekicks/contracts/repo/mount";

import { describeRejection } from "../../rejection.js";
import type { RepeatingJob, ScheduledJobHandle } from "../../daemon/scheduler.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import type { GitCommand } from "../process.js";
import { readCurrentBranch, readTreeGitFolder, readUncommittedPaths } from "./reads.js";
import type { MountOccupancyReader } from "./occupancy.js";

/**
 * How often a folder too large to watch is checked, and the mount-health re-probe's own tick: 180
 * seconds, so what it shows is minutes old at most while git runs a few times an hour.
 */
export const SLOW_TICK_INTERVAL_MS: number = 180_000;

// Linux's per-account ceiling on watches; on macOS and Windows one recursive watch costs one
// handle whatever the tree's size, so no folder is too large there.
const LINUX_WATCH_LIMIT_PATH = "/proc/sys/fs/inotify/max_user_watches";

const GIT_FOLDER_NAME = ".git";
// The files in a tree's own git folder whose change the tree's readers must see.
const HEAD_FILE_NAME = "HEAD";
const INDEX_FILE_NAME = "index";
// The file whose change may change what git ignores in the tree.
const IGNORE_FILE_NAME = ".gitignore";
// Besides one per file and folder, the tree's root and its git folder each take a watch on Linux.
const LINUX_WATCHES_BESIDE_TREE = 2;

/** A session's working folder and the repository mount it belongs to. */
export interface SessionWorkingFolder {
  readonly folder: string;
  readonly repoMountId: string;
}

/** What the working-folder watch runs with. */
export interface WorkingFolderWatcherDeps {
  /** The daemon's one occupancy reader, for the sessions standing in a folder. */
  readonly occupancy: MountOccupancyReader;
  /** The daemon's git entry point, running with the repository's own config. */
  readonly git: GitCommand;
  readonly scheduler: { scheduleRepeating(job: RepeatingJob): ScheduledJobHandle };
  /** The folder a session works in now, or `null` for a session this daemon holds no row for. */
  readonly readSessionWorkingFolder: (sessionId: SessionId) => Promise<SessionWorkingFolder | null>;
  /** Appends `session.branch_changed`, which writes the branch to the session's record. */
  readonly emitBranchChanged: (payload: SessionBranchChangedPayload) => Promise<unknown>;
  /** Where a failed watch, read or write-back is written. */
  readonly writeServiceLog: ServiceLogWriter;
  /** Wall clock for each change's instant; injectable for tests. */
  readonly now?: () => Date;
  /** The platform whose watch limit applies; defaults to the running one. */
  readonly platform?: NodeJS.Platform;
}

interface Subscriber {
  readonly sessionId: SessionId;
  readonly listener: (change: WorkingTreeChange) => void;
}

interface WatchedFolder {
  readonly folder: string;
  readonly repoMountId: string;
  // What git ignores in the tree, relative with `/` between parts; a folder ends with `/`.
  ignoredPaths: ReadonlySet<string>;
  // Reads of the ignored paths run one at a time; one more is due when a change asked meanwhile.
  ignoredRead: Promise<void> | null;
  isIgnoredReadDue: boolean;
  // The Linux watches the tree's watch holds, counted toward the account's ceiling; 0 elsewhere.
  linuxWatchCount: number;
  holdCount: number;
  readonly subscribers: Set<Subscriber>;
  mode: WorkingTreeChange["mode"];
  started: Promise<void>;
  treeWatcher: FSWatcher | null;
  gitFolderWatcher: FSWatcher | null;
  slowTick: ScheduledJobHandle | null;
  lastStatusDigest: string | null;
  // The branch last seen, `undefined` until the first read.
  lastBranch: string | null | undefined;
  // Branch reads run one after another, so two quick HEAD changes write back in order.
  branchCheck: Promise<void>;
  isFlushPending: boolean;
  isClosed: boolean;
}

/** One watch per working folder, its subscribers, and the branch write-back. */
export class WorkingFolderWatcher {
  readonly #deps: WorkingFolderWatcherDeps;
  readonly #occupancy: MountOccupancyReader;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform;
  readonly #watchedByFolder = new Map<string, WatchedFolder>();
  // Each subscriber's folder, so a session that moves is moved with it.
  readonly #folderBySubscriber = new Map<Subscriber, WatchedFolder>();
  readonly #repositoryChangeListeners = new Set<(folder: string) => void>();
  // The Linux watches every folder's watch holds together.
  #linuxWatchesHeld = 0;

  constructor(deps: WorkingFolderWatcherDeps) {
    this.#deps = deps;
    this.#occupancy = deps.occupancy;
    this.#now = deps.now ?? (() => new Date());
    this.#platform = deps.platform ?? process.platform;
  }

  /**
   * Keeps the folder's watches running until the returned release runs; resolves once they have
   * started. A release run twice does nothing.
   */
  async hold(target: SessionWorkingFolder): Promise<() => void> {
    const watched = await this.#acquire(target);
    try {
      await watched.started;
    } catch (error) {
      this.#release(watched);
      throw error;
    }
    let isReleased = false;
    return () => {
      if (!isReleased) {
        isReleased = true;
        this.#release(watched);
      }
    };
  }

  /**
   * Calls `listener` with each change to the folder `sessionId` works in, until the returned detach
   * runs. Throws `SessionNotFoundError` for a session this daemon holds no row for.
   */
  async subscribe(
    sessionId: SessionId,
    listener: (change: WorkingTreeChange) => void,
  ): Promise<() => void> {
    const target = await this.#requireWorkingFolder(sessionId);
    const subscriber: Subscriber = { sessionId, listener };
    const watched = await this.#acquire(target);
    watched.subscribers.add(subscriber);
    this.#folderBySubscriber.set(subscriber, watched);
    try {
      await watched.started;
    } catch (error) {
      this.#detach(subscriber);
      throw error;
    }
    return () => {
      this.#detach(subscriber);
    };
  }

  /**
   * Moves `sessionId`'s subscribers to the folder it works in now; run after the session moves.
   * Throws `SessionNotFoundError` for a session this daemon holds no row for.
   */
  async follow(sessionId: SessionId): Promise<void> {
    const target = await this.#requireWorkingFolder(sessionId);
    const folder = await canonicalFolderPath(target.folder);
    for (const [subscriber, watched] of [...this.#folderBySubscriber]) {
      if (subscriber.sessionId !== sessionId || watched.folder === folder) {
        continue;
      }
      const next = await this.#acquire(target);
      // The subscriber may have detached while the folder's key was read.
      if (this.#folderBySubscriber.get(subscriber) !== watched) {
        this.#release(next);
        continue;
      }
      next.subscribers.add(subscriber);
      this.#folderBySubscriber.set(subscriber, next);
      watched.subscribers.delete(subscriber);
      this.#release(watched);
      await next.started;
    }
  }

  /**
   * Marks the folder `sessionId` works in as changed for every subscriber on it, once; an allowed
   * approval raises it, since work the person has not seen may land there.
   */
  async raiseStaleness(sessionId: SessionId): Promise<void> {
    const target = await this.#requireWorkingFolder(sessionId);
    const watched = this.#watchedByFolder.get(await canonicalFolderPath(target.folder));
    if (watched !== undefined) {
      this.#raise(watched);
    }
  }

  /**
   * Calls `listener` with a watched folder each time its git folder or its root entry changes,
   * which is when the repository there may have moved or gone, until the returned detach runs.
   * The listener must not throw.
   */
  onRepositoryChange(listener: (folder: string) => void): () => void {
    // A wrapper, so one function attached twice detaches once per attach.
    const attached = (folder: string): void => {
      listener(folder);
    };
    this.#repositoryChangeListeners.add(attached);
    return () => {
      this.#repositoryChangeListeners.delete(attached);
    };
  }

  /** Stops every watch; holds, subscribers and repository-change listeners end with them. */
  stop(): void {
    for (const watched of this.#watchedByFolder.values()) {
      this.#close(watched);
    }
    this.#watchedByFolder.clear();
    this.#folderBySubscriber.clear();
    this.#repositoryChangeListeners.clear();
  }

  async #requireWorkingFolder(sessionId: SessionId): Promise<SessionWorkingFolder> {
    const target = await this.#deps.readSessionWorkingFolder(sessionId);
    if (target === null) {
      throw new SessionNotFoundError("This daemon holds no such session.", { sessionId });
    }
    return target;
  }

  // The key is read first; the lookup and the insert then run in one step, so two acquires of one
  // folder share one watch.
  async #acquire(target: SessionWorkingFolder): Promise<WatchedFolder> {
    const folder = await canonicalFolderPath(target.folder);
    const existing = this.#watchedByFolder.get(folder);
    if (existing !== undefined) {
      existing.holdCount += 1;
      return existing;
    }
    const watched: WatchedFolder = {
      folder,
      repoMountId: target.repoMountId,
      ignoredPaths: new Set(),
      ignoredRead: null,
      isIgnoredReadDue: false,
      linuxWatchCount: 0,
      holdCount: 1,
      subscribers: new Set(),
      mode: "watch",
      started: Promise.resolve(),
      treeWatcher: null,
      gitFolderWatcher: null,
      slowTick: null,
      lastStatusDigest: null,
      lastBranch: undefined,
      branchCheck: Promise.resolve(),
      isFlushPending: false,
      isClosed: false,
    };
    this.#watchedByFolder.set(folder, watched);
    watched.started = this.#start(watched);
    return watched;
  }

  #detach(subscriber: Subscriber): void {
    const watched = this.#folderBySubscriber.get(subscriber);
    if (watched === undefined) {
      return;
    }
    this.#folderBySubscriber.delete(subscriber);
    watched.subscribers.delete(subscriber);
    this.#release(watched);
  }

  #release(watched: WatchedFolder): void {
    watched.holdCount -= 1;
    if (watched.holdCount > 0) {
      return;
    }
    this.#close(watched);
    if (this.#watchedByFolder.get(watched.folder) === watched) {
      this.#watchedByFolder.delete(watched.folder);
    }
  }

  #close(watched: WatchedFolder): void {
    watched.isClosed = true;
    this.#closeTreeWatch(watched);
    watched.gitFolderWatcher?.close();
    watched.gitFolderWatcher = null;
    watched.slowTick?.cancel();
    watched.slowTick = null;
  }

  async #start(watched: WatchedFolder): Promise<void> {
    const gitFolder = await readTreeGitFolder(this.#deps.git, watched.folder);
    watched.ignoredPaths = await readIgnoredPaths(this.#deps.git, watched.folder);
    if (watched.isClosed) {
      return;
    }
    this.#watchGitFolder(watched, gitFolder);
    await this.#startTreeWatch(watched);
    // A branch changed while nothing watched (the daemon was stopped) is written back now.
    this.#checkBranch(watched);
    await watched.branchCheck;
  }

  // Watches the tree when its watch fits what is left of the Linux ceiling, else ticks slowly.
  async #startTreeWatch(watched: WatchedFolder): Promise<void> {
    const linuxWatchCount = await this.#countLinuxWatches(watched);
    const limit =
      linuxWatchCount === 0 ? 0 : Number((await readFile(LINUX_WATCH_LIMIT_PATH, "utf8")).trim());
    if (watched.isClosed) {
      return;
    }
    // Checked and taken in one step, so two folders starting together never both take the rest.
    if (linuxWatchCount > 0 && this.#linuxWatchesHeld + linuxWatchCount > limit) {
      if (watched.slowTick === null) this.#startSlowTick(watched);
      return;
    }
    this.#linuxWatchesHeld += linuxWatchCount;
    watched.linuxWatchCount = linuxWatchCount;
    this.#watchTree(watched);
  }

  // The watches the tree's watch takes on Linux, one per file and folder git does not ignore;
  // 0 on any other platform.
  async #countLinuxWatches(watched: WatchedFolder): Promise<number> {
    if (this.#platform !== "linux") {
      return 0;
    }
    const rootPrefix = watched.folder.endsWith(sep) ? watched.folder : `${watched.folder}${sep}`;
    const { files, directories } = await new fdir()
      .onlyCounts()
      .exclude((_name, directoryPath) =>
        isInsideIgnoredPath(watched.ignoredPaths, directoryPath.slice(rootPrefix.length)),
      )
      .crawl(watched.folder)
      .withPromise();
    return files + directories + LINUX_WATCHES_BESIDE_TREE;
  }

  #watchTree(watched: WatchedFolder): void {
    const rootName = basename(watched.folder);
    let treeWatcher: FSWatcher;
    try {
      treeWatcher = watch(
        watched.folder,
        {
          recursive: true,
          // Read at each change, so a fresh read of what git ignores takes effect at once.
          ignore: (changedPath) => isInsideIgnoredPath(watched.ignoredPaths, changedPath),
        },
        (eventType, changedPath) => {
          // The root itself is named by its own name, by nothing, or not at all, by platform.
          const isRootEntry =
            changedPath === null || changedPath === "" || changedPath === rootName;
          if (isRootEntry || changedPath === GIT_FOLDER_NAME) {
            this.#announceRepositoryChange(watched);
          }
          // The checkout's own git folder is the git-folder watch's; a linked tree's `.git` is a
          // pointer file that never changes what the tree holds.
          if (
            changedPath !== null &&
            (changedPath === GIT_FOLDER_NAME || changedPath.startsWith(`${GIT_FOLDER_NAME}${sep}`))
          ) {
            return;
          }
          if (changedPath !== null && !isRootEntry) {
            this.#noteIgnoreChange(watched, eventType, changedPath);
          }
          this.#raise(watched);
        },
      );
    } catch (error) {
      this.#fallBackToSlowTick(watched, error);
      return;
    }
    // Past the machine's watch limit the watch fails partway; the slow tick takes over.
    treeWatcher.on("error", (error: Error) => {
      this.#announceRepositoryChange(watched);
      this.#fallBackToSlowTick(watched, error);
    });
    watched.treeWatcher = treeWatcher;
    watched.mode = "watch";
  }

  #closeTreeWatch(watched: WatchedFolder): void {
    watched.treeWatcher?.close();
    watched.treeWatcher = null;
    this.#linuxWatchesHeld -= watched.linuxWatchCount;
    watched.linuxWatchCount = 0;
  }

  #fallBackToSlowTick(watched: WatchedFolder, error: unknown): void {
    this.#deps.writeServiceLog(
      `A working folder could not be watched, so it is checked on a slow tick: ` +
        describeRejection(error),
    );
    this.#closeTreeWatch(watched);
    if (!watched.isClosed && watched.slowTick === null) {
      this.#startSlowTick(watched);
    }
  }

  // A changed `.gitignore`, or a folder that appeared, may change what git ignores.
  #noteIgnoreChange(watched: WatchedFolder, eventType: string, changedPath: string): void {
    if (basename(changedPath) === IGNORE_FILE_NAME) {
      this.#readIgnoredAgain(watched);
      return;
    }
    if (eventType !== "rename") {
      return;
    }
    void lstat(join(watched.folder, changedPath)).then(
      (entry) => {
        if (entry.isDirectory()) this.#readIgnoredAgain(watched);
      },
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        // A removed entry has nothing to read.
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          this.#deps.writeServiceLog(
            `A new entry in a working folder could not be read: ${describeRejection(error)}`,
          );
        }
      },
    );
  }

  // Reads what git ignores again, one read at a time. On Linux a watch that now holds watches in a
  // newly ignored folder starts over, so it gives them back.
  #readIgnoredAgain(watched: WatchedFolder): void {
    if (watched.ignoredRead !== null) {
      watched.isIgnoredReadDue = true;
      return;
    }
    watched.ignoredRead = (async () => {
      do {
        watched.isIgnoredReadDue = false;
        const read = await readIgnoredPaths(this.#deps.git, watched.folder);
        const hasGrown = [...read].some((ignored) => !watched.ignoredPaths.has(ignored));
        watched.ignoredPaths = read;
        if (hasGrown && watched.linuxWatchCount > 0 && !watched.isClosed) {
          this.#closeTreeWatch(watched);
          await this.#startTreeWatch(watched);
        }
      } while (watched.isIgnoredReadDue && !watched.isClosed);
    })()
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `What git ignores in a working folder could not be read again, so changes there still ` +
            `count: ${describeRejection(error)}`,
        );
      })
      .finally(() => {
        watched.ignoredRead = null;
      });
  }

  #announceRepositoryChange(watched: WatchedFolder): void {
    if (watched.isClosed) {
      return;
    }
    for (const listener of this.#repositoryChangeListeners) {
      listener(watched.folder);
    }
  }

  #startSlowTick(watched: WatchedFolder): void {
    watched.mode = "slow_tick";
    watched.slowTick = this.#deps.scheduler.scheduleRepeating({
      name: "working folder slow tick",
      intervalMs: SLOW_TICK_INTERVAL_MS,
      run: () => this.#tick(watched),
    });
  }

  // A change to an already-changed file leaves `git status` as it was, so each listed path's size
  // and modified time join the comparison.
  async #tick(watched: WatchedFolder): Promise<void> {
    const paths = await readUncommittedPaths(this.#deps.git, watched.folder);
    const digest = createHash("sha256");
    for (const path of paths) {
      digest.update(path);
      digest.update("\0");
      try {
        const entry = await lstat(join(watched.folder, path), { bigint: true });
        digest.update(`${String(entry.size)}:${String(entry.mtimeNs)}`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw error;
        }
        // A deleted file is listed by status and has nothing to stat.
        digest.update("gone");
      }
      digest.update("\0");
    }
    const statusDigest = digest.digest("hex");
    const isFirstTick = watched.lastStatusDigest === null;
    const hasChanged = watched.lastStatusDigest !== statusDigest;
    watched.lastStatusDigest = statusDigest;
    if (!isFirstTick && hasChanged) {
      this.#raise(watched);
    }
  }

  #watchGitFolder(watched: WatchedFolder, gitFolder: string): void {
    const gitFolderName = basename(gitFolder);
    const gitFolderWatcher = watch(gitFolder, (_event, changedFile) => {
      // The watch names the git folder itself when it moved or went.
      if (changedFile === null || changedFile === gitFolderName) {
        this.#announceRepositoryChange(watched);
      } else if (changedFile === HEAD_FILE_NAME) {
        this.#checkBranch(watched);
        this.#raise(watched);
      } else if (changedFile === INDEX_FILE_NAME) {
        this.#raise(watched);
      }
    });
    gitFolderWatcher.on("error", (error: Error) => {
      this.#announceRepositoryChange(watched);
      this.#deps.writeServiceLog(
        `A working folder's git folder stopped being watched, so a branch changed there is not ` +
          `written back: ${error.message}`,
      );
      gitFolderWatcher.close();
      watched.gitFolderWatcher = null;
    });
    watched.gitFolderWatcher = gitFolderWatcher;
  }

  // Coalesces every change of one turn into one emission per subscriber.
  #raise(watched: WatchedFolder): void {
    if (watched.isFlushPending || watched.isClosed) {
      return;
    }
    watched.isFlushPending = true;
    setImmediate(() => {
      watched.isFlushPending = false;
      if (watched.isClosed) {
        return;
      }
      const changedAt = this.#now().toISOString();
      for (const subscriber of watched.subscribers) {
        subscriber.listener({ sessionId: subscriber.sessionId, changedAt, mode: watched.mode });
      }
    });
  }

  #checkBranch(watched: WatchedFolder): void {
    watched.branchCheck = watched.branchCheck
      .then(() => this.#writeBackBranch(watched))
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `A branch changed in a working folder could not be written back: ` +
            describeRejection(error),
        );
      });
  }

  async #writeBackBranch(watched: WatchedFolder): Promise<void> {
    if (watched.isClosed) {
      return;
    }
    const branch = await readCurrentBranch(this.#deps.git, watched.folder);
    if (branch === watched.lastBranch) {
      return;
    }
    watched.lastBranch = branch;
    const repoMountId = RepoMountIdSchema.parse(watched.repoMountId);
    const standing =
      (await this.#occupancy.read(watched.repoMountId)).standingByFolder.get(watched.folder) ?? [];
    for (const session of standing) {
      if (session.recordedBranch === branch) {
        continue;
      }
      await this.#deps.emitBranchChanged({
        sessionId: session.sessionId,
        repoMountId,
        worktreeId: session.worktreeId,
        branch,
        previousBranch: session.recordedBranch,
      });
    }
  }
}

// What git ignores in `folder`, each path relative with `/` between parts, a folder ending in `/`:
// a folder git ignores whole is listed once, not entered.
async function readIgnoredPaths(git: GitCommand, folder: string): Promise<Set<string>> {
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    folder,
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  return new Set(
    stdout
      .toString("utf8")
      .split("\0")
      .filter((ignored) => ignored !== ""),
  );
}

// Whether `relativePath` (the platform's separators) is a path git ignores or lies in a folder it
// ignores.
function isInsideIgnoredPath(ignoredPaths: ReadonlySet<string>, relativePath: string): boolean {
  if (ignoredPaths.size === 0) {
    return false;
  }
  const parts = relativePath.split(sep).filter((part) => part !== "");
  let prefix = "";
  for (const part of parts) {
    prefix = `${prefix}${part}`;
    if (ignoredPaths.has(prefix) || ignoredPaths.has(`${prefix}/`)) {
      return true;
    }
    prefix = `${prefix}/`;
  }
  return false;
}
