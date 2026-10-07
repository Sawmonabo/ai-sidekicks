// Converting a chat to a project in place. The typed folder is attached, or the machine's mount for
// it reused; the chat's files are copied in without replacing anything the repository holds; the
// session binds to the project's checkout; and `session.converted` moves its shape, recording the
// request's idempotency key and every file not copied with its reason, which a paged read serves.
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

import { WriteRefusedError } from "../database/writer.js";
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

const RECORD_CONVERT_REQUEST_SQL = `INSERT INTO session_convert_requests
  (client_idempotency_key, session_id) VALUES (?, ?)`;

// Every skipped file in one statement, from one bound JSON array, however many there are.
const RECORD_SKIPPED_FILES_SQL = `INSERT INTO session_convert_skipped_files (session_id, path, reason)
  SELECT @sessionId, json_extract(value, '$.path'), json_extract(value, '$.reason')
    FROM json_each(@skippedFiles)`;

// The conversion this key already made, of whichever session, as its event recorded it.
const EARLIER_CONVERSION_SQL = `SELECT request.session_id AS sessionId, event.payload
  FROM session_convert_requests AS request
  JOIN session_events AS event
    ON event.session_id = request.session_id AND event.type = 'session.converted'
 WHERE request.client_idempotency_key = ?`;

const SESSION_EXISTS_SQL = "SELECT 1 FROM sessions WHERE id = ?";

