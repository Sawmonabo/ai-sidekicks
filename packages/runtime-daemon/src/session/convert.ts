// Converting a chat to a project in place. The typed folder is attached as a project, or the
// project already holding it found, and the conversion recorded under the request's idempotency
// key; the chat's files are copied into the working tree the typed folder sits in without
// replacing anything the repository holds, each outcome recorded as it lands; the session binds
// to that working tree; and `session.converted` moves its shape. Each file is written under a name
// of the daemon's own and published under its real name once whole, so a stop part way never
// leaves half a file under a name the repository's files use. A conversion that stopped part way
// resumes from its records, and the files not copied are read page by page. The session keeps its
// id and transcript, and its managed workspace stays with its history.

import { constants as fsConstants, type Dirent } from "node:fs";
import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

import type { Database, Statement } from "better-sqlite3";

import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";

import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import {
  SESSION_CONVERT_INCOMPLETE_CODE,
  SESSION_CONVERT_REFUSED_CODE,
  SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX,
  SessionConvertedPayloadSchema,
  type SessionConvertedPayload,
  type SessionConvertRequest,
  type SessionConvertResponse,
  type SessionConvertSkippedFile,
  type SessionConvertSkippedFileCursor,
  type SessionConvertSkippedFileListRequest,
  type SessionConvertSkippedFileListResponse,
  type SessionConvertSkipReason,
} from "@ai-sidekicks/contracts/session/convert";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import type { EventLogService } from "../events/log-service.js";
import { publishWithoutReplacing } from "../file/publish-without-replacing.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { KeyedLock } from "../keyed-lock.js";
import type { ProjectAttachment, ProjectService } from "../workspace/project/service.js";
import { RepoRootResolutionError } from "../workspace/repo/errors.js";
import type { RepoMountService } from "../workspace/repo/mount-service.js";
import type { WorkingTreeReader } from "../workspace/repo/root-resolver.js";
import type { WorkspaceService } from "../workspace/service.js";
import {
  refuseProvisioningSession,
  refuseUnchangeableSession,
  type SessionChanges,
} from "./changes.js";
import { SESSION_EXISTS_SQL } from "./directory/lookups.js";
import { sessionLifecycleEvent } from "./lifecycle-event.js";
import { sessionNotFound } from "./not-found.js";
import { describeRejection } from "../rejection.js";

// The workspace's own repository is the daemon's record of the chat, never one of its files.
const GIT_METADATA_ENTRY_NAME = ".git";

// A file is written under this name, the session's id after it, in the folder it lands in, and
// published under its own name once whole. Nothing but the session's conversion makes a file so
// named.
const COPY_IN_PROGRESS_NAME_PREFIX = ".ai-sidekicks-copy-";

const SESSION_FACTS_SQL = "SELECT shape, state FROM sessions WHERE id = ?";

// Holds only while the session is still a chat that takes changes, inside the write that makes it
// a project.
const OPEN_CHAT_SQL = `SELECT 1 FROM sessions
  WHERE id = ? AND shape = 'chat' AND state NOT IN ('closed', 'purge_requested')`;

const RECORD_CONVERSION_SQL = `INSERT INTO session_convert_requests
  (client_idempotency_key, session_id, repo_mount_id, working_tree) VALUES (?, ?, ?, ?)`;

// The request resuming a conversion takes it over: its key answers the conversion from here on, on
// the mount the folder is attached as now.
const TAKE_OVER_CONVERSION_SQL = `UPDATE session_convert_requests
  SET client_idempotency_key = ?, repo_mount_id = ? WHERE session_id = ?`;

const RECORD_FILE_SQL = `INSERT INTO session_convert_files (session_id, path, outcome)
  VALUES (?, ?, ?)`;

