// Converting a chat to a project in place. The typed folder is attached, or the machine's mount for
// it reused, and the conversion recorded under the request's idempotency key; the chat's files are
// copied in without replacing anything the repository holds, each outcome recorded as it lands; the
// session binds to the project's checkout; and `session.converted` moves its shape. A conversion
// that stopped part way resumes from its records, and the files not copied are read page by page.
// The session keeps its id and transcript, and its managed workspace stays with its history.

import { constants as fsConstants, type Dirent } from "node:fs";
import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

import type { Database, Statement } from "better-sqlite3";

import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { RepoAttachResponse } from "@ai-sidekicks/contracts/repo/folders";
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
import { DaemonDomainError } from "../ipc/domain-error.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { KeyedLock } from "../keyed-lock.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { RepoMountService } from "../workspace/repo/mount-service.js";
import type { WorkspaceService } from "../workspace/service.js";
import { refuseUnchangeableSession, type SessionChanges } from "./changes.js";

const SESSION_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// The workspace's own repository is the daemon's record of the chat, never one of its files.
const GIT_METADATA_ENTRY_NAME = ".git";

const SESSION_FACTS_SQL = "SELECT shape, state FROM sessions WHERE id = ?";

// Holds only while the session is still a chat that takes changes, inside the write that makes it
// a project.
const OPEN_CHAT_SQL = `SELECT 1 FROM sessions
  WHERE id = ? AND shape = 'chat' AND state NOT IN ('closed', 'purge_requested')`;

const RECORD_CONVERSION_SQL = `INSERT INTO session_convert_requests
  (client_idempotency_key, session_id, repo_mount_id) VALUES (?, ?, ?)`;

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

// A chat's conversion that stopped part way, with the folder it copies into.
const UNFINISHED_CONVERSION_SQL = `SELECT request.client_idempotency_key AS clientIdempotencyKey,
       request.repo_mount_id AS repoMountId, mount.canonical_root AS canonicalRoot
  FROM session_convert_requests AS request
  JOIN repo_mounts AS mount ON mount.id = request.repo_mount_id
 WHERE request.session_id = ?`;

const FILES_DEALT_WITH_SQL = "SELECT path FROM session_convert_files WHERE session_id = ?";

const FILE_COUNTS_SQL = `SELECT count(*) FILTER (WHERE outcome = 'copied') AS copiedCount,
       count(*) FILTER (WHERE outcome <> 'copied') AS skippedCount
  FROM session_convert_files WHERE session_id = ?`;

const SESSION_EXISTS_SQL = "SELECT 1 FROM sessions WHERE id = ?";

// One row past the page shows whether more remain; the first page reads after the empty path,
// which sorts before every path.
const SKIPPED_FILES_PAGE_SQL = `SELECT path, outcome AS reason FROM session_convert_files
  WHERE session_id = @sessionId AND path > @afterPath AND outcome <> 'copied'
  ORDER BY path
  LIMIT @rowCount`;

// Every open names its last component exactly: a link there refuses the open instead of being
// followed. A pipe swapped in opens without waiting for a writer, and is then refused as no file.
const OPEN_SOURCE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const CREATE_TARGET_FLAGS =
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

