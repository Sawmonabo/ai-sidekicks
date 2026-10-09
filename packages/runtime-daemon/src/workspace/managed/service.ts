// A chat's managed workspace: the git-initialized folder `<home>/.ai-sidekicks/workspaces/<session
// id>` the daemon makes at the chat's create and registers as the chat's managed mount, kept while
// the chat is archived, and deleted whole when the chat is purged, or when its create stopped
// before the chat was born.

import { realpath } from "node:fs/promises";
import * as path from "node:path";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DEFAULT_GIT_FILESYSTEM } from "../../git/filesystem.js";
import { runGitWithExecFile, type GitRunner } from "../../git/process.js";
import type { RepoMountService } from "../repo/mount-service.js";

const MANAGED_WORKSPACES_FOLDER_NAME = "workspaces";

// `git init` writes a handful of files; a slow disk still finishes well inside this.
const GIT_INIT_TIMEOUT_MS = 10_000;

/** The folder holding every chat's managed workspace, one subfolder per session id. */
export function managedWorkspacesDirectoryOf(homeDirectory: string): string {
  return path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, MANAGED_WORKSPACES_FOLDER_NAME);
}

/** A chat's managed workspace as its create made it. */
export interface ManagedWorkspace {
  readonly repoMountId: RepoMountId;
  /** The workspace folder, absolute and symlink-resolved: the mount's canonical root. */
  readonly path: string;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface ManagedWorkspaceServiceDeps {
  /** The person's home folder; the workspaces sit in the daemon's data folder inside it. */
  readonly homeDirectory: string;
  /** The one writer of mount rows. */
  readonly repoMounts: Pick<RepoMountService, "attachManaged" | "deleteManaged">;
  /** Defaults to the daemon's shared `execFile` runner. */
  readonly git?: GitRunner;
}

/** Makes and deletes chats' managed workspaces, each with its managed mount row. */
export class ManagedWorkspaceService {
  readonly #workspacesDirectory: string;
  readonly #repoMounts: Pick<RepoMountService, "attachManaged" | "deleteManaged">;
  readonly #git: GitRunner;

  constructor(deps: ManagedWorkspaceServiceDeps) {
    this.#workspacesDirectory = managedWorkspacesDirectoryOf(deps.homeDirectory);
    this.#repoMounts = deps.repoMounts;
    this.#git = deps.git ?? runGitWithExecFile;
  }

  /**
   * Makes the chat's workspace folder, initializes it as a git repository and registers it as the
   * chat's managed mount. Throws `RepoAlreadyAttachedError` when the session already has one,
   * before touching any folder; a failure after the mount row is written removes the folder and
   * the row, and throws an `AggregateError` when that removal fails too.
   */
  async create(input: { readonly sessionId: SessionId }): Promise<ManagedWorkspace> {
    await DEFAULT_GIT_FILESYSTEM.createDirectory(this.#workspacesDirectory);
    // Every mount root is symlink-resolved; the session id below it adds no link.
    const workspacePath = path.join(await realpath(this.#workspacesDirectory), input.sessionId);
    // The row first: its unique index refuses a second create before the first's folder is touched.
    const repoMountId = await this.#repoMounts.attachManaged({
      sessionId: input.sessionId,
      canonicalRoot: workspacePath,
    });
    try {
      await DEFAULT_GIT_FILESYSTEM.createDirectory(workspacePath);
      await this.#initializeRepository(workspacePath);
    } catch (creationError) {
      try {
        await this.#remove(input.sessionId, workspacePath);
      } catch (removalError) {
        throw new AggregateError(
          [creationError, removalError],
          "Making a chat's managed workspace failed, and removing what it had made failed too",
          { cause: removalError },
        );
      }
      throw creationError;
    }
    return { repoMountId, path: workspacePath };
  }

  /**
   * Deletes the chat's workspace folder whole, then its mount row and every row on it. A session
   * with no managed workspace changes nothing, so a repeat is safe.
   */
  async delete(input: { readonly sessionId: SessionId }): Promise<void> {
    await this.#remove(input.sessionId, this.#workspacePathOf(input.sessionId));
  }

  /**
   * Deletes the chat's workspace folder whole and leaves its rows, for a caller that deletes them
   * in its own write. A session with no managed workspace changes nothing, so a repeat is safe.
   */
  async deleteFolder(input: { readonly sessionId: SessionId }): Promise<void> {
    await DEFAULT_GIT_FILESYSTEM.removePath(this.#workspacePathOf(input.sessionId));
  }

  // Built from the session id under the daemon's own folder, never read from a row, so a removal
  // can reach nothing but a chat's workspace.
  #workspacePathOf(sessionId: SessionId): string {
    return path.join(this.#workspacesDirectory, sessionId);
  }

  // The folder before the rows: a removal that fails leaves the row naming what is still on disk.
  async #remove(sessionId: SessionId, workspacePath: string): Promise<void> {
    await DEFAULT_GIT_FILESYSTEM.removePath(workspacePath);
    await this.#repoMounts.deleteManaged(sessionId);
  }

  // `--template` outranks `GIT_TEMPLATE_DIR` and `init.templateDir`, and git copies no template
  // when its value is empty, so the person's template hooks stay out of the chat's repository.
  async #initializeRepository(workspacePath: string): Promise<void> {
    await this.#git(["-C", workspacePath, "init", "--quiet", "--template="], {
      timeoutMs: GIT_INIT_TIMEOUT_MS,
    });
  }
}