// The conversion this key runs under, of whichever session, with its event once that has landed.
const CONVERSION_BY_KEY_SQL = `SELECT request.session_id AS sessionId, event.payload
  FROM session_convert_requests AS request
  LEFT JOIN session_events AS event
    ON event.session_id = request.session_id AND event.type = 'session.converted'
 WHERE request.client_idempotency_key = ?`;

// Every chat's conversion that has not landed its `session.converted`, with the working tree it
// copies into.
const UNFINISHED_CONVERSIONS_SQL = `SELECT request.session_id AS sessionId,
       request.working_tree AS workingTree
  FROM session_convert_requests AS request
 WHERE NOT EXISTS (SELECT 1 FROM session_events AS event
                    WHERE event.session_id = request.session_id
                      AND event.type = 'session.converted')`;

// A chat's conversion that stopped part way, with the working tree it copies into.
const UNFINISHED_CONVERSION_SQL = `SELECT client_idempotency_key AS clientIdempotencyKey,
       repo_mount_id AS repoMountId, working_tree AS workingTree
  FROM session_convert_requests
 WHERE session_id = ?`;

const FILES_DEALT_WITH_SQL = "SELECT path FROM session_convert_files WHERE session_id = ?";

const FILE_COUNTS_SQL = `SELECT count(*) FILTER (WHERE outcome = 'copied') AS copiedCount,
       count(*) FILTER (WHERE outcome <> 'copied') AS skippedCount
  FROM session_convert_files WHERE session_id = ?`;

// One row past the page shows whether more remain; the first page reads after the empty path,
// which sorts before every path.
const SKIPPED_FILES_PAGE_SQL = `SELECT path, outcome AS reason FROM session_convert_files
  WHERE session_id = @sessionId AND path > @afterPath AND outcome <> 'copied'
  ORDER BY path
  LIMIT @rowCount`;

// Every open names its last component exactly: a link there refuses the open instead of being
// followed. A pipe swapped in opens without waiting for a writer, and is then refused as no file.
const OPEN_SOURCE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const CREATE_COPY_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const OPEN_FOLDER_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

// One read of a file being copied, the size a Node file stream reads at a time.
const COPY_CHUNK_BYTES = 64 * 1024;

// The most file records waiting on their commit while the copy goes on: enough to keep the
// writer's batches full, and the most landed copies a crash can leave unrecorded.
const RECORDS_IN_FLIGHT_MAX = 100;

interface SessionFacts {
  readonly shape: SessionShape;
  readonly state: SessionState;
}

// What one workspace entry came to: copied, left out for a reason, or gone (removed since the
// listing, so nothing of it is left to copy or to lose).
type CopyOutcome =
  | { readonly kind: "copied" }
  | { readonly kind: "skipped"; readonly reason: SessionConvertSkipReason }
  | { readonly kind: "gone" };

// How a recorded file came out: copied, or not copied for a reason.
type RecordedOutcome = "copied" | SessionConvertSkipReason;

// What a conversion has done so far, so a failure part way can say it.
interface ConversionProgress extends SessionConvertResponse {
  readonly isBound: boolean;
}

// The folders one conversion copies between, and the session whose copies they hold.
interface ConversionFolders {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly workingTree: string;
}

// A chat's conversion that stopped part way.
interface UnfinishedConversion {
  readonly clientIdempotencyKey: string;
  readonly repoMountId: RepoMountId;
  readonly workingTree: string;
}