// A chat's conversion that stopped part way.
interface UnfinishedConversion {
  readonly clientIdempotencyKey: string;
  readonly repoMountId: RepoMountId;
  readonly canonicalRoot: string;
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
  /** Resolves and attaches the typed folder, and knows where the chat's managed workspace is. */
  readonly repoMounts: Pick<
    RepoMountService,
    "attachOrReuse" | "readManagedRoot" | "resolveFolder"
  >;
  /** Binds the session to the project's checkout. */
  readonly workspaces: Pick<WorkspaceService, "bind">;
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
  readonly #repoMounts: Pick<
    RepoMountService,
    "attachOrReuse" | "readManagedRoot" | "resolveFolder"
  >;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #now: () => Date;
  readonly #selectFacts: Statement<[string], SessionFacts>;
  readonly #selectConversionByKey: Statement<
    [string],
    { readonly sessionId: string; readonly payload: string | null }
  >;
  readonly #selectUnfinishedConversion: Statement<[string], UnfinishedConversion>;
  readonly #selectFilesDealtWith: Statement<[string], { readonly path: string }>;
  readonly #selectFileCounts: Statement<[string], SessionConvertResponse>;
  readonly #selectSessionExists: Statement<[string]>;
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
    this.#workspaces = deps.workspaces;
    this.#now = deps.now ?? (() => new Date());
    this.#selectFacts = deps.reader.prepare(SESSION_FACTS_SQL);
    this.#selectConversionByKey = deps.reader.prepare(CONVERSION_BY_KEY_SQL);
    this.#selectUnfinishedConversion = deps.reader.prepare(UNFINISHED_CONVERSION_SQL);
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
   * a chat, or a chat with no managed workspace (`session.convert_refused`); one that takes no
   * change (`session.already_closed`, `session.change_refused`); and a folder the attach refuses
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
      await this.#writer.write([record]);
      const dealtWith = new Set(this.#selectFilesDealtWith.all(sessionId).map((row) => row.path));
      await copyWorkspaceFiles(workspaceRoot, project.canonicalRoot, dealtWith, (path, outcome) =>
        this.#writer.write([{ sql: RECORD_FILE_SQL, bindings: [sessionId, path, outcome] }]),
      );
      await this.#workspaces.bind({
        sessionId,
        repoMountId: project.repoMountId,
        executionMode: "bound-root",
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
  // request's key. A conversion that stopped part way goes on only into its own folder, taken over
  // by this request's key on the mount that folder is attached as now, attached again if a detach
  // let it go since.
  async #attachProject(
    request: SessionConvertRequest,
  ): Promise<{ readonly project: RepoAttachResponse; readonly record: WriteStatement }> {
    const { sessionId, clientIdempotencyKey } = request;
    const unfinished = this.#selectUnfinishedConversion.get(sessionId);
    if (unfinished === undefined) {
      const project = await this.#repoMounts.attachOrReuse({ localPath: request.path });
      return {
        project,
        record: {
          sql: RECORD_CONVERSION_SQL,
          bindings: [clientIdempotencyKey, sessionId, project.repoMountId],
        },
      };
    }
    const folder = await this.#repoMounts.resolveFolder({ localPath: request.path });
    if (folder.canonicalRoot !== unfinished.canonicalRoot) {
      throw new DaemonDomainError("The chat's conversion into another folder stopped part way.", {
        code: SESSION_CONVERT_REFUSED_CODE,
        detail: { sessionId, reason: "conversion_unfinished", repoMountId: unfinished.repoMountId },
      });
    }
    const project = await this.#repoMounts.attachOrReuse({ localPath: request.path });
    return {
      project,
      record: {
        sql: TAKE_OVER_CONVERSION_SQL,
        bindings: [clientIdempotencyKey, project.repoMountId, sessionId],
        expectedRowCount: 1,
      },
    };
  }

  #fileCountsOf(sessionId: SessionId): SessionConvertResponse {
    const counts = this.#selectFileCounts.get(sessionId);
    if (counts === undefined) {
      throw new Error("A count over a conversion's files answered no row");
    }
    return counts;
  }

  /**
   * One page of the files the session's conversion did not copy, in path order, each with its
   * reason. A session never converted, or one whose conversion copied every file, answers an
   * empty last page. Throws {@link SessionNotFoundError} for a session this daemon holds no row
   * for.
   */
  listSkippedFiles(
    request: SessionConvertSkippedFileListRequest,
  ): SessionConvertSkippedFileListResponse {
    const limit = request.limit ?? SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX;
    const { exists, rows } = this.#reader.transaction(() => ({
      exists: this.#selectSessionExists.get(request.sessionId) !== undefined,
      rows: this.#selectSkippedFilesPage.all({
        sessionId: request.sessionId,
        afterPath: request.afterCursor === undefined ? "" : skippedFilePathOf(request.afterCursor),
        rowCount: limit + 1,
      }),
    }))();
    if (!exists) {
      throw new SessionNotFoundError("This daemon holds no such session.", {
        sessionId: request.sessionId,
      });
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
      throw new SessionNotFoundError("This daemon holds no such session.", { sessionId });
    }
    refuseUnchangeableSession(sessionId, facts.state);
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

