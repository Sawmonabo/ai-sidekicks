// The git steps of one turn-snapshot capture: resolve the base, seed and partition the scratch
// index, record embedded repositories, commit the tree and write its ref. The service orders them
// and turns a throw into the failed step.
//
// - A duplicate capture whose worktree changed leaves an unreferenced tree and commit for gc.
// - Host git config, measured on git 2.50.1: `core.ignorecase` and `core.precomposeUnicode` state
//   the filesystem and `core.fileMode` matches porcelain `add -A`, so they stay unpinned (a stale
//   `false` loses an exec bit). Inert on these legs: `core.eol`, `core.symlinks`,
//   `core.untrackedCache`, `core.excludesFile`, `core.checkRoundtripEncoding`, and the stat family
//   (a bare `read-tree` seed has no stat data; the sparse arm seeds from the live index, which
//   does). Residual with no closed pin set: `filter.<name>.smudge|clean|required`.
// - No pin restores skip-worktree bits on a `read-tree <base>` seed (`-c core.sparseCheckout=`
//   `false` and `--no-sparse-checkout` lose out-of-cone paths alike), so a sparse root seeds from
//   a copy of the live index.

import type { FileHandle } from "node:fs/promises";
import { copyFile, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TurnSnapshotGitInvocationResult } from "./turn-snapshot-types.js";
import { OBJECT_ID_PATTERN } from "./turn-snapshot-retention.js";
import { describeRejection, USE_REPLACE_REFS_PIN } from "./turn-snapshot-git.js";
import {
  CORE_SPARSE_CHECKOUT_KEY,
  GITLINK_TREE_MODE,
  joinNulTerminatedListing,
  listingEntryKey,
  requireObjectIdHexLength,
  SKIPPED_EMBEDDED_REPOSITORIES_TRAILER,
  SNAPSHOT_COMMIT_MESSAGE,
  SNAPSHOT_IDENTITY_EMAIL,
  SNAPSHOT_IDENTITY_NAME,
  SPARSE_BOUNDARY_PATHS_TRAILER,
  SPARSE_SEED_INDEX_LOCK_ATTEMPTS,
  SPARSE_SEED_INDEX_LOCK_RETRY_DELAY_MS,
  type SparseListingPartition,
  splitNulTerminatedListing,
  splitNulTerminatedListingBytes,
  toRawGitDate,
} from "./turn-snapshot-capture.js";

/** Per-call options of a capture step's git command: index and attribute overrides, and stdin. */
export interface TurnSnapshotGitCommandOptions {
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  readonly stdin?: Buffer;
}

/**
 * Runs one git command through the service's hook-neutralized entry point, which prepends the
 * `-c` pins that keep any hook from running.
 */
export type TurnSnapshotGitCommand = (
  argv: readonly string[],
  options: TurnSnapshotGitCommandOptions,
) => Promise<TurnSnapshotGitInvocationResult>;

/** What the capture steps take from the service: its git entry point and its clock. */
export interface TurnSnapshotCaptureStepsDependencies {
  readonly runGit: TurnSnapshotGitCommand;
  readonly now: () => string;
}

/** See {@link OBJECT_ID_PATTERN}. Throws into the funnel on anything else. */
export function requireObjectId(stdout: Buffer): string {
  const candidate: string = stdout.toString("utf8").trim();
  if (!OBJECT_ID_PATTERN.test(candidate)) {
    throw new Error("git did not report an object id");
  }
  return candidate;
}

/**
 * The git steps a capture runs, each throwing into the service's funnel on failure. Stateless
 * between calls; built once per service.
 */
export class TurnSnapshotCaptureSteps {
  readonly #runGit: TurnSnapshotGitCommand;
  readonly #now: () => string;

  constructor(dependencies: TurnSnapshotCaptureStepsDependencies) {
    this.#runGit = dependencies.runGit;
    this.#now = dependencies.now;
  }

  /**
   * Resolves `HEAD` once; the id is both the tree base and the recorded parent, so a branch moving
   * mid-capture cannot pair an old tree with a new parent. An unborn `HEAD` fails as
   * `resolve-base`.
   */
  async resolveBaseCommit(executionRoot: string): Promise<string> {
    // `--verify` prints nothing on a miss; the bare form echoes `HEAD` with a non-zero exit.
    const result = await this.#runGit(["-C", executionRoot, "rev-parse", "--verify", "HEAD"], {});
    return requireObjectId(result.stdout);
  }