/** What converting a chat reads, locks, attaches, binds and appends through. */
export interface SessionConversionDeps {
  /** The read-only connection the session's facts and its conversion's records are read on. */
  readonly reader: Database;
  /** The writer the conversion and each file's outcome are recorded through. */
  readonly writer: Pick<DatabaseWriter, "write">;
  /** The append path `session.converted` goes through. */
  readonly events: Pick<EventLogService, "append">;
  /** The session lock every session-wide transition holds for its whole run. */
  readonly lock: Pick<SessionChanges["lock"], "run">;
  /** Resolves the typed folder, and knows where the chat's managed workspace is. */
  readonly repoMounts: Pick<RepoMountService, "readManagedRoot" | "resolveFolder">;
  /** Attaches the typed folder as a project, or finds the project already holding it. */
  readonly projects: Pick<ProjectService, "attachOrFind">;
  /** Binds the session to the working tree its files were copied into. */
  readonly workspaces: Pick<WorkspaceService, "bind">;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
  /** Reads the working tree the typed path sits in, as git resolves it. */
  readonly workingTrees: Pick<WorkingTreeReader, "readWorkingTreeRoot">;
  /** The clock that stamps the event. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * A conversion that failed after the repository was attached, as `session.convert_incomplete`
 * naming what was done: the mount, how many files were copied and not, and whether the session
 * was bound to the project. The session still reads as a chat, since its shape did not change.
 */
class SessionConversionIncompleteError extends DaemonDomainError {
  constructor(
    sessionId: SessionId,
    repoMountId: RepoMountId,
    progress: ConversionProgress,
    cause: unknown,
  ) {
    super(
      `Converting session ${sessionId} stopped part way: the repository is attached as mount ` +
        `${repoMountId}, ${String(progress.copiedCount)} files were copied into it and ` +
        `${String(progress.skippedCount)} were not, and the session ` +
        (progress.isBound ? "was bound to it but " : "") +
        "is still a chat.",
      {
        code: SESSION_CONVERT_INCOMPLETE_CODE,
        detail: {
          sessionId,
          repoMountId,
          copiedCount: progress.copiedCount,
          skippedCount: progress.skippedCount,
          isBound: progress.isBound,
        },
      },
    );
    this.cause = cause;
  }
}

/**
 * Turns a chat into a project in place, holding its idempotency key's lock and then the session
 * lock for the whole conversion, and reads back the files a conversion did not copy.
 */
export class SessionConversion {
  readonly #reader: Database;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #events: Pick<EventLogService, "append">;
  readonly #lock: Pick<SessionChanges["lock"], "run">;
  // Serializes converts that carry one key across sessions, so a second session sees the first's
  // conversion and is refused before it attaches anything. Always taken before the session lock.
  readonly #keyLock = new KeyedLock<string>();
  readonly #repoMounts: Pick<RepoMountService, "readManagedRoot" | "resolveFolder">;
  readonly #projects: Pick<ProjectService, "attachOrFind">;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #writeServiceLog: (line: string) => void;
  readonly #workingTrees: SessionConversionDeps["workingTrees"];
  readonly #now: () => Date;
  readonly #selectFacts: Statement<[string], SessionFacts>;
  readonly #selectConversionByKey: Statement<
    [string],
    { readonly sessionId: string; readonly payload: string | null }
  >;
  readonly #selectUnfinishedConversion: Statement<[string], UnfinishedConversion>;
  readonly #selectUnfinishedConversions: Statement<
    [],
    { readonly sessionId: SessionId; readonly workingTree: string }
  >;
  readonly #selectFilesDealtWith: Statement<[string], { readonly path: string }>;
  readonly #selectFileCounts: Statement<[string], SessionConvertResponse>;
  readonly #selectSessionExists: Statement<{ sessionId: string }>;
  readonly #selectSkippedFilesPage: Statement<
    [{ sessionId: string; afterPath: string; rowCount: number }],
    SessionConvertSkippedFile
  >;