// The cursor names the last path a page carried, encoded so a client reads nothing into it.
function skippedFileCursorOf(path: string): SessionConvertSkippedFileCursor {
  return Buffer.from(path, "utf8").toString("base64url") as SessionConvertSkippedFileCursor;
}

// Any cursor decodes to some path, and a page simply starts after it.
function skippedFilePathOf(cursor: SessionConvertSkippedFileCursor): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

// Copies each of the workspace's files the conversion has not yet dealt with into the project, one
// at a time, recording each outcome as it lands, every file not copied with its reason. The copy
// goes on while records commit, so the writer folds many into one batch; at most
// RECORDS_IN_FLIGHT_MAX wait at once, and every one has committed before this settles, either way,
// so a stop inside the daemon still counts each landed copy. A failed record stops the copy.
async function copyWorkspaceFiles(
  workspaceRoot: string,
  projectRoot: string,
  dealtWith: ReadonlySet<string>,
  record: (relativePath: string, outcome: RecordedOutcome) => Promise<unknown>,
): Promise<void> {
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
    for (const relativePath of await listWorkspaceEntries(workspaceRoot, projectRoot)) {
      if (recordFailure !== undefined) {
        break;
      }
      if (dealtWith.has(relativePath)) {
        continue;
      }
      const outcome = await copyWorkspaceEntry(workspaceRoot, projectRoot, relativePath);
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

// Every entry of the workspace but its folders, `/`-separated, in name order: files, links and
// special files alike, each left to the copy to tell apart on the opened entry. The walk never
// descends through a link, so nothing outside the workspace is listed, and it leaves out the
// workspace's own repository and the project's folder when that sits inside the workspace, so the
// repository is never copied into itself. A folder removed while the walk runs holds nothing.
async function listWorkspaceEntries(workspaceRoot: string, projectRoot: string): Promise<string[]> {
  const entries: string[] = [];
  const pendingFolders: string[] = [""];
  for (let folder = pendingFolders.pop(); folder !== undefined; folder = pendingFolders.pop()) {
    for (const dirent of await readFolder(path.join(workspaceRoot, folder))) {
      if (dirent.name === GIT_METADATA_ENTRY_NAME) {
        continue;
      }
      const relativePath = folder === "" ? dirent.name : `${folder}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (path.join(workspaceRoot, relativePath) !== projectRoot) {
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
// a link or a special file is refused even when it was swapped in after the listing, and the
// target is created exclusively, so a path the repository already holds, a link there included,
// is skipped.
async function copyWorkspaceEntry(
  workspaceRoot: string,
  projectRoot: string,
  relativePath: string,
): Promise<CopyOutcome> {
  const opened = await openSourceFile(path.join(workspaceRoot, relativePath));
  if (opened.kind !== "opened") {
    return opened;
  }
  try {
    let folder = projectRoot;
    for (const segment of relativePath.split("/").slice(0, -1)) {
      folder = path.join(folder, segment);
      if (!(await holdsOwnFolder(folder))) {
        return { kind: "skipped", reason: "repository_path_not_a_folder" };
      }
    }
    return await copyOpenedFile(opened.handle, path.join(projectRoot, relativePath));
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

// Writes the opened source to a target created for it with the source's permission bits. A copy
// that fails part way removes its target, so no half-written file is left in the repository.
async function copyOpenedFile(source: FileHandle, targetPath: string): Promise<CopyOutcome> {
  const { mode } = await source.stat();
  let target: FileHandle;
  try {
    target = await open(targetPath, CREATE_TARGET_FLAGS, mode & 0o777);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") {
      return { kind: "skipped", reason: "repository_has_file" };
    }
    throw error;
  }
  try {
    await copyBytes(source, target);
  } catch (copyError) {
    await target.close();
    await unlink(targetPath);
    throw copyError;
  }
  await target.close();
  return { kind: "copied" };
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
