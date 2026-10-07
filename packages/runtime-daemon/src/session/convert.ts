// Converting a chat to a project in place. The typed folder is attached, or the machine's mount for
// it reused; the chat's files are copied in without replacing anything the repository holds; the
// session binds to the project's checkout; and `session.converted` moves its shape. The session
// keeps its id and transcript, and its managed workspace stays with its history.

import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import * as path from "node:path";

import type { Database, Statement } from "better-sqlite3";
import { fdir } from "fdir";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import {
  SESSION_CONVERT_REFUSED_CODE,
  type SessionConvertedPayload,
  type SessionConvertRequest,
  type SessionConvertResponse,
} from "@ai-sidekicks/contracts/session/convert";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import { WriteRefusedError } from "../database/writer.js";
import type { EventLogService } from "../events/log-service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { RepoMountService } from "../workspace/repo/mount-service.js";
import type { WorkspaceService } from "../workspace/service.js";
import { refuseClosedSession, type SessionChanges } from "./changes.js";

const SESSION_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// The workspace's own repository is the daemon's record of the chat, never one of its files.
const GIT_METADATA_ENTRY_NAME = ".git";

const SESSION_FACTS_SQL = "SELECT shape, state FROM sessions WHERE id = ?";

// Holds only while the session is still an open chat, inside the write that makes it a project.
const OPEN_CHAT_SQL =
  "SELECT 1 FROM sessions WHERE id = ? AND shape = 'chat' AND state <> 'closed'";

interface SessionFacts {
  readonly shape: SessionShape;
  readonly state: SessionState;
}

// What one workspace entry came to: copied, left out because the repository holds its path, or
// not a file at all (a link, a special file, or one removed since the listing).
type CopyOutcome = "copied" | "skipped" | "not_a_file";

// What a conversion has done so far, so a failure part way can say it.
interface ConversionProgress {
  copiedCount: number;
  readonly skippedPaths: string[];
  isBound: boolean;
}

/** What converting a chat reads, locks, attaches, binds and appends through. */
export interface SessionConversionDeps {
  /** The read-only connection the session's shape and state are read on. */
  readonly reader: Database;
  /** The append path `session.converted` goes through. */
  readonly events: Pick<EventLogService, "append">;
  /** The session lock every session-wide transition holds for its whole run. */
  readonly lock: Pick<SessionChanges["lock"], "run">;
  /** Attaches the typed folder, and knows where the chat's managed workspace is. */
  readonly repoMounts: Pick<RepoMountService, "attachOrReuse" | "readManagedRoot">;
  /** Binds the session to the project's checkout. */
  readonly workspaces: Pick<WorkspaceService, "bind">;
  /** The clock that stamps the event. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * A conversion that failed after the repository was attached. It names what was done: the mount,
 * how many files were copied and which were not, and whether the session was bound to the project;
 * the session still reads as a chat, since its shape did not change.
 */
class SessionConversionIncompleteError extends Error {
  readonly sessionId: SessionId;
  readonly repoMountId: RepoMountId;
  readonly copiedCount: number;
  readonly skippedPaths: readonly string[];
  readonly isBound: boolean;

  constructor(
    sessionId: SessionId,
    repoMountId: RepoMountId,
    progress: ConversionProgress,
    cause: unknown,
  ) {
    super(
      `Converting session ${sessionId} stopped part way: the repository is attached as mount ` +
        `${repoMountId}, ${progress.copiedCount} files were copied into it and ` +
        `${progress.skippedPaths.length} were not, and the session ` +
        (progress.isBound ? "was bound to it but " : "") +
        "is still a chat.",
      { cause },
    );
    this.name = new.target.name;
    this.sessionId = sessionId;
    this.repoMountId = repoMountId;
    this.copiedCount = progress.copiedCount;
    this.skippedPaths = progress.skippedPaths;
    this.isBound = progress.isBound;
  }
}

/** Turns a chat into a project in place, holding the session lock for the whole conversion. */
export class SessionConversion {
  readonly #events: Pick<EventLogService, "append">;
  readonly #lock: Pick<SessionChanges["lock"], "run">;
  readonly #repoMounts: Pick<RepoMountService, "attachOrReuse" | "readManagedRoot">;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #now: () => Date;
  readonly #selectFacts: Statement<[string], SessionFacts>;

  constructor(deps: SessionConversionDeps) {
    this.#events = deps.events;
    this.#lock = deps.lock;
    this.#repoMounts = deps.repoMounts;
    this.#workspaces = deps.workspaces;
    this.#now = deps.now ?? (() => new Date());
    this.#selectFacts = deps.reader.prepare(SESSION_FACTS_SQL);
  }