  constructor(deps: SessionConversionDeps) {
    this.#reader = deps.reader;
    this.#writer = deps.writer;
    this.#events = deps.events;
    this.#lock = deps.lock;
    this.#repoMounts = deps.repoMounts;
    this.#projects = deps.projects;
    this.#workspaces = deps.workspaces;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#workingTrees = deps.workingTrees;
    this.#now = deps.now ?? (() => new Date());
    this.#selectFacts = deps.reader.prepare(SESSION_FACTS_SQL);
    this.#selectConversionByKey = deps.reader.prepare(CONVERSION_BY_KEY_SQL);
    this.#selectUnfinishedConversion = deps.reader.prepare(UNFINISHED_CONVERSION_SQL);
    this.#selectUnfinishedConversions = deps.reader.prepare(UNFINISHED_CONVERSIONS_SQL);
    this.#selectFilesDealtWith = deps.reader.prepare(FILES_DEALT_WITH_SQL);
    this.#selectFileCounts = deps.reader.prepare(FILE_COUNTS_SQL);
    this.#selectSessionExists = deps.reader.prepare(SESSION_EXISTS_SQL);
    this.#selectSkippedFilesPage = deps.reader.prepare(SKIPPED_FILES_PAGE_SQL);
  }

  /**
   * Converts the chat into the repository at `request.path` and answers what was and was not
   * copied. A request whose `clientIdempotencyKey` already converted this session answers that
   * conversion's counts and copies nothing. A conversion that stopped part way resumes, under the
   * request's key whichever key started it, when the path names the folder it copies into: files
   * it already dealt with are not copied again, and the counts are the whole conversion's. Refuses,
   * each before anything is attached or copied, a key another session's conversion holds
   * (`reason: idempotency_key_reused`), a path naming another folder than a stopped conversion's
   * (`reason: conversion_unfinished`, with that conversion's `repoMountId`), a session that is not
   * a chat, or a chat with no managed workspace (`session.convert_refused`); a closed chat
   * (`session.already_closed`), and one still provisioning or being purged
   * (`session.change_refused`); and a folder the attach refuses
   * (`repo.root_resolution_failed`, `repo.already_attached` for a chat's own workspace). A failure
   * after the attach throws `session.convert_incomplete` naming what was done, every landed copy
   * counted. A known limit: the few files whose copies landed while their records were still on
   * their way when the daemon stopped read as `repository_has_file` when the conversion resumes.
   */
  async convert(request: SessionConvertRequest): Promise<SessionConvertResponse> {
    const { sessionId, clientIdempotencyKey } = request;
    return this.#keyLock.run(clientIdempotencyKey, () =>
      this.#lock.run(sessionId, () => this.#convertHeld(request)),
    );
  }