  /**
   * Whether the root is sparse, read from `core.sparseCheckout` alone (what git consults before
   * skip-worktree). A rules file without the bit fails the matcher (exit 128), so capture fails
   * closed as `check-sparse-rules`. Read per root, not per mode: a worktree inherits sparseness.
   */
  async detectSparseRoot(executionRoot: string): Promise<boolean> {
    // `--default=false` makes an unset key a clean false; a bare `--get` exits 1 (unset) or 128
    // (unreadable), which the exit-status-only git seam cannot tell apart.
    const result = await this.#runGit(
      [
        "-C",
        executionRoot,
        "config",
        "--type=bool",
        "--default=false",
        "--get",
        CORE_SPARSE_CHECKOUT_KEY,
      ],
      {},
    );
    return result.stdout.toString("utf8").trim() === "true";
  }

  /**
   * Copies the live index to the scratch index while holding git's `<index>.lock` (created
   * exclusively; a lock this leg did not create is never removed), so no torn index is read and the
   * live index is never replaced. Contention gets a short fixed retry, then a `seed-index` failure.
   */
  async seedScratchIndexFromLiveIndex(
    executionRoot: string,
    scratchIndexPath: string,
  ): Promise<void> {
    // Not `<root>/.git/index`: a linked worktree keeps its index under the main git dir. Git
    // answers relative for a main checkout and absolute for a linked one (git 2.50.1).
    const reportedIndexPath: string = (
      await this.#runGit(["-C", executionRoot, "rev-parse", "--git-path", "index"], {})
    ).stdout
      .toString("utf8")
      .trim();
    if (reportedIndexPath === "") {
      throw new Error("git did not report an index path for the execution root");
    }
    const liveIndexPath: string = isAbsolute(reportedIndexPath)
      ? reportedIndexPath
      : join(executionRoot, reportedIndexPath);
    const lockPath = `${liveIndexPath}.lock`;

    let lockHandle: FileHandle | null = null;
    for (let attempt = 0; attempt < SPARSE_SEED_INDEX_LOCK_ATTEMPTS; attempt += 1) {
      try {
        lockHandle = await open(lockPath, "wx");
        break;
      } catch (reason: unknown) {
        // Only EEXIST is contention; retrying any other fault would only delay the turn boundary.
        if ((reason as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
          throw reason;
        }
        if (attempt === SPARSE_SEED_INDEX_LOCK_ATTEMPTS - 1) {
          throw new Error(
            "turn-snapshot could not acquire the repository index lock to seed the scratch index",
            { cause: reason },
          );
        }
        await delay(SPARSE_SEED_INDEX_LOCK_RETRY_DELAY_MS);
      }
    }
    if (lockHandle === null) {
      throw new Error("turn-snapshot could not acquire the repository index lock");
    }
    try {
      await copyFile(liveIndexPath, scratchIndexPath);
    } finally {
      // Release, never commit. Own `try` so a failed close cannot strand the lock and block every
      // git command in the user's repository.
      try {
        await lockHandle.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }

  /**
   * Returns the keys ({@link listingEntryKey}) of `candidates` that git's live sparse rules
   * consider in cone. Any rejection propagates (fail closed), even for an empty candidate set.
   */
  async #scoreInConeKeys(
    executionRoot: string,
    candidates: readonly Buffer[],
  ): Promise<ReadonlySet<string>> {
    // Live-rules `check-rules`, not the gitignore machinery: with `/*` plus `!/a/b/`,
    // `--exclude-per-directory` scores `a/b/deep.txt` includable, the cone does not (git 2.50.1).
    // `-z` echoes input bytes verbatim whatever `core.quotePath` says, so keys are byte-exact.
    const matcherOutput: Buffer = (
      await this.#runGit(["-C", executionRoot, "sparse-checkout", "check-rules", "-z"], {
        stdin: joinNulTerminatedListing(candidates),
      })
    ).stdout;
    return new Set<string>(splitNulTerminatedListingBytes(matcherOutput).map(listingEntryKey));
  }

  /**
   * Splits a `-z` listing into the in-cone staging stream and the out-of-cone entries, all as the
   * listing's own byte slices. A matcher rejection surfaces as `check-sparse-rules`; it never
   * degrades to staging the unpartitioned listing, which loses out-of-cone content.
   */
  async partitionListingByCone(
    executionRoot: string,
    listing: Buffer,
  ): Promise<SparseListingPartition> {
    // The trailing slash stays: it is the only record that git refused to descend into an entry.
    // `index.sparse=true` makes `ls-files` print an expansion advisory on stderr, which no leg
    // reads.
    const entries: readonly Buffer[] = splitNulTerminatedListingBytes(listing);
    const inConeKeys: ReadonlySet<string> = await this.#scoreInConeKeys(executionRoot, entries);

    const inConeEntries: Buffer[] = [];
    const outOfConeEntries: Buffer[] = [];
    for (const entry of entries) {
      (inConeKeys.has(listingEntryKey(entry)) ? inConeEntries : outOfConeEntries).push(entry);
    }
    return { inConeListing: joinNulTerminatedListing(inConeEntries), outOfConeEntries };
  }

  /**
   * The out-of-cone paths the snapshot tree does not hold: the tree read back with
   * `ls-tree -r --name-only -z`, subtracted from the out-of-cone entries by {@link
   * listingEntryKey}.
   */
  async deriveSparseBoundaryPaths(
    executionRoot: string,
    treeObjectId: string,
    outOfConeEntries: readonly Buffer[],
  ): Promise<readonly string[]> {
    // Replace refs pinned off: a changed path set would change the trailer, an input to the id.
    const treeListing: Buffer = (
      await this.#runGit(
        [
          "-C",
          executionRoot,
          ...USE_REPLACE_REFS_PIN,
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          treeObjectId,
        ],
        {},
      )
    ).stdout;
    const recordedKeys = new Set<string>(
      splitNulTerminatedListingBytes(treeListing).map(listingEntryKey),
    );
    // Byte-exact keys: decoded names would map distinct invalid-UTF-8 paths to one string and
    // subtract a boundary path away. `latin1` keys survive JSON and the UTF-8 message unchanged.
    return outOfConeEntries.map(listingEntryKey).filter((entryKey) => !recordedKeys.has(entryKey));
  }

  /**
   * Re-records each untracked embedded repository (a trailing-slash entry `update-index --add`
   * silently drops) as a `160000` gitlink, as `git add -A` does; one with no insertable `HEAD` id
   * (no commits, or another object format) is skipped and returned.
   */
  async normalizeEmbeddedRepositories(
    executionRoot: string,
    scratchIndexPath: string,
    listing: Buffer,
  ): Promise<readonly string[]> {
    const skipped: string[] = [];
    let superprojectObjectIdLength: number | null = null;
    for (const entry of splitNulTerminatedListing(listing)) {
      if (!entry.endsWith("/")) {
        continue;
      }
      const embeddedPath: string = entry.slice(0, -1);
      const embeddedRoot: string = join(executionRoot, embeddedPath);
      let headStdout: Buffer;
      try {
        headStdout = (await this.#runGit(["-C", embeddedRoot, "rev-parse", "--verify", "HEAD"], {}))
          .stdout;
      } catch {
        // Only a git refusal reaches here; transient rejections are skipped too (the seam is
        // opaque).
        skipped.push(embeddedPath);
        continue;
      }
      // Outside the catch on purpose: git exited zero, so a non-id answer is a fault that throws
      // into the funnel, not a skip.
      const embeddedHead: string = requireObjectId(headStdout);
      // Resolved lazily and once (most listings have no such entry). A failure here fails the
      // capture; only a disagreeing format is a skip. A predicate, not a wider catch: a SHA-1 id
      // offered to a SHA-256 index exits 129 in `--cacheinfo` (git 2.50.1), and a catch would hide
      // I/O errors.
      if (superprojectObjectIdLength === null) {
        superprojectObjectIdLength = requireObjectIdHexLength(
          (await this.#runGit(["-C", executionRoot, "rev-parse", "--show-object-format"], {}))
            .stdout,
        );
      }
      if (embeddedHead.length !== superprojectObjectIdLength) {
        skipped.push(embeddedPath);
        continue;
      }
      // A direct index insert of the gitlink, as porcelain staging writes; git records it although
      // the object lives in the embedded repository's store (git 2.50.1).
      await this.#runGit(
        [
          "-C",
          executionRoot,
          "update-index",
          "--add",
          "--cacheinfo",
          `${GITLINK_TREE_MODE},${embeddedHead},${embeddedPath}`,
        ],
        { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
      );
    }
    return skipped;
  }

  /**
   * Runs `commit-tree` under the encoding pin and six identity and date variables, so the id
   * depends only on project state and the turn-boundary instant. Capture-time facts that cannot be
   * re-derived (skipped embedded repositories, sparse boundary paths) ride as message trailers.
   */
  async commitSnapshotTree(
    executionRoot: string,
    treeObjectId: string,
    baseCommit: string,
    skippedEmbeddedRepositories: readonly string[],
    sparseBoundaryPaths: readonly string[] | null,
  ): Promise<string> {
    const stampedDate: string | null = toRawGitDate(this.#now());
    if (stampedDate === null) {
      throw new Error("turn-snapshot clock did not return an ISO-8601 instant");
    }
    // Trailer order is message bytes: skip list first (only when non-empty), sparse set second
    // (whenever sparse; `null` means not sparse). Both sorted for a stable id; the `latin1` sparse
    // keys sort by byte.
    const paragraphs: string[] = [SNAPSHOT_COMMIT_MESSAGE];
    if (skippedEmbeddedRepositories.length > 0) {
      paragraphs.push(
        `${SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} ${JSON.stringify(
          [...skippedEmbeddedRepositories].sort(),
        )}`,
      );
    }
    if (sparseBoundaryPaths !== null) {
      paragraphs.push(
        `${SPARSE_BOUNDARY_PATHS_TRAILER} ${JSON.stringify([...sparseBoundaryPaths].sort())}`,
      );
    }
    // `i18n.commitEncoding=utf-8` because a host setting adds an `encoding` header. The dates are
    // commit fields too, so identity alone would leak the host timezone into every id.
    const result = await this.#runGit(
      [
        "-C",
        executionRoot,
        "-c",
        "i18n.commitEncoding=utf-8",
        "commit-tree",
        treeObjectId,
        "-p",
        baseCommit,
        "-F",
        "-",
      ],
      {
        environmentOverrides: {
          GIT_AUTHOR_NAME: SNAPSHOT_IDENTITY_NAME,
          GIT_AUTHOR_EMAIL: SNAPSHOT_IDENTITY_EMAIL,
          GIT_AUTHOR_DATE: stampedDate,
          GIT_COMMITTER_NAME: SNAPSHOT_IDENTITY_NAME,
          GIT_COMMITTER_EMAIL: SNAPSHOT_IDENTITY_EMAIL,
          GIT_COMMITTER_DATE: stampedDate,
        },
        // Over stdin, not `-m`: the sparse trailer is unbounded and argv is not. Byte-equivalent to
        // `-m` (git 2.50.1) with `\n\n` between paragraphs and a final `\n`, without which the id
        // differs. The seam closes stdin, so `-F -` cannot hang.
        stdin: Buffer.from(`${paragraphs.join("\n\n")}\n`, "utf8"),
      },
    );
    return requireObjectId(result.stdout);
  }

  /**
   * The create-only ref write. Returns `null` when this call wrote the ref, or the recorded id when
   * the compare-and-swap found one already there. Any other failure propagates to the funnel.
   */
  async writeCreateOnlyRef(
    executionRoot: string,
    ref: string,
    snapshotCommit: string,
  ): Promise<string | null> {
    try {
      // The empty old-value makes this a compare-and-swap against absence. `--no-deref` keeps the
      // check on the validated name: without it a planted dangling symref makes git write its
      // referent outside the namespace and exit 0 (git 2.50.1, 2.54.0). With it, 2.50.1 replaces
      // the symref and 2.54.0 refuses (fails closed at `write-ref`); a live referent refuses on
      // both, and the id read back through it is reported as found, not as written by this service.
      await this.#runGit(
        ["-C", executionRoot, "update-ref", "--no-deref", ref, snapshotCommit, ""],
        {},
      );
      return null;
    } catch (reason: unknown) {
      // The probe reads the ref, not git's stderr, and runs only after the swap refuses, so a
      // concurrent loser reads the winner's id.
      const recorded: string | null = await this.#readRefIfPresent(executionRoot, ref);
      if (recorded !== null) {
        return recorded;
      }
      throw reason instanceof Error ? reason : new Error(describeRejection(reason));
    }
  }

  /**
   * The recorded OID, or `null` when the ref does not resolve. A failed read also gives `null`: the
   * only caller then rethrows the swap's own refusal, so no failure is lost.
   */
  async #readRefIfPresent(executionRoot: string, ref: string): Promise<string | null> {
    try {
      // `--verify` on a fully-qualified ref: no abbreviation, no search path, no echo on a miss.
      const result = await this.#runGit(
        ["-C", executionRoot, "show-ref", "--verify", "--hash", ref],
        {},
      );
      return requireObjectId(result.stdout);
    } catch {
      return null;
    }
  }
}