  /**
   * Converts the chat into the repository at `request.path` and answers what was and was not
   * copied. Refuses a session that is not a chat (`session.convert_refused`) or is closed
   * (`session.already_closed`), and a folder the attach refuses (`repo.root_resolution_failed`,
   * `repo.already_attached` for a chat's own workspace), each before anything is copied. A failure
   * after the attach throws an error naming what was done.
   */
  async convert(request: SessionConvertRequest): Promise<SessionConvertResponse> {
    const { sessionId } = request;
    return this.#lock.run(sessionId, async () => {
      this.#refuseUnlessOpenChat(sessionId);
      const workspaceRoot = this.#repoMounts.readManagedRoot(sessionId);
      if (workspaceRoot === undefined) {
        throw new Error(`Chat ${sessionId} has no managed workspace to convert`);
      }
      const project = await this.#repoMounts.attachOrReuse({ localPath: request.path });
      const progress: ConversionProgress = { copiedCount: 0, skippedPaths: [], isBound: false };
      try {
        await copyWorkspaceFiles(workspaceRoot, project.canonicalRoot, progress);
        await this.#workspaces.bind({
          sessionId,
          repoMountId: project.repoMountId,
          executionMode: "bound-root",
        });
        progress.isBound = true;
        await this.#appendConverted({
          sessionId,
          repoMountId: project.repoMountId,
          copiedCount: progress.copiedCount,
          skippedPaths: progress.skippedPaths,
        });
      } catch (error) {
        throw new SessionConversionIncompleteError(sessionId, project.repoMountId, progress, error);
      }
      return { copiedCount: progress.copiedCount, skippedPaths: progress.skippedPaths };
    });
  }

  #refuseUnlessOpenChat(sessionId: SessionId): void {
    const facts = this.#selectFacts.get(sessionId);
    if (facts === undefined) {
      throw new SessionNotFoundError("This daemon holds no such session.", { sessionId });
    }
    refuseClosedSession(sessionId, facts.state);
    if (facts.shape !== "chat") {
      throw new DaemonDomainError("Only a chat converts to a project.", {
        code: SESSION_CONVERT_REFUSED_CODE,
        detail: { sessionId },
      });
    }
  }

  async #appendConverted(payload: SessionConvertedPayload): Promise<void> {
    try {
      await this.#events.append(
        {
          id: mintUuidV7(),
          sessionId: payload.sessionId,
          occurredAt: this.#now().toISOString(),
          category: "session_lifecycle",
          type: "session.converted",
          actor: null,
          payload: { ...payload },
          version: SESSION_EVENT_VERSION,
        },
        {
          transactionalPrelude: [
            { sql: OPEN_CHAT_SQL, bindings: [payload.sessionId], expectedRowCount: 1 },
          ],
        },
      );
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === 0) {
        throw new Error(
          `Session ${payload.sessionId} stopped being an open chat while converting`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }
}

// Copies each of the workspace's files into the project one at a time, recording each outcome as
// it lands. Paths are relative to the workspace, `/`-separated, in name order.
async function copyWorkspaceFiles(
  workspaceRoot: string,
  projectRoot: string,
  progress: ConversionProgress,
): Promise<void> {
  for (const relativePath of await listWorkspaceEntries(workspaceRoot, projectRoot)) {
    const outcome = await copyWorkspaceEntry(workspaceRoot, projectRoot, relativePath);
    if (outcome === "copied") {
      progress.copiedCount += 1;
    } else if (outcome === "skipped") {
      progress.skippedPaths.push(relativePath);
    }
  }
}

// The listing never descends through a link, so nothing outside the workspace is listed; a link
// itself is listed and left to the copy to refuse. The project's own folder is left out when it
// sits inside the workspace, so the repository is never copied into itself.
async function listWorkspaceEntries(workspaceRoot: string, projectRoot: string): Promise<string[]> {
  const entries = await new fdir()
    .withRelativePaths()
    .withPathSeparator("/")
    .withErrors()
    .exclude(
      (directoryName, directoryPath) =>
        directoryName === GIT_METADATA_ENTRY_NAME || path.resolve(directoryPath) === projectRoot,
    )
    .filter((entryPath) => path.posix.basename(entryPath) !== GIT_METADATA_ENTRY_NAME)
    .crawl(workspaceRoot)
    .withPromise();
  return entries.sort();
}

// Copies one regular file, never replacing anything: a path the repository already holds, or one
// under a link or a file in the repository, is skipped, and the exclusive copy refuses a file that
// appears at the last moment. A link in the workspace is never followed and never copied.
async function copyWorkspaceEntry(
  workspaceRoot: string,
  projectRoot: string,
  relativePath: string,
): Promise<CopyOutcome> {
  const source = path.join(workspaceRoot, relativePath);
  try {
    if (!(await lstat(source)).isFile()) {
      return "not_a_file";
    }
  } catch (error) {
    // The chat's agent may remove a file while the conversion runs; nothing of it is left to copy.
    if (errnoOf(error) === "ENOENT") {
      return "not_a_file";
    }
    throw error;
  }
  let folder = projectRoot;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    folder = path.join(folder, segment);
    if (!(await holdsOwnFolder(folder))) {
      return "skipped";
    }
  }
  try {
    await copyFile(source, path.join(projectRoot, relativePath), fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") {
      return "skipped";
    }
    throw error;
  }
  return "copied";
}

// Whether `folder` is a real folder of the repository, made when missing. A link or a file there
// means the repository holds that path, and a link is never written through.
async function holdsOwnFolder(folder: string): Promise<boolean> {
  try {
    return (await lstat(folder)).isDirectory();
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    await mkdir(folder);
    return true;
  } catch (error) {
    if (errnoOf(error) === "EEXIST") {
      return (await lstat(folder)).isDirectory();
    }
    throw error;
  }
}

function errnoOf(error: unknown): unknown {
  return (error as { readonly code?: unknown } | null)?.code;
}