  async #convertHeld(request: SessionConvertRequest): Promise<SessionConvertResponse> {
    const { sessionId } = request;
    const keyed = this.#selectConversionByKey.get(request.clientIdempotencyKey);
    if (keyed !== undefined && keyed.sessionId !== sessionId) {
      throw new DaemonDomainError("This idempotency key belongs to another session's conversion.", {
        code: SESSION_CONVERT_REFUSED_CODE,
        detail: { sessionId, reason: "idempotency_key_reused" },
      });
    }
    if (keyed !== undefined && keyed.payload !== null) {
      const { copiedCount, skippedCount } = SessionConvertedPayloadSchema.parse(
        JSON.parse(keyed.payload),
      );
      return { copiedCount, skippedCount };
    }
    this.#refuseUnlessOpenChat(sessionId);
    const workspaceRoot = this.#repoMounts.readManagedRoot(sessionId);
    if (workspaceRoot === undefined) {
      throw new DaemonDomainError("The chat has no managed workspace to convert.", {
        code: SESSION_CONVERT_REFUSED_CODE,
        detail: { sessionId, reason: "no_managed_workspace" },
      });
    }
    const { project, record } = await this.#attachProject(request);
    let isBound = false;
    try {
      // The files go into the working tree of the path typed, and the session binds there, never
      // into another checkout of the repository.
      const workingTree = await this.#workingTreeOf(request.path);
      await this.#writer.write([record(workingTree)]);
      await copyWorkspaceFiles(
        { sessionId, workspaceRoot, workingTree },
        this.#filesDealtWith(sessionId),
        (path, outcome) =>
          this.#writer.write([{ sql: RECORD_FILE_SQL, bindings: [sessionId, path, outcome] }]),
      );
      await this.#workspaces.bind({
        sessionId,
        repoMountId: project.repoMountId,
        executionMode: "bound-root",
        directory: workingTree,
      });
      isBound = true;
      const outcome = this.#fileCountsOf(sessionId);
      await this.#appendConverted({ sessionId, repoMountId: project.repoMountId, ...outcome });
      return outcome;
    } catch (error) {
      throw new SessionConversionIncompleteError(
        sessionId,
        project.repoMountId,
        { ...this.#fileCountsOf(sessionId), isBound },
        error,
      );
    }
  }

  // The project the conversion copies into, and the statement recording the conversion under the
  // request's key with the working tree it copies into. A conversion that stopped part way goes on
  // only into its own working tree, taken over by this request's key on the mount its repository is
  // attached as now, attached again if a detach let it go since.
  async #attachProject(request: SessionConvertRequest): Promise<{
    readonly project: ProjectAttachment;
    readonly record: (workingTree: string) => WriteStatement;
  }> {
    const { sessionId, clientIdempotencyKey } = request;
    const unfinished = this.#selectUnfinishedConversion.get(sessionId);
    if (unfinished === undefined) {
      const project = await this.#projects.attachOrFind({ localPath: request.path });
      return {
        project,
        record: (workingTree) => ({
          sql: RECORD_CONVERSION_SQL,
          bindings: [clientIdempotencyKey, sessionId, project.repoMountId, workingTree],
        }),
      };
    }
    // Resolved as attach resolves it first, so a path that is no repository is refused as attach
    // refuses it.
    await this.#repoMounts.resolveFolder({ localPath: request.path });
    if ((await this.#workingTreeOf(request.path)) !== unfinished.workingTree) {
      throw new DaemonDomainError("The chat's conversion into another folder stopped part way.", {
        code: SESSION_CONVERT_REFUSED_CODE,
        detail: { sessionId, reason: "conversion_unfinished", repoMountId: unfinished.repoMountId },
      });
    }
    const project = await this.#projects.attachOrFind({ localPath: request.path });
    return {
      project,
      record: () => ({
        sql: TAKE_OVER_CONVERSION_SQL,
        bindings: [clientIdempotencyKey, project.repoMountId, sessionId],
        expectedRowCount: 1,
      }),
    };
  }

  async #workingTreeOf(folderPath: string): Promise<string> {
    const workingTree = await this.#workingTrees.readWorkingTreeRoot(folderPath);
    if (workingTree === null) {
      throw new RepoRootResolutionError("not_a_repository");
    }
    return workingTree;
  }

  /**
   * Removes the file each conversion the daemon stopped part way was writing, which sits in the
   * repository under the daemon's own name for it, never under a name the repository's files use.
   * Run at the daemon's start; each conversion is held under its session lock meanwhile, and one
   * whose removal fails is named in the service log, the others' removals going on.
   */
  async removeStoppedCopies(): Promise<void> {
    for (const { sessionId, workingTree } of this.#selectUnfinishedConversions.all()) {
      try {
        await this.#lock.run(sessionId, async () => {
          const workspaceRoot = this.#repoMounts.readManagedRoot(sessionId);
          if (workspaceRoot !== undefined) {
            const folders = { sessionId, workspaceRoot, workingTree };
            await removeStoppedCopy(
              folders,
              await listPendingEntries(folders, this.#filesDealtWith(sessionId)),
            );
          }
        });
      } catch (error) {
        this.#writeServiceLog(
          `Removing the copy session ${sessionId}'s stopped conversion left failed: ` +
            `${describeRejection(error)}`,
        );
      }
    }
  }

  #filesDealtWith(sessionId: SessionId): ReadonlySet<string> {
    return new Set(this.#selectFilesDealtWith.all(sessionId).map((row) => row.path));
  }

  // A count with no GROUP BY answers exactly one row.
  #fileCountsOf(sessionId: SessionId): SessionConvertResponse {
    return this.#selectFileCounts.get(sessionId) as SessionConvertResponse;
  }

  /**
   * One page of the files the session's conversion did not copy, in path order, each with its
   * reason. A session never converted, or one whose conversion copied every file, answers an
   * empty last page. Throws `session.not_found` for a session this daemon holds no row for.
   */
  listSkippedFiles(
    request: SessionConvertSkippedFileListRequest,
  ): SessionConvertSkippedFileListResponse {
    const limit = request.limit ?? SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX;
    const { exists, rows } = this.#reader.transaction(() => ({
      exists: this.#selectSessionExists.get({ sessionId: request.sessionId }) !== undefined,
      rows: this.#selectSkippedFilesPage.all({
        sessionId: request.sessionId,
        afterPath: request.afterCursor === undefined ? "" : skippedFilePathOf(request.afterCursor),
        rowCount: limit + 1,
      }),
    }))();
    if (!exists) {
      throw sessionNotFound(request.sessionId);
    }
    // A page stops at whichever of the limit and the page budget trips first.
    const files = rows.slice(0, countEntriesFittingOneFrame(rows, limit));
    const [firstFile, ...laterFiles] = files;
    if (firstFile === undefined || files.length === rows.length) {
      return { files, hasMore: false };
    }
    return {
      files: [firstFile, ...laterFiles],
      hasMore: true,
      nextCursor: skippedFileCursorOf((laterFiles.at(-1) ?? firstFile).path),
    };
  }

  #refuseUnlessOpenChat(sessionId: SessionId): void {
    const facts = this.#selectFacts.get(sessionId);
    if (facts === undefined) {
      throw sessionNotFound(sessionId);
    }
    refuseUnchangeableSession(sessionId, facts.state);
    refuseProvisioningSession(sessionId, facts.state);
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
        sessionLifecycleEvent({
          sessionId: payload.sessionId,
          type: "session.converted",
          payload: { ...payload },
          occurredAt: this.#now(),
        }),
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

