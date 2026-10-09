// Canonical repo-root resolver: turns a user-entered local path into the repository it belongs to,
// identified by its git common directory, with the main checkout's root as the canonical root and
// the path's own working tree beside it. It also answers the narrower git questions the trust
// envelope and the mount-health probe ask of a root.
//
//   * Every returned path went through `realpath`, and git's answer is verified, not trusted.
//   * Anything but a successful resolution throws `RepoRootResolutionError`: no fallback to the
//     input and no root completed from daemon state (working directory, home directory, drive).
//   * `not_a_repository` needs git's verdict and no `<supplied>/.git` entry; every other git
//     failure is `vcs_error`. Git is asked rather than walking up for `.git`, which is a file in
//     linked worktrees and submodules, and a path that does not exist is refused before git runs.
//   * The main checkout is derived from git's worktree list before the path's own working tree is
//     considered: a planted `.git` pointer naming a repository's common directory makes git report
//     the planted folder as its own toplevel, and only the list shows it is no working tree of
//     that repository. Where the list's first entry is not a working tree (`--separate-git-dir`,
//     a submodule) the path's own working tree is its own root.
//   * A repository's own config can carry `core.worktree`, so git can report a sibling or an
//     ancestor as the toplevel (git 2.50.1); the membership and fixpoint checks refuse both with
//     `root_mismatch`.

import * as nodePath from "node:path";

import type { VcsType } from "@ai-sidekicks/contracts/repo/mount";

import { runGitWithExecFile, type GitRunner } from "../../git/process.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { readListedWorktrees, type ListedWorktree } from "../../git/worktree/reads.js";
import { RepoRootResolutionError } from "./errors.js";
import {
  componentsEqual,
  DEFAULT_DIRECTORY_READABILITY_PROBE,
  DEFAULT_REALPATH,
  isContainedWithin,
  namesCompleteLocation,
  toComparableComponents,
  WINDOWS_PATH_SEPARATOR,
  type DirectoryReadabilityProbe,
  type PathRealpathResolver,
  type PlatformPathModule,
} from "../trust-envelope.js";

/**
 * What attach may persist about a path: every member absolute and symlink-resolved, and both roots
 * readable when resolved.
 */
export interface RepoRootResolution {
  /** The main checkout's working-tree root, or the path's own working tree where it is its own. */
  readonly canonicalRoot: string;
  /** The top level of the working tree the path sits in, which a bind that names no folder uses. */
  readonly workingTreeRoot: string;
  /** The repository's git common directory: its identity, shared by all its working trees. */
  readonly commonDir: string;
  readonly vcsType: VcsType;
}

/** The git questions the trust envelope asks of a folder, answered by the resolver. */
export interface WorkingTreeReader {
  /**
   * The symlink-resolved top level of the working tree `directory` sits in, or `null` when git
   * answers that it sits in none. Throws `vcs_error` when git cannot answer.
   */
  readWorkingTreeRoot(directory: string): Promise<string | null>;
  /**
   * The symlink-resolved working trees git lists for the repository at `directory`, main entry
   * first; an entry that no longer resolves is left out. Throws `vcs_error` when git cannot answer.
   */
  listWorkingTrees(directory: string): Promise<readonly string[]>;
}

/**
 * Constructor-injectable primitives; every member defaults to the real one, so tests drive the
 * failure modes. The git runner rejects with the raw `execFile` error, so the classifier is
 * exercised by real Node errors.
 */
export interface RepoRootResolverDeps {
  /** Defaults to the daemon's shared `execFile` runner. */
  readonly git: GitRunner;
  /**
   * Defaults to `fs.promises.realpath`, which returns each component's on-disk casing, keeping the
   * membership comparison casing-safe. The callback `fs.realpath` keeps the caller's casing, so a
   * mis-cased attach would be refused `root_mismatch`. Native caveats, none load-bearing: musl
   * Linux needs `/proc`, and Windows drive-letter casing varies.
   */
  readonly realpath: PathRealpathResolver;
  /**
   * Defaults to the probe `trust-envelope.ts` shares, so attach-time and bind-time answers agree.
   * `requireReadableRoot` reads a rejection as unreadable; `hasVisibleGitMetadata` reads only
   * `ENOENT` as none. An admission check made once; a root that becomes unreadable later is not a
   * resolution failure.
   */
  readonly probeDirectoryReadable: DirectoryReadabilityProbe;
  readonly gitCommandTimeoutMs: number;
  /**
   * Defaults to `node:path`; win32-ness comes from its `sep`, not `process.platform`. Read only by
   * the step-1 gate and `stripSingleLineTerminator`: every check on an outgoing value uses the real
   * `node:path`, so a misconfigured seam cannot loosen it.
   */
  readonly platformPath: PlatformPathModule;
}