// One row past the page shows whether more remain; the first page reads after the empty path,
// which sorts before every path.
const SKIPPED_FILES_PAGE_SQL = `SELECT path, reason FROM session_convert_skipped_files
  WHERE session_id = @sessionId AND path > @afterPath
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

// What a conversion has done so far, so a failure part way can say it.
interface ConversionProgress {
  copiedCount: number;
  readonly skippedFiles: SessionConvertSkippedFile[];
  isBound: boolean;
}

/** What converting a chat reads, locks, attaches, binds and appends through. */
export interface SessionConversionDeps {
  /** The read-only connection the session's facts, earlier conversions and skipped files are read on. */
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
        `${String(progress.skippedFiles.length)} were not, and the session ` +
        (progress.isBound ? "was bound to it but " : "") +
        "is still a chat.",
      {
        code: SESSION_CONVERT_INCOMPLETE_CODE,
        detail: {
          sessionId,
          repoMountId,
          copiedCount: progress.copiedCount,
          skippedCount: progress.skippedFiles.length,
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
  readonly #events: Pick<EventLogService, "append">;
  readonly #lock: Pick<SessionChanges["lock"], "run">;
  // Serializes converts that carry one key across sessions, so a second session sees the first's
  // conversion and is refused before it attaches anything. Always taken before the session lock.
  readonly #keyLock = new KeyedLock<string>();
  readonly #repoMounts: Pick<RepoMountService, "attachOrReuse" | "readManagedRoot">;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #now: () => Date;
  readonly #selectFacts: Statement<[string], SessionFacts>;
  readonly #selectEarlierConversion: Statement<
    [string],
    { readonly sessionId: string; readonly payload: string }
  >;
  readonly #selectSessionExists: Statement<[string]>;
  readonly #selectSkippedFilesPage: Statement<
    [{ sessionId: string; afterPath: string; rowCount: number }],
    SessionConvertSkippedFile
  >;

  constructor(deps: SessionConversionDeps) {
    this.#reader = deps.reader;
    this.#events = deps.events;
    this.#lock = deps.lock;
    this.#repoMounts = deps.repoMounts;
    this.#workspaces = deps.workspaces;
    this.#now = deps.now ?? (() => new Date());
    this.#selectFacts = deps.reader.prepare(SESSION_FACTS_SQL);
    this.#selectEarlierConversion = deps.reader.prepare(EARLIER_CONVERSION_SQL);
    this.#selectSessionExists = deps.reader.prepare(SESSION_EXISTS_SQL);
    this.#selectSkippedFilesPage = deps.reader.prepare(SKIPPED_FILES_PAGE_SQL);
  }

  /**
   * Converts the chat into the repository at `request.path` and answers what was and was not
   * copied. A request whose `clientIdempotencyKey` already converted this session answers that
   * conversion's counts and copies nothing. Refuses a key that converted another session, a session
   * that is not a chat, or a chat with no managed workspace (`session.convert_refused`), one that
   * takes no change (`session.already_closed`, `session.change_refused`), and a folder the attach
   * refuses (`repo.root_resolution_failed`, `repo.already_attached` for a chat's own workspace),
   * each before anything is attached or copied. A failure after the attach throws
   * `session.convert_incomplete` naming what was done.
   */
  async convert(request: SessionConvertRequest): Promise<SessionConvertResponse> {
    const { sessionId, clientIdempotencyKey } = request;
    return this.#keyLock.run(clientIdempotencyKey, () =>
      this.#lock.run(sessionId, () => this.#convertHeld(request)),
    );
  }

  async #convertHeld(request: SessionConvertRequest): Promise<SessionConvertResponse> {
    const { sessionId } = request;
    const earlier = this.#selectEarlierConversion.get(request.clientIdempotencyKey);
    if (earlier !== undefined) {
      if (earlier.sessionId !== sessionId) {
        throw new DaemonDomainError("This idempotency key already converted another session.", {
          code: SESSION_CONVERT_REFUSED_CODE,
          detail: { sessionId, reason: "idempotency_key_reused" },
        });
      }
      const { copiedCount, skippedCount } = SessionConvertedPayloadSchema.parse(
        JSON.parse(earlier.payload),
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
    const project = await this.#repoMounts.attachOrReuse({ localPath: request.path });
    const progress: ConversionProgress = { copiedCount: 0, skippedFiles: [], isBound: false };
    try {
      await copyWorkspaceFiles(workspaceRoot, project.canonicalRoot, progress);
      await this.#workspaces.bind({
        sessionId,
        repoMountId: project.repoMountId,
        executionMode: "bound-root",
      });
      progress.isBound = true;
      await this.#appendConverted(
        { sessionId, repoMountId: project.repoMountId, ...outcomeOf(progress) },
        request.clientIdempotencyKey,
        progress.skippedFiles,
      );
    } catch (error) {
      throw new SessionConversionIncompleteError(sessionId, project.repoMountId, progress, error);
    }
    return outcomeOf(progress);
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

  async #appendConverted(
    payload: SessionConvertedPayload,
    clientIdempotencyKey: string,
    skippedFiles: readonly SessionConvertSkippedFile[],
  ): Promise<void> {
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
            {
              sql: RECORD_CONVERT_REQUEST_SQL,
              bindings: [clientIdempotencyKey, payload.sessionId],
            },
            {
              sql: RECORD_SKIPPED_FILES_SQL,
              bindings: {
                sessionId: payload.sessionId,
                skippedFiles: JSON.stringify(skippedFiles),
              },
            },
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

function outcomeOf(progress: ConversionProgress): SessionConvertResponse {
  return { copiedCount: progress.copiedCount, skippedCount: progress.skippedFiles.length };
}

// The cursor names the last path a page carried, encoded so a client reads nothing into it.
function skippedFileCursorOf(path: string): SessionConvertSkippedFileCursor {
  return Buffer.from(path, "utf8").toString("base64url") as SessionConvertSkippedFileCursor;
}

// Any cursor decodes to some path, and a page simply starts after it.
function skippedFilePathOf(cursor: SessionConvertSkippedFileCursor): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

// Copies each of the workspace's files into the project one at a time, recording each outcome as
// it lands, every file not copied with its reason.
async function copyWorkspaceFiles(
  workspaceRoot: string,
  projectRoot: string,
  progress: ConversionProgress,
): Promise<void> {
  for (const relativePath of await listWorkspaceEntries(workspaceRoot, projectRoot)) {
    const outcome = await copyWorkspaceEntry(workspaceRoot, projectRoot, relativePath);
    if (outcome.kind === "copied") {
      progress.copiedCount += 1;
    } else if (outcome.kind === "skipped") {
      progress.skippedFiles.push({ path: relativePath, reason: outcome.reason });
    }
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
