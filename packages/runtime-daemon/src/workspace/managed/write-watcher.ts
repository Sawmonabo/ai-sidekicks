// Reports each write a chat makes in its managed workspace, as it lands. One recursive watch on the
// folder holding every chat's workspace serves them all, through the operating system's own change
// feed (FSEvents on macOS, one stream), so no chat costs a watcher of its own and nothing scans on
// a timer.
//
//   * The feed names a path and not what happened to it, and a delete reads like a write, so each
//     report is checked on disk: a path that is gone was removed, not written.
//   * Each change is looked at synchronously as it arrives, so the work is the feed's own pace and
//     nothing queues; changes the feed merges, two writes in one instant, arrive as one.
//   * The feed can name one write twice, its create and its content in two deliveries, and names a
//     mode change too, so a path whose content and modified time are unchanged since its last
//     report is not reported again. Those last reports are kept for a bounded number of recent
//     paths.
//   * The workspace's own `.git` folder and the workspace folder itself are the daemon's, not the
//     chat's, so neither is reported.

import { lstatSync, realpathSync, watch, type BigIntStats, type FSWatcher } from "node:fs";
import * as path from "node:path";

import { LRUCache } from "lru-cache";

import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { DEFAULT_GIT_FILESYSTEM } from "../../git/filesystem.js";
import { managedWorkspacesDirectoryOf } from "./service.js";

const GIT_METADATA_FOLDER_NAME = ".git";

// The recent paths whose last reported entry is kept, to tell a repeated notice from a new write.
// A path pushed out is reported once more on its next notice, which costs one extra version.
const RECENT_REPORTED_PATH_LIMIT = 10_000;

/** One write a chat made in its managed workspace. */
export interface ManagedWorkspaceWrite {
  readonly sessionId: SessionId;
  /** The written entry's path inside the session's workspace, its segments joined by `/`. */
  readonly relativePath: string;
  /** A file, or a folder the chat made. */
  readonly kind: "file" | "directory";
}

/** Constructor dependencies. */
export interface ManagedWorkspaceWriteWatcherDeps {
  /** The person's home folder; the workspaces sit in the daemon's data folder inside it. */
  readonly homeDirectory: string;
  /** Where a change the watcher cannot report, and the watch's own failure, are written. */
  readonly writeServiceLog: ServiceLogWriter;
}

/** The one watch over every chat's managed workspace, and the listeners its writes go to. */
export class ManagedWorkspaceWriteWatcher {
  /**
   * Resolves with the reason if the watch cannot start or fails; from then on no write is
   * reported. Never settles otherwise.
   */
  readonly whenFailed: Promise<Error>;

  readonly #workspacesDirectory: string;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #listeners = new Set<(write: ManagedWorkspaceWrite) => void>();
  // Each recent path's last reported entry, by its watched path.
  readonly #reportedEntries = new LRUCache<string, string>({ max: RECENT_REPORTED_PATH_LIMIT });
  readonly #failure = Promise.withResolvers<Error>();
  #watcher: FSWatcher | undefined;
  #watchedDirectory = "";

  constructor(deps: ManagedWorkspaceWriteWatcherDeps) {
    this.whenFailed = this.#failure.promise;
    this.#workspacesDirectory = managedWorkspacesDirectoryOf(deps.homeDirectory);
    this.#writeServiceLog = deps.writeServiceLog;
  }

  /**
   * Creates the workspaces folder when absent and starts the watch; a watch that cannot start
   * resolves {@link whenFailed}. Throws when the watch is already running.
   */
  async start(): Promise<void> {
    if (this.#watcher !== undefined) {
      throw new Error("The managed workspaces watcher is already running");
    }
    try {
      // The change feed cannot watch a folder that does not exist yet.
      await DEFAULT_GIT_FILESYSTEM.createDirectory(this.#workspacesDirectory);
      this.#watchedDirectory = realpathSync(this.#workspacesDirectory);
      const watcher = watch(this.#watchedDirectory, { recursive: true }, (_event, changedPath) => {
        this.#reportChange(changedPath);
      });
      // An unhandled `error` event would end the daemon.
      watcher.on("error", (error: Error) => {
        this.#fail("failed", error);
      });
      this.#watcher = watcher;
    } catch (error) {
      this.#fail("could not start", error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Stops the watch; a repeat does nothing. */
  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /**
   * Calls `listener` with each write from now on, until the returned detach runs. A listener's
   * throw is not caught.
   */
  onWrite(listener: (write: ManagedWorkspaceWrite) => void): () => void {
    // A wrapper, so one function attached twice detaches once per attach.
    const attached = (write: ManagedWorkspaceWrite): void => {
      listener(write);
    };
    this.#listeners.add(attached);
    return () => {
      this.#listeners.delete(attached);
    };
  }

  #fail(outcome: "could not start" | "failed", error: Error): void {
    this.#writeServiceLog(`The managed workspaces watcher ${outcome}: ${error.message}`);
    this.close();
    this.#failure.resolve(error);
  }

  #reportChange(changedPath: string | null): void {
    if (changedPath === null) {
      this.#writeServiceLog(
        "The managed workspaces watcher was told of a change without its path; a write may be " +
          "missing from its chat's versions",
      );
      return;
    }
    const [sessionFolder, ...entrySegments] = changedPath.split(path.sep);
    if (entrySegments.length === 0 || entrySegments[0] === GIT_METADATA_FOLDER_NAME) {
      return;
    }
    const sessionId = SessionIdSchema.safeParse(sessionFolder);
    if (!sessionId.success) {
      this.#writeServiceLog(
        "The managed workspaces folder holds a folder named for no session; its change is not " +
          "reported",
      );
      return;
    }
    const entry = this.#readEntry(changedPath);
    if (entry === undefined) {
      this.#reportedEntries.delete(changedPath);
      return;
    }
    const kind: ManagedWorkspaceWrite["kind"] | undefined = entry.isFile()
      ? "file"
      : entry.isDirectory()
        ? "directory"
        : undefined;
    // A link is neither a file nor a folder the chat's versions can keep.
    if (kind === undefined) {
      return;
    }
    // A file's write moves its content or its modified time; a mode or owner change moves
    // neither. A folder is written once, when it is made; its own times move with every child.
    const signature =
      kind === "file"
        ? `${String(entry.ino)}:${String(entry.size)}:${String(entry.mtimeNs)}`
        : `${String(entry.ino)}:${String(entry.birthtimeNs)}`;
    if (this.#reportedEntries.get(changedPath) === signature) {
      return;
    }
    this.#reportedEntries.set(changedPath, signature);
    const write: ManagedWorkspaceWrite = {
      sessionId: sessionId.data,
      relativePath: entrySegments.join("/"),
      kind,
    };
    for (const listener of this.#listeners) {
      listener(write);
    }
  }

  // `lstat`, so a link is never followed out of the workspace. A path that is gone was removed,
  // which is no write.
  #readEntry(changedPath: string): BigIntStats | undefined {
    try {
      return lstatSync(path.join(this.#watchedDirectory, changedPath), { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        this.#writeServiceLog(
          `A managed workspace's written entry could not be read, so its write is not reported: ` +
            `${code ?? String(error)}`,
        );
      }
      return undefined;
    }
  }
}
