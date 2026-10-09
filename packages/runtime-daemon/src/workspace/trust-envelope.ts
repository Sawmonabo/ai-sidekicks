// Trust-envelope validator: proves a picked folder belongs to the repo mount a session binds, at
// the pick and never again. A mount's admitted roots are its canonical root, the working trees git
// lists for its repository (read at every pick, never cached), and the roots the daemon created,
// which are admitted by provenance whatever git's list says.
//
// Every returned path was resolved by the filesystem, then proven component-contained in an
// admitted root. Every refusal throws `TrustEnvelopeViolationError` with reason `outside_project`
// (fail closed; it takes no path, so none can reach the wire). Attach is not checked.
// - Resolve, then contain: the join skips `path.resolve`, which collapses `..` before symlinks.
// - The anchor is never re-resolved; comparing it as admitted can only refuse more.
// - Comparison is per path component, so `/repo-evil` is not inside `/repo`.
// - Containment is working-tree-boundary-aware: a folder counts by the working tree git says it
//   sits in, so a worktree nested beneath the canonical root admits only while git lists it.
// - A vanished or detached mount also arrives as that error; callers check mount state first.
// - The guarantee is point-in-time; TOCTOU hardening belongs to the execution boundary.

import { opendir, realpath as realpathFromFilesystem } from "node:fs/promises";
import * as nodePath from "node:path";

import { TrustEnvelopeViolationError } from "./repo/errors.js";
import type { WorkingTreeReader } from "./repo/root-resolver.js";

/** One picked folder; the caller supplies every root, so the validator looks nothing up. */
export interface WorkspaceExecutionRootCandidate {
  /** Canonical root of the bind's repo mount: absolute, `realpath`-ed, used as given. */
  readonly mountCanonicalRoot: string;
  /**
   * A path relative to the mount root, or an absolute one naming a listed working tree or a folder
   * inside one; absent or empty picks the root. A win32 driveless rooted form (`\evil`) is refused
   * up front; `..` is left to the filesystem.
   */
  readonly directory?: string | undefined;
  /** The trust envelope: canonical roots of every attached repo mount; empty admits nothing. */
  readonly attachedMountRoots: readonly string[];
  /** Roots the daemon created for this mount, admitted whatever git lists; absent admits none. */
  readonly provenanceRoots?: readonly string[] | undefined;
}

/** A folder the envelope admitted, both paths symlink-resolved. */
export interface AdmittedExecutionRoot {
  /** The picked folder itself. */
  readonly executionRoot: string;
  /** The top level of the working tree the folder sits in. */
  readonly checkoutRoot: string;
}

/** `fs.promises.realpath` seam. Rejects with a Node `ErrnoException`. */
export type PathRealpathResolver = (path: string) => Promise<string>;

/**
 * Can the daemon open this directory for enumeration? Rejects with an `ErrnoException` if not.
 * Declared here because the resolver imports it (the reverse edge would cycle); the resolver reads
 * `ENOENT` as absence of `.git`, so a stub must suit both uses.
 */
export type DirectoryReadabilityProbe = (path: string) => Promise<void>;

/**
 * The slice of `node:path` this module and the repo-root resolver read; `path.win32` satisfies it,
 * so POSIX CI drives the Windows branch.
 */
export interface PlatformPathModule {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  parse(path: string): { readonly root: string };
}

/** Constructor-injectable primitives; every member but `workingTrees` defaults to the real one. */
export interface TrustEnvelopeValidatorDeps {
  /**
   * Defaults to `node:fs/promises.realpath`, which returns on-disk spelling. The callback form
   * keeps the caller's spelling and collapses `..` before a symlink's target, reopening the escape.
   */
  readonly realpath: PathRealpathResolver;
  /**
   * Defaults to `DEFAULT_DIRECTORY_READABILITY_PROBE`. `opendir` rather than `access`, which checks
   * the real user ID. Injectable because paths such as `C:\Repos\App` or `/srv` exist on some
   * hosts only.
   */
  readonly probeDirectoryReadable: DirectoryReadabilityProbe;
  /**
   * Defaults to `node:path`; the suite injects `path.win32`. Unlike the resolver there is no
   * real-`node:path` backstop: a seam mismatch fails containment rather than loosening it.
   */
  readonly platformPath: PlatformPathModule;
  /** Asks git which working tree a folder sits in and which working trees a repository has. */
  readonly workingTrees: WorkingTreeReader;
}

/** `path.win32.sep`. The discriminator for case-folded comparison and win32 path rules. */
export const WINDOWS_PATH_SEPARATOR = "\\";

/** The realpath used when no seam is injected; the repo-root resolver defaults to it too. */
export const DEFAULT_REALPATH: PathRealpathResolver = realpathFromFilesystem;

/**
 * Opens and closes the directory, keeping nothing; the resolver defaults to the same binding. The
 * close is awaited so an unclosed `Dir` cannot hold a descriptor until garbage collection.
 */
