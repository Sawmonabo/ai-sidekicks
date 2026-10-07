// `session.fileSearch`, the `@` file search: the session's working folder listed, ranked by the
// product's one fuzzy scorer with a file's own name before its path, and cut to a fixed count.
// A path whose real location is outside the working folder is dropped, so no answer follows a
// link out of it.

import { realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import { scoreSubsequence } from "@ai-sidekicks/search-ranking";
import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts/free-form-string";
import {
  SESSION_WORKING_FOLDER_UNAVAILABLE_CODE,
  type SessionFileSearchRequest,
  type SessionFileSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";

import type { ServiceLogWriter } from "../../../daemon/service-log.js";
import type { GitCommand } from "../../../git/process.js";
import { DaemonDomainError } from "../../../ipc/domain-error.js";
import { SessionNotFoundError } from "../../../ipc/session-errors.js";
import { listWorkingFolder } from "./listing.js";

// The most paths one `@` file search answers.
const FILE_SEARCH_RESULT_MAX = 50;

// The session's working folder: its newest workspace whose root is in place.
const WORKING_FOLDER_SQL = `
  SELECT fs_root FROM workspaces
   WHERE session_id = ? AND fs_root IS NOT NULL AND state IN ('ready', 'busy')
   ORDER BY created_at DESC, id DESC
   LIMIT 1`;

const SESSION_EXISTS_SQL = `SELECT 1 FROM sessions WHERE id = ?`;

// A path that vanished, or whose links never end, has no real location to keep.
const UNRESOLVABLE_PATH_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/** What the file search reads through. */
export interface FileSearchServiceDeps {
  /** The daemon's read connection, where the session's workspace is found. */
  readonly reader: Database;
  /** The daemon's hook-neutralized git entry point. */
  readonly git: GitCommand;
  /** Where a rules file the listing could not read is named. */
  readonly writeServiceLog: ServiceLogWriter;
}

interface RankedPath {
  readonly path: string;
  // A match on the file's own name outranks a match on its path alone.
  readonly isNameMatch: boolean;
  readonly score: number;
}

/** Answers `session.fileSearch` over the session's working folder. */
export class FileSearchService {
  readonly #git: GitCommand;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #workingFolder: Statement<[string], { readonly fs_root: string }>;
  readonly #sessionExists: Statement<[string], unknown>;

  constructor(deps: FileSearchServiceDeps) {
    this.#git = deps.git;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#workingFolder = deps.reader.prepare(WORKING_FOLDER_SQL);
    this.#sessionExists = deps.reader.prepare(SESSION_EXISTS_SQL);
  }

  /**
   * The best matching paths, relative to the working folder. Throws `SessionNotFoundError` for a
   * session the daemon does not hold, `session.working_folder_unavailable` for a working folder
   * that is not in place, and the listing's own error, with its reason, for one that could not be
   * listed.
   */
  async search(request: SessionFileSearchRequest): Promise<SessionFileSearchResponse> {
    const workingFolder = this.#workingFolder.get(request.sessionId)?.fs_root;
    if (workingFolder === undefined) {
      if (this.#sessionExists.get(request.sessionId) === undefined) {
        throw new SessionNotFoundError("The daemon holds no session with this id.", {
          sessionId: request.sessionId,
        });
      }
      throw new DaemonDomainError(
        "The session's working folder is not in place, so it cannot be searched.",
        { code: SESSION_WORKING_FOLDER_UNAVAILABLE_CODE, detail: { sessionId: request.sessionId } },
      );
    }
    const listedPaths = await listWorkingFolder(workingFolder, this.#git, this.#writeServiceLog);
    const rankedPaths = rankPaths(listedPaths, request.query);
    return {
      paths: await keepContainedPaths(workingFolder, rankedPaths),
      searchedFileCount: listedPaths.length,
    };
  }
}

// Every path the query matches, best first; an empty query keeps every path in path order.
function rankPaths(paths: readonly string[], query: string): string[] {
  if (query.length === 0) {
    return [...paths].sort(comparePaths);
  }
  const ranked: RankedPath[] = [];
  for (const path of paths) {
    const nameMatch = scoreSubsequence(basename(path), query);
    if (nameMatch !== undefined) {
      ranked.push({ path, isNameMatch: true, score: nameMatch.score });
      continue;
    }
    const pathMatch = scoreSubsequence(path, query);
    if (pathMatch !== undefined) {
      ranked.push({ path, isNameMatch: false, score: pathMatch.score });
    }
  }
  return ranked
    .sort(
      (left, right) =>
        Number(right.isNameMatch) - Number(left.isNameMatch) ||
        right.score - left.score ||
        comparePaths(left.path, right.path),
    )
    .map((rankedPath) => rankedPath.path);
}

function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// The first paths, up to the cap, whose real location is inside the working folder.
async function keepContainedPaths(
  workingFolder: string,
  rankedPaths: readonly string[],
): Promise<string[]> {
  const realFolderPrefix = `${await realpath(workingFolder)}${sep}`;
  const kept: string[] = [];
  let next = 0;
  while (kept.length < FILE_SEARCH_RESULT_MAX && next < rankedPaths.length) {
    const batch = rankedPaths.slice(next, next + FILE_SEARCH_RESULT_MAX - kept.length);
    next += batch.length;
    const realPaths = await Promise.all(
      batch.map((path) => resolveRealPath(join(workingFolder, path))),
    );
    batch.forEach((path, index) => {
      const realPath = realPaths[index];
      if (
        realPath !== undefined &&
        realPath.startsWith(realFolderPrefix) &&
        path.length <= FILE_PATH_MAX_LEN
      ) {
        kept.push(path);
      }
    });
  }
  return kept;
}

async function resolveRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (UNRESOLVABLE_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }
    throw error;
  }
}
