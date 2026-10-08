// Canonical repo-root resolver: turns a user-entered local path into the `{canonicalRoot, vcsType}`
// pair persisted on a repo mount.
//
//   * Every returned root went through `realpath`, and git's answer is verified, not trusted.
//   * Anything but a successful resolution throws `RepoRootResolutionError`: no fallback to the
//     input and no root completed from daemon state (working directory, home directory, drive).
//   * `not_a_git_repository` needs git's verdict and no `<supplied>/.git` entry; every other git
//     failure is `vcs_error`. Git is asked rather than walking up for `.git`, which is a file in
//     linked worktrees and submodules.
//   * A repository's own config can carry `core.worktree` (reachable through `git init
//     --separate-git-dir`), so git can report a sibling or an ancestor as the toplevel; the same
//     key injected through env or `git -c` did not move it (git 2.50.1). Steps 4 and 5 refuse both
//     with `root_mismatch`, so a dotfiles-style layout whose config points elsewhere is refused.

import * as nodePath from "node:path";

import type { VcsType } from "@ai-sidekicks/contracts/repo/mount";

import { runGitWithExecFile, type GitRunner } from "../../git/process.js";
import { isMissingFileError } from "../../file/missing-error.js";
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

/** The only value attach may persist: an absolute, symlink-resolved root that was readable. */
export interface RepoRootResolution {
  readonly canonicalRoot: string;
  readonly vcsType: VcsType;
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
   * step-4 comparison casing-safe. The callback `fs.realpath` keeps the caller's casing, so a
   * mis-cased attach would be refused `root_mismatch`. Native caveats, none load-bearing: musl
   * Linux needs `/proc`, and Windows drive-letter casing varies.
   */
  readonly realpath: PathRealpathResolver;
  /**
   * Defaults to the probe `trust-envelope.ts` shares, so attach-time and bind-time answers agree.
   * `finish` reads a rejection as unreadable; `hasVisibleGitMetadata` reads only `ENOENT` as none.
   * An admission check made once; a root that becomes unreadable later is not a resolution failure.
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

/** Milliseconds allowed for one `rev-parse` (a network mount can hang); a kill is `vcs_error`. */
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
function classifyRealpathFailure(thrown: unknown): "path_not_found" | "not_readable" {
  const errnoCode = readProperty(thrown, "code");
  if (errnoCode === "ENOENT" || errnoCode === "ENOTDIR" || errnoCode === "ENAMETOOLONG") {
    return "path_not_found";
  }
  return "not_readable";
}

/**
 * `"not-a-repository"` only on git's positive verdict (not killed, no signal, exit 128, anchored
 * stderr wording); everything else is `"abnormal"`, since calling a broken invocation "not a
 * repository" sends the person to fix the wrong thing. Damaged `.git` metadata also produces the
 * genuine wording; `resolveCanonicalRoot` cross-checks that.
 */
function classifyGitFailure(thrown: unknown): "not-a-repository" | "abnormal" {
  if (readProperty(thrown, "killed") === true) {
    return "abnormal";
  }
  const signal = readProperty(thrown, "signal");
  if (typeof signal === "string" && signal.length > 0) {
    return "abnormal";
  }
  if (readProperty(thrown, "code") !== GIT_FATAL_EXIT_CODE) {
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
function stripSingleLineTerminator(output: string, platformPath: PlatformPathModule): string {
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

/** Resolves a user-entered path to its canonical root, or throws. Never cached (`git init`). */
export class RepoRootResolver {
  private readonly deps: RepoRootResolverDeps;

  public constructor(deps: Partial<RepoRootResolverDeps> = {}) {
    this.deps = resolveDeps(deps);
  }

  /**
   * The path must name one complete location: absolute on POSIX, absolute and volume-naming on
   * Windows. The returned root is verified against git's answer (steps 4 and 5), not just reported.
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

    // Step 2: canonicalize, so git never sees a symlink alias. Traversable is not readable;
    // `finish` proves the latter.
    const canonicalInputPath = await this.realpathOrThrow(localPath, classifyRealpathFailure);

    // Step 3: ask git; the answer may be an ancestor of the input (nested-subdirectory attach).
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
      throw new RepoRootResolutionError("not_a_git_repository");
    }
    const canonicalRoot = discovery.canonicalRoot;
    // Real `node:path` below, never the injected seam. Both operands are `realpath` output, so no
    // case folding: it would let a redirected toplevel pass against a case-colliding sibling.
    const canonicalRootComponents = toComparableComponents(canonicalRoot, nodePath);

    // Step 4, containment: the supplied path must sit inside the reported root. Cheap and first,
    // so a bad root is never handed to git as the `-C` argument of the verification spawn.
    if (
      !isContainedWithin(
        toComparableComponents(canonicalInputPath, nodePath),
        canonicalRootComponents,
      )
    ) {
      throw new RepoRootResolutionError("root_mismatch");
    }

    // Step 5, fixpoint: containment passes for an ancestor, so the root must report itself when
    // discovery starts there. A not-a-repository verdict here is `root_mismatch`.
    const verification = await this.queryCanonicalToplevel(canonicalRoot);
    if (
      verification.kind === "not-a-repository" ||
      !componentsEqual(
        toComparableComponents(verification.canonicalRoot, nodePath),
        canonicalRootComponents,
      )
    ) {
      throw new RepoRootResolutionError("root_mismatch");
    }

    return this.finish(canonicalRoot);
  }

  /**
   * One `rev-parse --show-toplevel` query. Discovery and verification share it, so verification
   * cannot run under a weaker environment. Throws `vcs_error` for everything but a usable toplevel
   * or the positive verdict, including a driveless toplevel and one `realpath` cannot resolve.
   */
  private async queryCanonicalToplevel(directory: string): Promise<ToplevelQueryOutcome> {
    let toplevelOutput: string;
    try {
      const result = await this.deps.git(["-C", directory, "rev-parse", "--show-toplevel"], {
        timeoutMs: this.deps.gitCommandTimeoutMs,
      });
      toplevelOutput = result.stdout.toString("utf8");
    } catch (thrown: unknown) {
      if (classifyGitFailure(thrown) === "not-a-repository") {
        return { kind: "not-a-repository" };
      }
      throw new RepoRootResolutionError("vcs_error");
    }

    const reportedToplevel = stripSingleLineTerminator(toplevelOutput, this.deps.platformPath);
    if (reportedToplevel.length === 0 || !namesCompleteLocation(reportedToplevel, nodePath)) {
      throw new RepoRootResolutionError("vcs_error");
    }

    // An unresolvable toplevel is a VCS-query anomaly, not a bad user path.
    return {
      kind: "toplevel",
      canonicalRoot: await this.realpathOrThrow(reportedToplevel, () => "vcs_error"),
    };
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

  /**
   * The last gate before a root escapes: absolute (real `node:path`) and openable for enumeration.
   * `realpath` proves only traversal (a mode-0111 root passes and git answers normally), and the
   * probed value is the outgoing root, so a readable subdirectory of an unreadable root is refused.
   */
  private async finish(canonicalRoot: string): Promise<RepoRootResolution> {
    if (!nodePath.isAbsolute(canonicalRoot)) {
      throw new RepoRootResolutionError("vcs_error");
    }
    try {
      await this.deps.probeDirectoryReadable(canonicalRoot);
    } catch (thrown: unknown) {
      throw new RepoRootResolutionError(classifyRealpathFailure(thrown));
    }
    return { canonicalRoot, vcsType: "git" };
  }
}