export const DEFAULT_DIRECTORY_READABILITY_PROBE: DirectoryReadabilityProbe = async (
  path: string,
): Promise<void> => {
  const directoryHandle = await opendir(path);
  await directoryHandle.close();
};

/** The validator's seams: the git reader is required, every other one defaults to the real one. */
export type TrustEnvelopeValidatorOptions = Partial<
  Omit<TrustEnvelopeValidatorDeps, "workingTrees">
> &
  Pick<TrustEnvelopeValidatorDeps, "workingTrees">;

function resolveDeps(options: TrustEnvelopeValidatorOptions): TrustEnvelopeValidatorDeps {
  return {
    realpath: options.realpath ?? DEFAULT_REALPATH,
    probeDirectoryReadable: options.probeDirectoryReadable ?? DEFAULT_DIRECTORY_READABILITY_PROBE,
    platformPath: options.platformPath ?? nodePath,
    workingTrees: options.workingTrees,
  };
}

/**
 * Does the path name one complete location? Win32 `isAbsolute` also accepts a driveless
 * `\repos\foo`, which Windows completes against the daemon's current drive, so the verdict would
 * depend on ambient host state; a complete win32 root must parse longer than one character.
 */
export function namesCompleteLocation(
  candidatePath: string,
  platformPath: PlatformPathModule,
): boolean {
  if (!platformPath.isAbsolute(candidatePath)) {
    return false;
  }
  if (platformPath.sep !== WINDOWS_PATH_SEPARATOR) {
    return true;
  }
  return platformPath.parse(candidatePath).root.length > 1;
}

/** Drops trailing separators; the filesystem root collapses to the empty string. */
function stripTrailingSeparators(path: string, separator: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === separator) {
    end -= 1;
  }
  return path.slice(0, end);
}

/**
 * The comparable form of a path: its components, lower-cased only when the separator is win32's
 * (`toLowerCase`, never the locale form, which folds Turkish `I` wrongly). A case-insensitive
 * non-win32 filesystem such as APFS compares case-sensitively here, which can only refuse.
 */
export function toComparableComponents(
  path: string,
  platformPath: PlatformPathModule,
): readonly string[] {
  // Splitting on `sep` alone is deliberate: `realpath` normalizes separators, and a mixed one fails
  // containment rather than passing it.
  const components = stripTrailingSeparators(path, platformPath.sep).split(platformPath.sep);
  if (platformPath.sep !== WINDOWS_PATH_SEPARATOR) {
    return components;
  }
  // Unicode lower-casing is not NTFS's upcase table (`ẞ` and `ß` alias, `İ` folds to two code
  // points), and per-directory case sensitivity exists, so distinct NTFS names can alias here.
  return components.map((component) => component.toLowerCase());
}

/** Is `candidate` the anchor or beneath it? Component-wise, so `/repo-evil` is not in `/repo`. */
export function isContainedWithin(
  candidateComponents: readonly string[],
  anchorComponents: readonly string[],
): boolean {
  if (candidateComponents.length < anchorComponents.length) {
    return false;
  }
  for (let index = 0; index < anchorComponents.length; index += 1) {
    if (candidateComponents[index] !== anchorComponents[index]) {
      return false;
    }
  }
  return true;
}

/** Component equality — containment in both directions. */
export function componentsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isContainedWithin(left, right);
}

/**
 * Proves a picked folder is inside its mount's admitted roots, or refuses the pick. Stateless and
 * uncached: a remembered verdict would outlive the symlink arrangement or worktree list behind it.
 */
export class TrustEnvelopeValidator {
  private readonly deps: TrustEnvelopeValidatorDeps;

  public constructor(options: TrustEnvelopeValidatorOptions) {
    this.deps = resolveDeps(options);
  }