/** Milliseconds allowed for one git query (a network mount can hang); a kill is `vcs_error`. */
const DEFAULT_REV_PARSE_TIMEOUT_MS: number = 10_000;

/** git's exit code for a fatal error (`die()`); half of the not-a-repository verdict. */
export const GIT_FATAL_EXIT_CODE: number = 128;

/**
 * git's wording, anchored at the start of a stderr line: unanchored it would also match another
 * fatal error whose quoted path contains the phrase. git escapes control characters in quoted
 * paths, so no path can inject a newline to defeat the anchor.
 */
const NOT_A_REPOSITORY_STDERR_MARKER = /^fatal: not a git repository/im;

/** The entry git's discovery looks for (a directory or a `gitdir:` file); never read. */
const GIT_METADATA_ENTRY_NAME = ".git";

function resolveDeps(partial: Partial<RepoRootResolverDeps>): RepoRootResolverDeps {
  return {
    git: partial.git ?? runGitWithExecFile,
    realpath: partial.realpath ?? DEFAULT_REALPATH,
    probeDirectoryReadable: partial.probeDirectoryReadable ?? DEFAULT_DIRECTORY_READABILITY_PROBE,
    gitCommandTimeoutMs: partial.gitCommandTimeoutMs ?? DEFAULT_REV_PARSE_TIMEOUT_MS,
    platformPath: partial.platformPath ?? nodePath,
  };
}

function readProperty(thrown: unknown, key: string): unknown {
  if (typeof thrown !== "object" || thrown === null) {
    return undefined;
  }
  return (thrown as Record<string, unknown>)[key];
}

/**
 * Maps a filesystem errno to a refusal reason: `ENOENT`, `ENOTDIR` and `ENAMETOOLONG` mean the
 * path names nothing (`path_not_found`); anything else, including `ELOOP` and `EACCES`, is
 * `not_readable`. Never `vcs_error`: an errno says nothing about the VCS query.
 */
export function classifyFilesystemFailure(thrown: unknown): "path_not_found" | "not_readable" {
  const errnoCode = readProperty(thrown, "code");
  if (errnoCode === "ENOENT" || errnoCode === "ENOTDIR" || errnoCode === "ENAMETOOLONG") {
    return "path_not_found";
  }
  return "not_readable";
}

/**
 * Did git itself die (exit 128, not killed, no signal)? That is git's answer about the folder it
 * was asked from, as opposed to a git that could not run or finish.
 */
function isGitAnswerFailure(thrown: unknown): boolean {
  if (readProperty(thrown, "killed") === true) {
    return false;
  }
  const signal = readProperty(thrown, "signal");
  if (typeof signal === "string" && signal.length > 0) {
    return false;
  }
  return readProperty(thrown, "code") === GIT_FATAL_EXIT_CODE;
}

/**
 * `"not-a-repository"` only on git's positive verdict (not killed, no signal, exit 128, anchored
 * stderr wording); everything else is `"abnormal"`, since calling a broken invocation "not a
 * repository" sends the person to fix the wrong thing. Damaged `.git` metadata also produces the
 * genuine wording; `resolveCanonicalRoot` cross-checks that.
 */
function classifyGitFailure(thrown: unknown): "not-a-repository" | "abnormal" {
  if (!isGitAnswerFailure(thrown)) {
    return "abnormal";
  }
  const standardError = readProperty(thrown, "stderr");
  if (typeof standardError !== "string" || !NOT_A_REPOSITORY_STDERR_MARKER.test(standardError)) {
    return "abnormal";
  }
  return "not-a-repository";
}

/**
 * Strips only the single line terminator `rev-parse` appends; `.trim()` would corrupt a directory
 * name ending in a space. A `\r` before the final `\n` is part of the name on POSIX and terminator
 * noise on win32, where NTFS forbids control characters.
 */
export function stripSingleLineTerminator(
  output: string,
  platformPath: PlatformPathModule,
): string {
  const withoutLineFeed = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (platformPath.sep !== WINDOWS_PATH_SEPARATOR || !withoutLineFeed.endsWith("\r")) {
    return withoutLineFeed;
  }
  return withoutLineFeed.slice(0, -1);
}