// The cursor names the last path a page carried, encoded so a client reads nothing into it.
function skippedFileCursorOf(path: string): SessionConvertSkippedFileCursor {
  return Buffer.from(path, "utf8").toString("base64url") as SessionConvertSkippedFileCursor;
}

// Any cursor decodes to some path, and a page simply starts after it.
function skippedFilePathOf(cursor: SessionConvertSkippedFileCursor): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

// Copies each of the workspace's files the conversion has not yet dealt with into the project, one
// at a time, recording each outcome as it lands, every file not copied with its reason, once the
// file a stop part way was writing is removed. The copy goes on while records commit, so the
// writer folds many into one batch; at most RECORDS_IN_FLIGHT_MAX wait at once, and every one has
// committed before this settles, either way, so a stop inside the daemon still counts each landed
// copy. A failed record stops the copy.
async function copyWorkspaceFiles(
  folders: ConversionFolders,
  dealtWith: ReadonlySet<string>,
  record: (relativePath: string, outcome: RecordedOutcome) => Promise<unknown>,
): Promise<void> {
  const pending = await listPendingEntries(folders, dealtWith);
  await removeStoppedCopy(folders, pending);
  const copyName = copyNameOf(folders.sessionId);
  const commits: Promise<void>[] = [];
  // A failing writer fails every write after with the same reason, so the first one says it.
  let recordFailure: { readonly error: unknown } | undefined;
  const recordLanded = async (relativePath: string, outcome: RecordedOutcome): Promise<void> => {
    commits.push(
      record(relativePath, outcome).then(
        () => undefined,
        (error: unknown) => {
          recordFailure ??= { error };
        },
      ),
    );
    if (commits.length >= RECORDS_IN_FLIGHT_MAX) {
      await commits.shift();
    }
  };
  try {
    for (const relativePath of pending) {
      if (recordFailure !== undefined) {
        break;
      }
      const outcome = await copyWorkspaceEntry(folders, relativePath, copyName);
      if (outcome.kind === "copied") {
        await recordLanded(relativePath, "copied");
      } else if (outcome.kind === "skipped") {
        await recordLanded(relativePath, outcome.reason);
      }
    }
  } finally {
    await Promise.all(commits);
  }
  if (recordFailure !== undefined) {
    throw recordFailure.error;
  }
}