  /**
   * Resolves and validates one picked folder, returning it and its working tree's top level, the
   * only paths safe to persist or run in (never a rejoin of the request's `directory`).
   *
   * @throws {TrustEnvelopeViolationError} on every refusal; `RepoRootResolutionError` with
   * `vcs_error` when git cannot answer.
   */
  public async validateExecutionRoot(
    candidate: WorkspaceExecutionRootCandidate,
  ): Promise<AdmittedExecutionRoot> {
    const { platformPath } = this.deps;
    const anchor = candidate.mountCanonicalRoot;

    // A relative anchor would be completed against the daemon's working directory by the join.
    if (!platformPath.isAbsolute(anchor)) {
      throw new TrustEnvelopeViolationError();
    }

    // Admission: equality with an attached root, before the filesystem is touched.
    const anchorComponents = toComparableComponents(anchor, platformPath);
    const anchorIsAttachedMountRoot = candidate.attachedMountRoots.some(
      (envelopeRoot) =>
        platformPath.isAbsolute(envelopeRoot) &&
        componentsEqual(toComparableComponents(envelopeRoot, platformPath), anchorComponents),
    );
    if (!anchorIsAttachedMountRoot) {
      throw new TrustEnvelopeViolationError();
    }

    // Join without lexical normalization, so `..` reaches the filesystem intact.
    const spelledCandidate = this.joinCandidatePath(anchor, candidate.directory);

    // A path the filesystem will not resolve cannot be proven contained.
    let resolvedRoot: string;
    try {
      resolvedRoot = await this.deps.realpath(spelledCandidate);
    } catch {
      throw new TrustEnvelopeViolationError();
    }

    // A bare-root anchor (`C:\`, `/`) is one component that a degenerate resolved value (`C:`, ``)
    // also matches; only a broken seam produces one. The injected module keeps win32 tests valid.
    if (!platformPath.isAbsolute(resolvedRoot)) {
      throw new TrustEnvelopeViolationError();
    }

    const workingTree = await this.deps.workingTrees.readWorkingTreeRoot(resolvedRoot);
    const checkoutRoot =
      (await this.admitByProvenance(resolvedRoot, workingTree, candidate.provenanceRoots ?? [])) ??
      (await this.admitByWorkingTree(resolvedRoot, workingTree, anchorComponents, anchor));

    // The root becomes a workspace's bound root and nothing downstream re-asks, so a regular file
    // (`ENOTDIR`) or a `0111` directory (`EACCES`) must be refused here, after the other checks.
    try {
      await this.deps.probeDirectoryReadable(resolvedRoot);
    } catch {
      throw new TrustEnvelopeViolationError();
    }

    return { executionRoot: resolvedRoot, checkoutRoot };
  }

  /**
   * The folder's own working tree when a daemon-created root holds the folder, or that root when
   * git names no tree inside it; `null` when no such root holds the folder. Such a root stays
   * admitted after git stops listing it. A root that no longer resolves admits nothing.
   */
  private async admitByProvenance(
    resolvedRoot: string,
    workingTree: string | null,
    provenanceRoots: readonly string[],
  ): Promise<string | null> {
    const { platformPath } = this.deps;
    const resolvedComponents = toComparableComponents(resolvedRoot, platformPath);
    for (const provenanceRoot of provenanceRoots) {
      let resolvedProvenanceRoot: string;
      try {
        resolvedProvenanceRoot = await this.deps.realpath(provenanceRoot);
      } catch (error: unknown) {
        // A daemon root that is gone holds no folder; the next may hold this one. Any other
        // failure leaves the root unprovable, so the pick is refused.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw new TrustEnvelopeViolationError();
      }
      const provenanceComponents = toComparableComponents(resolvedProvenanceRoot, platformPath);
      if (!isContainedWithin(resolvedComponents, provenanceComponents)) {
        continue;
      }
      // A tree of its own inside the daemon root (a submodule, say) is the folder's checkout.
      if (workingTree !== null) {
        const treeComponents = toComparableComponents(workingTree, platformPath);
        if (
          isContainedWithin(resolvedComponents, treeComponents) &&
          isContainedWithin(treeComponents, provenanceComponents)
        ) {
          return workingTree;
        }
      }
      return resolvedProvenanceRoot;
    }
    return null;
  }

  /**
   * The working tree the folder sits in, when it is the mount's canonical root or a working tree
   * git lists for the mount's repository now; refuses otherwise.
   */
  private async admitByWorkingTree(
    resolvedRoot: string,
    checkoutRoot: string | null,
    anchorComponents: readonly string[],
    anchor: string,
  ): Promise<string> {
    const { platformPath, workingTrees } = this.deps;
    if (checkoutRoot === null) {
      throw new TrustEnvelopeViolationError();
    }
    const checkoutComponents = toComparableComponents(checkoutRoot, platformPath);
    const resolvedComponents = toComparableComponents(resolvedRoot, platformPath);
    if (!isContainedWithin(resolvedComponents, checkoutComponents)) {
      throw new TrustEnvelopeViolationError();
    }
    if (componentsEqual(checkoutComponents, anchorComponents)) {
      return checkoutRoot;
    }
    const listedWorkingTrees = await workingTrees.listWorkingTrees(anchor);
    const isListed = listedWorkingTrees.some((listedRoot) =>
      componentsEqual(toComparableComponents(listedRoot, platformPath), checkoutComponents),
    );
    if (!isListed) {
      throw new TrustEnvelopeViolationError();
    }
    return checkoutRoot;
  }

  /**
   * The anchor, the anchor plus a relative `directory`, or an absolute `directory` on its own.
   * Trailing separators are stripped from the anchor so `/` yields `/sub`, not `//sub`.
   *
   * @throws {TrustEnvelopeViolationError} for a win32 absolute `directory` that names no volume.
   */
  private joinCandidatePath(anchor: string, directory: string | undefined): string {
    if (directory === undefined || directory.length === 0) {
      return anchor;
    }
    const { platformPath } = this.deps;
    if (platformPath.isAbsolute(directory)) {
      if (!namesCompleteLocation(directory, platformPath)) {
        throw new TrustEnvelopeViolationError();
      }
      return directory;
    }
    return `${stripTrailingSeparators(anchor, platformPath.sep)}${platformPath.sep}${directory}`;
  }
}
