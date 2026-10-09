// The machine's folders, listed for another device's `Open folder…`: the folder in view, the path
// down to it, and its folders by name, each marked when it is a git repository. Git is asked, one
// folder at a time and as many at once as the machine has processors, whether a folder is a
// repository's own top level; git's files are never read. The listing starts at the home folder of
// the account the service runs as, leaves hidden folders out unless asked, and is cut only where it
// would overflow one message, with `more` saying the filter would narrow further. A read of the
// folder that fails in a way another moment can clear is tried once more; a read that still fails
// is refused with the system's reason.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";
import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type {
  RepoFolderListEntry,
  RepoFolderListRequest,
  RepoFolderListResponse,
  RepoFolderPathSegment,
} from "@ai-sidekicks/contracts/repo/folders";

import { readGitExitStatus, type GitCommand } from "../../git/process.js";
import { canonicalFolderPath } from "./canonical-path.js";
import { mapWithProcessorBound } from "../../processor-bound.js";
import { readWithOneRetry } from "../../read-retry.js";
import type { FolderPlace } from "./place.js";
import { RepoFolderUnreachableError, RepoRootResolutionError } from "../repo/errors.js";
import { classifyFilesystemFailure, stripSingleLineTerminator } from "../repo/root-resolver.js";

/** What the folder list reads with. */
export interface FolderListDeps {
  /** The home folder of the account the service runs as, where a listing starts. */
  readonly homeDirectory: string;
  /** Where a folder sits on a Windows computer with WSL. */
  readonly folderPlace: FolderPlace;
  /** The daemon's git entry point. */
  readonly git: GitCommand;
}

/** Lists the machine's folders for another device's folder chooser. */
export class FolderListService {
  readonly #homeDirectory: string;
  readonly #folderPlace: FolderPlace;
  readonly #git: GitCommand;

  constructor(deps: FolderListDeps) {
    this.#homeDirectory = deps.homeDirectory;
    this.#folderPlace = deps.folderPlace;
    this.#git = deps.git;
  }

  /**
   * The folder at `request.path` (the home folder when absent) and its folders matching
   * `request.filter`, folded for case, in name order. Throws `RepoRootResolutionError` reason
   * `not_absolute` for a relative path, `RepoFolderUnreachableError` for a folder in another WSL
   * distribution, and `RepoRootResolutionError` reason `path_not_found` or `not_readable` for a
   * folder it cannot read, after one retry when the failure is a moment's.
   */
  async list(request: RepoFolderListRequest): Promise<RepoFolderListResponse> {
    const requested = request.path ?? this.#homeDirectory;
    if (!path.isAbsolute(requested)) {
      throw new RepoRootResolutionError("not_absolute");
    }
    const folder = path.resolve(requested);
    if (this.#folderPlace.isInAnotherDistribution(folder)) {
      throw new RepoFolderUnreachableError();
    }
    let dirents: Dirent[];
    try {
      dirents = await readWithOneRetry(() => readdir(folder, { withFileTypes: true }));
    } catch (readFailure) {
      throw new RepoRootResolutionError(classifyFilesystemFailure(readFailure));
    }
    const filter = request.filter === undefined ? "" : foldName(request.filter);
    const names: string[] = [];
    for (const dirent of dirents) {
      if (request.showHidden !== true && dirent.name.startsWith(".")) continue;
      if (filter !== "" && !foldName(dirent.name).includes(filter)) continue;
      if (await isFolder(folder, dirent)) names.push(dirent.name);
    }
    names.sort((left, right) => left.localeCompare(right));

    const candidates = names.map((name) => ({ name, path: path.join(folder, name) }));
    const fitted = candidates.slice(
      0,
      countEntriesFittingOneFrame(
        candidates.map((candidate) => ({ ...candidate, isRepository: false })),
        candidates.length,
      ),
    );
    const entries = await this.#markRepositories(fitted);
    return {
      path: folder,
      segments: segmentsOf(folder),
      entries,
      more: entries.length < names.length,
    };
  }

  // Each candidate with git's answer, one question per processor at a time, in the candidates'
  // order.
  async #markRepositories(
    candidates: readonly { readonly name: string; readonly path: string }[],
  ): Promise<RepoFolderListEntry[]> {
    return mapWithProcessorBound(candidates, async (candidate) => ({
      ...candidate,
      isRepository: await this.#isRepository(candidate.path),
    }));
  }

  // A repository's own top level, as git reports it; a folder inside one, or in none, is not.
  async #isRepository(folder: string): Promise<boolean> {
    let topLevel: string;
    try {
      const result = await this.#git(["-C", folder, "rev-parse", "--show-toplevel"]);
      topLevel = stripSingleLineTerminator(result.stdout.toString("utf8"), path);
    } catch (refusal) {
      // Git answered with a refusal (no repository, a bare one, an unreadable folder); a git that
      // could not run at all, or ran out of time, is a failure the listing cannot hide.
      if (readGitExitStatus(refusal) !== null) {
        return false;
      }
      throw refusal;
    }
    // Both resolved and compared by one path rule, since git prints forward slashes on Windows.
    return (await canonicalFolderPath(topLevel)) === (await canonicalFolderPath(folder));
  }
}

// A folder entry, or a link that leads to one; a link that leads nowhere is left out.
async function isFolder(parent: string, dirent: Dirent): Promise<boolean> {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(parent, dirent.name))).isDirectory();
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "EACCES") return false;
    throw error;
  }
}

// The path from its root down, each step pressable; the last is the folder itself.
function segmentsOf(folder: string): RepoFolderPathSegment[] {
  const { root } = path.parse(folder);
  const segments: RepoFolderPathSegment[] = [{ name: root, path: root }];
  let walked = root;
  for (const part of folder.slice(root.length).split(path.sep)) {
    if (part === "") continue;
    walked = path.join(walked, part);
    segments.push({ name: part, path: walked });
  }
  return segments;
}
