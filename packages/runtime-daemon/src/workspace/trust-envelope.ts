// Trust-envelope containment validator: proves a `WorkspaceBind` execution root sits inside the
// local trust envelope (the canonical roots of the repo mounts attached on this machine).
//
// Every returned path was resolved by the filesystem, then proven component-contained in the
// mount's own root, which must itself be an attached root. Every refusal throws the argument-free
// `TrustEnvelopeViolationError` (fail closed; no path can reach the wire). Attach is not checked.
// - Resolve, then contain: the join skips `path.resolve`, which collapses `..` before symlinks.
// - The anchor is never re-resolved; comparing it as admitted can only refuse more.
// - Comparison is per path component, so `/repo-evil` is not inside `/repo`.
// - A vanished or detached mount also arrives as that error; callers check mount state first.
// - The guarantee is point-in-time; TOCTOU hardening belongs to the execution boundary.

import { opendir, realpath as realpathFromFilesystem } from "node:fs/promises";
import * as nodePath from "node:path";

import { TrustEnvelopeViolationError } from "./repo-errors.js";

/** One `WorkspaceBind` execution-root candidate; the caller supplies every root, so no lookups. */
export interface WorkspaceExecutionRootCandidate {
  /** Canonical root of the bind's repo mount: absolute, `realpath`-ed, used as given. */
  readonly mountCanonicalRoot: string;
  /**
   * `WorkspaceBindRequest.directory`, relative to the mount root; absent or empty binds the root.
   * A win32 driveless rooted form (`\evil`) is refused up front; `..` is left to the filesystem.
   */
  readonly directory?: string | undefined;
  /** The trust envelope: canonical roots of every attached repo mount; empty admits nothing. */
  readonly attachedMountRoots: readonly string[];
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

/** Constructor-injectable primitives; every member defaults to the real one. */
export interface TrustEnvelopeValidatorDeps {
  /**
   * Defaults to `node:fs/promises.realpath`, which returns on-disk spelling. The callback form
   * keeps the caller's spelling and collapses `..` before a symlink's target, reopening the escape;
   * `DEFAULT_REALPATH` is pinned by identity for that reason.
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
}

/** `path.win32.sep`. The discriminator for case-folded comparison and win32 path rules. */
export const WINDOWS_PATH_SEPARATOR = "\\";

/** The realpath used when no seam is injected; exported so a test can pin it by identity. */
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

function resolveDeps(partial: Partial<TrustEnvelopeValidatorDeps>): TrustEnvelopeValidatorDeps {
  return {
    realpath: partial.realpath ?? DEFAULT_REALPATH,
    probeDirectoryReadable: partial.probeDirectoryReadable ?? DEFAULT_DIRECTORY_READABILITY_PROBE,
    platformPath: partial.platformPath ?? nodePath,
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
 * Proves a `WorkspaceBind` execution root is inside the local trust envelope, or refuses the bind.
 * Stateless and uncached: a remembered verdict would outlive the symlink arrangement behind it.
 */
export class TrustEnvelopeValidator {
  private readonly deps: TrustEnvelopeValidatorDeps;

  public constructor(deps: Partial<TrustEnvelopeValidatorDeps> = {}) {
    this.deps = resolveDeps(deps);
  }

  /**
   * Resolves and validates one bind candidate, returning the resolved root, the only path safe to
   * persist or run in (never a rejoin of the request's `directory`).
   *
   * @throws {TrustEnvelopeViolationError} on every refusal.
   */
  public async validateExecutionRoot(candidate: WorkspaceExecutionRootCandidate): Promise<string> {
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

    if (!isContainedWithin(toComparableComponents(resolvedRoot, platformPath), anchorComponents)) {
      throw new TrustEnvelopeViolationError();
    }

    // A bare-root anchor (`C:\`, `/`) is one component that a degenerate resolved value (`C:`, ``)
    // also matches; only a broken seam produces one. The injected module keeps win32 tests valid.
    if (!platformPath.isAbsolute(resolvedRoot)) {
      throw new TrustEnvelopeViolationError();
    }

    // The root becomes `workspaces.fs_root` and nothing downstream re-asks, so a regular file
    // (`ENOTDIR`) or a `0111` directory (`EACCES`) must be refused here, after the other checks.
    try {
      await this.deps.probeDirectoryReadable(resolvedRoot);
    } catch {
      throw new TrustEnvelopeViolationError();
    }

    return resolvedRoot;
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