// The workspace's files, in name order, that the conversion has yet to deal with.
async function listPendingEntries(
  folders: ConversionFolders,
  dealtWith: ReadonlySet<string>,
): Promise<string[]> {
  return (await listWorkspaceEntries(folders.workspaceRoot, folders.workingTree)).filter(
    (relativePath) => !dealtWith.has(relativePath),
  );
}

// Removes the file a conversion that stopped part way was writing under the daemon's name. Its
// copy never got a record, so it sits in the folder of one of the `pending` files.
async function removeStoppedCopy(
  folders: ConversionFolders,
  pending: readonly string[],
): Promise<void> {
  const copyName = copyNameOf(folders.sessionId);
  for (const folder of new Set(pending.map((relativePath) => path.posix.dirname(relativePath)))) {
    try {
      await unlink(path.join(folders.workingTree, folder, copyName));
    } catch (error) {
      const code = errnoOf(error);
      // Nothing was left there, or the repository holds no folder there to have held it.
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
  }
}

function copyNameOf(sessionId: SessionId): string {
  return `${COPY_IN_PROGRESS_NAME_PREFIX}${sessionId}`;
}

// Every entry of the workspace but its folders, `/`-separated, in name order: files, links and
// special files alike, each left to the copy to tell apart on the opened entry. The walk never
// descends through a link, so nothing outside the workspace is listed, and it leaves out the
// workspace's own repository at its root and the working tree when that sits inside the
// workspace, so the repository is never copied into itself; a repository in a subfolder is the
// chat's files like any other. A folder removed while the walk runs holds nothing.
async function listWorkspaceEntries(workspaceRoot: string, workingTree: string): Promise<string[]> {
  const entries: string[] = [];
  const pendingFolders: string[] = [""];
  for (let folder = pendingFolders.pop(); folder !== undefined; folder = pendingFolders.pop()) {
    for (const dirent of await readFolder(path.join(workspaceRoot, folder))) {
      if (folder === "" && dirent.name === GIT_METADATA_ENTRY_NAME) {
        continue;
      }
      const relativePath = folder === "" ? dirent.name : `${folder}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (path.join(workspaceRoot, relativePath) !== workingTree) {
          pendingFolders.push(relativePath);
        }
      } else {
        entries.push(relativePath);
      }
    }
  }
  return entries.sort();
}

async function readFolder(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

// Copies one regular file, never replacing anything and never following a link: the source is
// opened without following its last component and checked a regular file on the opened handle, so
// a link or a special file is refused even when it was swapped in after the listing, and the copy
// is published under the target's name without replacing, so a path the repository already holds,
// a link there included, is skipped.
async function copyWorkspaceEntry(
  folders: ConversionFolders,
  relativePath: string,
  copyName: string,
): Promise<CopyOutcome> {
  const opened = await openSourceFile(path.join(folders.workspaceRoot, relativePath));
  if (opened.kind !== "opened") {
    return opened;
  }
  try {
    let folder = folders.workingTree;
    for (const segment of relativePath.split("/").slice(0, -1)) {
      folder = path.join(folder, segment);
      if (!(await holdsOwnFolder(folder))) {
        return { kind: "skipped", reason: "repository_path_not_a_folder" };
      }
    }
    return await copyOpenedFile(
      opened.handle,
      path.join(folders.workingTree, relativePath),
      path.join(folder, copyName),
    );
  } finally {
    await opened.handle.close();
  }
}

async function openSourceFile(
  source: string,
): Promise<Exclude<CopyOutcome, { kind: "copied" }> | { kind: "opened"; handle: FileHandle }> {
  let handle: FileHandle;
  try {
    handle = await open(source, OPEN_SOURCE_FLAGS);
  } catch (error) {
    const code = errnoOf(error);
    // The chat's agent keeps working while the conversion runs, so the file may be gone or swapped.
    if (code === "ENOENT") {
      return { kind: "gone" };
    }
    if (code === "ELOOP") {
      return { kind: "skipped", reason: "link" };
    }
    // A socket refuses an open: ENXIO on Linux, EOPNOTSUPP on macOS.
    if (code === "ENXIO" || code === "EOPNOTSUPP") {
      return { kind: "skipped", reason: "special_file" };
    }
    throw error;
  }
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    return { kind: "skipped", reason: "special_file" };
  }
  return { kind: "opened", handle };
}

// Writes the opened source, with its permission bits, to a file created at `copyPath` beside the
// target, then publishes it under the target's name, which never replaces a file the repository
// holds, and removes `copyPath` either way. A failure removes it too, so the repository is left
// with no part of the file; a stop part way leaves it under `copyPath` alone, for the
// conversion's next run or the daemon's next start to remove.
async function copyOpenedFile(
  source: FileHandle,
  targetPath: string,
  copyPath: string,
): Promise<CopyOutcome> {
  const { mode } = await source.stat();
  const copy = await open(copyPath, CREATE_COPY_FLAGS, mode & 0o777);
  try {
    await copyBytes(source, copy);
  } catch (copyError) {
    throw await failureAfterCleanups(copyError, [() => copy.close(), () => unlink(copyPath)]);
  }
  try {
    await copy.close();
  } catch (closeError) {
    throw await failureAfterCleanups(closeError, [() => unlink(copyPath)]);
  }
  return (await publishWithoutReplacing(copyPath, targetPath)) === "published"
    ? { kind: "copied" }
    : { kind: "skipped", reason: "repository_has_file" };
}

// Runs every cleanup after `failure`, each whatever the others did, and answers what to throw:
// `failure`, or an AggregateError of it and each cleanup that failed too.
async function failureAfterCleanups(
  failure: unknown,
  cleanups: readonly (() => Promise<unknown>)[],
): Promise<unknown> {
  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
  }
  return cleanupFailures.length === 0
    ? failure
    : new AggregateError(
        [failure, ...cleanupFailures],
        "Copying a file failed, and removing what it had written failed too",
        { cause: cleanupFailures[0] },
      );
}

async function copyBytes(source: FileHandle, target: FileHandle): Promise<void> {
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (let position = 0; ; ) {
    const { bytesRead } = await source.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) {
      return;
    }
    for (let written = 0; written < bytesRead; ) {
      written += (await target.write(chunk, written, bytesRead - written)).bytesWritten;
    }
    position += bytesRead;
  }
}

// Whether `folder` is a real folder of the repository, made when missing. A link or a file there
// means the repository holds that path, and a link is never written through.
async function holdsOwnFolder(folder: string): Promise<boolean> {
  if (await opensAsOwnFolder(folder)) {
    return true;
  }
  try {
    await mkdir(folder);
    return true;
  } catch (error) {
    if (errnoOf(error) === "EEXIST") {
      return opensAsOwnFolder(folder);
    }
    throw error;
  }
}

// Opens `folder` as a folder without following a link at it; false when nothing is there yet or
// what is there is a file or a link.
async function opensAsOwnFolder(folder: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(folder, OPEN_FOLDER_FLAGS);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      return false;
    }
    throw error;
  }
  await handle.close();
  return true;
}

function errnoOf(error: unknown): unknown {
  return (error as { readonly code?: unknown } | null)?.code;
}