/** A canonicalized toplevel or git's positive verdict; every other outcome throws `vcs_error`. */
type ToplevelQueryOutcome =
  | { readonly kind: "toplevel"; readonly canonicalRoot: string }
  | { readonly kind: "not-a-repository" };

/** Resolves a user-entered path to its repository, or throws. Never cached (`git init`). */
export class RepoRootResolver implements WorkingTreeReader {
  private readonly deps: RepoRootResolverDeps;

  public constructor(deps: Partial<RepoRootResolverDeps> = {}) {
    this.deps = resolveDeps(deps);
  }

  /**
   * The path must name one complete location: absolute on POSIX, absolute and volume-naming on
   * Windows. Both returned roots are verified against git's answers, not just reported.
   *
   * @throws {RepoRootResolutionError} on every non-resolution; there is no other exit.
   */
  public async resolveCanonicalRoot(localPath: string): Promise<RepoRootResolution> {
    // Step 1: refuse input that needs the daemon's own state to complete (relative, `~`, driveless
    // Windows root); `realpath` would turn it into a plausible wrong root. The wire schema leaves
    // absoluteness to this check, and `~` expansion belongs to the client.
    if (!namesCompleteLocation(localPath, this.deps.platformPath)) {
      throw new RepoRootResolutionError("not_absolute");
    }

    // Step 2: canonicalize, so git never sees a symlink alias; a path that does not exist is
    // refused here, before git could attribute it to whatever repository holds its parent.
    // Traversable is not readable; `requireReadableRoot` proves the latter.
    const canonicalInputPath = await this.realpathOrThrow(localPath, classifyFilesystemFailure);

    // Step 3: ask git for the working tree the path sits in; it may be an ancestor of the input.
    const discovery = await this.queryCanonicalToplevel(canonicalInputPath);
    if (discovery.kind === "not-a-repository") {
      // A `.git` entry contradicts git's verdict: on git 2.50.1 a mode-000 `.git` directory, an
      // empty one, and a gitfile whose target is missing all exit 128 with the marker. Refuse as
      // `vcs_error`; nothing is unreadable in the last two shapes.
      if (await this.hasVisibleGitMetadata(canonicalInputPath)) {
        throw new RepoRootResolutionError("vcs_error");
      }

      // A damaged repository attached from a nested subdirectory still lands here: the gate looks
      // only at the supplied path, and crawling ancestors would be unbounded and racy.
      throw new RepoRootResolutionError("not_a_repository");
    }
    const workingTreeRoot = discovery.canonicalRoot;
    const commonDir = await this.queryCommonDirectory(canonicalInputPath);
    const listedWorktrees = await this.readWorktreeList(canonicalInputPath);

    // Step 4: derive the main checkout from the list's first entry, before the path's own tree is
    // considered; where that entry is not a working tree, the path's own tree is its own root.
    const derivedMainCheckout = await this.verifyMainCheckout(listedWorktrees[0], commonDir);
    const canonicalRoot = derivedMainCheckout ?? workingTreeRoot;

    // Real `node:path` below, never the injected seam. Every operand is `realpath` output, so no
    // case folding: it would let a redirected toplevel pass against a case-colliding sibling.
    const workingTreeComponents = toComparableComponents(workingTreeRoot, nodePath);

    // Step 5, membership: the path sits inside its working tree, and that tree is the main
    // checkout or one git lists for the repository. Equality, never containment, so a planted
    // holder inside or beside the main checkout does not pass.
    const inputComponents = toComparableComponents(canonicalInputPath, nodePath);
    if (!isContainedWithin(inputComponents, workingTreeComponents)) {
      throw new RepoRootResolutionError("root_mismatch");
    }
    const isMainCheckout = componentsEqual(
      workingTreeComponents,
      toComparableComponents(canonicalRoot, nodePath),
    );
    if (!isMainCheckout && !(await this.isListed(listedWorktrees, workingTreeComponents))) {
      throw new RepoRootResolutionError("root_mismatch");
    }

    // Step 6, fixpoint: asked from the working tree itself, git reports that tree and the same
    // common directory; a redirected toplevel (an ancestor) does not report itself. A tree that is
    // the verified main checkout already answered both.
    if (derivedMainCheckout === null || !isMainCheckout) {
      await this.requireFixpoint(workingTreeRoot, commonDir);
    }

    await this.requireReadableRoot(canonicalRoot);
    if (!isMainCheckout) {
      await this.requireReadableRoot(workingTreeRoot);
    }
    return { canonicalRoot, workingTreeRoot, commonDir, vcsType: "git" };
  }

  /**
   * The git common directory of the repository whose working tree has `root` as its top level, or
   * `null` when git answers that `root` is no such top level (its `.git` entry gone, broken, or
   * pointing elsewhere). Throws `vcs_error` when git cannot answer.
   */
  public async readRepositoryIdentity(root: string): Promise<string | null> {
    const canonicalRoot = await this.realpathOrNull(root);
    if (canonicalRoot === null) {
      return null;
    }
    const toplevel = await this.queryOwnToplevel(canonicalRoot);
    if (toplevel === null || !this.samePath(toplevel, canonicalRoot)) {
      return null;
    }
    return this.queryCommonDirectory(canonicalRoot);
  }

  /** See {@link WorkingTreeReader.readWorkingTreeRoot}. */
  public async readWorkingTreeRoot(directory: string): Promise<string | null> {
    return this.queryOwnToplevel(directory);
  }

  /** See {@link WorkingTreeReader.listWorkingTrees}. */
  public async listWorkingTrees(directory: string): Promise<readonly string[]> {
    const listed: string[] = [];
    for (const entry of await this.readWorktreeList(directory)) {
      if (entry.isBare) {
        continue;
      }
      // A worktree whose folder is gone stays listed (`prunable`) and names nothing to admit.
      const resolved = await this.realpathOrNull(entry.path);
      if (resolved !== null) {
        listed.push(resolved);
      }
    }
    return listed;
  }

  /**
   * The list's first entry, symlink-resolved, when git asked from inside it reports it as its own
   * top level and the same common directory; `null` when it is no such working tree.
   */
  private async verifyMainCheckout(
    firstEntry: ListedWorktree | undefined,
    commonDir: string,
  ): Promise<string | null> {
    if (firstEntry === undefined || firstEntry.isBare) {
      return null;
    }
    const candidate = await this.realpathOrNull(firstEntry.path);
    if (candidate === null) {
      return null;
    }
    const toplevel = await this.queryOwnToplevel(candidate);
    if (toplevel === null || !this.samePath(toplevel, candidate)) {
      return null;
    }
    const candidateCommonDir = await this.queryCommonDirectory(candidate);
    return this.samePath(candidateCommonDir, commonDir) ? candidate : null;
  }

  private async requireFixpoint(workingTreeRoot: string, commonDir: string): Promise<void> {
    const verification = await this.queryCanonicalToplevel(workingTreeRoot);
    if (
      verification.kind === "not-a-repository" ||
      !this.samePath(verification.canonicalRoot, workingTreeRoot) ||
      !this.samePath(await this.queryCommonDirectory(workingTreeRoot), commonDir)
    ) {
      throw new RepoRootResolutionError("root_mismatch");
    }
  }

  private async isListed(
    listedWorktrees: readonly ListedWorktree[],
    workingTreeComponents: readonly string[],
  ): Promise<boolean> {
    for (const entry of listedWorktrees) {
      const resolved = entry.isBare ? null : await this.realpathOrNull(entry.path);
      if (
        resolved !== null &&
        componentsEqual(toComparableComponents(resolved, nodePath), workingTreeComponents)
      ) {
        return true;
      }
    }
    return false;
  }

  private samePath(left: string, right: string): boolean {
    return componentsEqual(
      toComparableComponents(left, nodePath),
      toComparableComponents(right, nodePath),
    );
  }

  /**
   * One `rev-parse --show-toplevel` query. Discovery and verification share it, so verification
   * cannot run under a weaker environment. Throws `vcs_error` for everything but a usable toplevel
   * or the positive verdict, including a driveless toplevel and one `realpath` cannot resolve.
   */
  private async queryCanonicalToplevel(directory: string): Promise<ToplevelQueryOutcome> {
    let toplevelOutput: string;
    try {
      toplevelOutput = await this.runGitQuery(directory, ["rev-parse", "--show-toplevel"]);
    } catch (thrown: unknown) {
      if (classifyGitFailure(thrown) === "not-a-repository") {
        return { kind: "not-a-repository" };
      }
      throw new RepoRootResolutionError("vcs_error");
    }
    const canonicalRoot = await this.canonicalizeReportedPath(toplevelOutput);
    return { kind: "toplevel", canonicalRoot };
  }

  /**
   * The working-tree top level git reports from `directory`, or `null` when git answers with a
   * failure of its own (no repository, not a working tree, a dangling gitfile). Throws `vcs_error`
   * when git could not run or finish.
   */
  private async queryOwnToplevel(directory: string): Promise<string | null> {
    let toplevelOutput: string;
    try {
      toplevelOutput = await this.runGitQuery(directory, ["rev-parse", "--show-toplevel"]);
    } catch (thrown: unknown) {
      if (isGitAnswerFailure(thrown)) {
        return null;
      }
      throw new RepoRootResolutionError("vcs_error");
    }
    return this.canonicalizeReportedPath(toplevelOutput);
  }

  /** The symlink-resolved git common directory for `directory`; every failure is `vcs_error`. */
  private async queryCommonDirectory(directory: string): Promise<string> {
    let commonDirOutput: string;
    try {
      commonDirOutput = await this.runGitQuery(directory, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
    } catch {
      throw new RepoRootResolutionError("vcs_error");
    }
    return this.canonicalizeReportedPath(commonDirOutput);
  }

  /** `git worktree list --porcelain` from `directory`; every failure is `vcs_error`. */
  private async readWorktreeList(directory: string): Promise<readonly ListedWorktree[]> {
    try {
      return await readListedWorktrees(
        (argv) =>
          this.deps.git(argv, {
            timeoutMs: this.deps.gitCommandTimeoutMs,
          }),
        directory,
      );
    } catch {
      throw new RepoRootResolutionError("vcs_error");
    }
  }

  /** One single-line `git -C <directory>` query, its output with the line terminator kept. */
  private async runGitQuery(directory: string, argv: readonly string[]): Promise<string> {
    const result = await this.deps.git(["-C", directory, ...argv], {
      timeoutMs: this.deps.gitCommandTimeoutMs,
    });
    return result.stdout.toString("utf8");
  }

  /**
   * A path git printed, as a complete symlink-resolved location. An empty, driveless or
   * unresolvable answer is a VCS-query anomaly, not a bad user path.
   */
  private async canonicalizeReportedPath(output: string): Promise<string> {
    const reportedPath = stripSingleLineTerminator(output, this.deps.platformPath);
    if (reportedPath.length === 0 || !namesCompleteLocation(reportedPath, nodePath)) {
      throw new RepoRootResolutionError("vcs_error");
    }
    return this.realpathOrThrow(reportedPath, () => "vcs_error");
  }

  /**
   * Does `<directory>/.git` visibly exist? One targeted open, never a listing: a mode-0111
   * directory allows this but refuses listing. True on success and on every rejection but `ENOENT`;
   * a dangling `.git` symlink counts as absence, as in git (2.50.1).
   */
  private async hasVisibleGitMetadata(directory: string): Promise<boolean> {
    try {
      await this.deps.probeDirectoryReadable(nodePath.join(directory, GIT_METADATA_ENTRY_NAME));
    } catch (thrown: unknown) {
      return !isMissingFileError(thrown);
    }
    return true;
  }

  private async realpathOrThrow(
    path: string,
    classify: (thrown: unknown) => "path_not_found" | "not_readable" | "vcs_error",
  ): Promise<string> {
    try {
      return await this.deps.realpath(path);
    } catch (thrown: unknown) {
      throw new RepoRootResolutionError(classify(thrown));
    }
  }

  // A path that names nothing is absent to the callers; one that cannot be read is refused.
  private async realpathOrNull(path: string): Promise<string | null> {
    try {
      return await this.deps.realpath(path);
    } catch (thrown: unknown) {
      const reason = classifyFilesystemFailure(thrown);
      if (reason === "path_not_found") {
        return null;
      }
      throw new RepoRootResolutionError(reason);
    }
  }

  /**
   * The last gate before a root escapes: absolute (real `node:path`) and openable for enumeration.
   * `realpath` proves only traversal (a mode-0111 root passes and git answers normally), and the
   * probed value is the outgoing root, so a readable subdirectory of an unreadable root is refused.
   */
  private async requireReadableRoot(root: string): Promise<void> {
    if (!nodePath.isAbsolute(root)) {
      throw new RepoRootResolutionError("vcs_error");
    }
    try {
      await this.deps.probeDirectoryReadable(root);
    } catch (thrown: unknown) {
      throw new RepoRootResolutionError(classifyFilesystemFailure(thrown));
    }
  }
}
