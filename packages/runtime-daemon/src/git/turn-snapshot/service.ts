// Turn-snapshot service: at each turn boundary, commits the project state of the checkout a run
// works in under `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`, and deletes one run's refs when
// the run is deleted. Nothing prunes by age. Capture reads no database (the caller supplies the
// epoch and the checkout).
//
// - Ref names are built from a validated `runId` before any git call: git's own refusal of
//   `../../heads/main` (2.50.1) would arrive as a swallowed capture failure.
// - Capture covers the whole checkout, never only a nested execution root: `ls-files` lists only
//   the folder it runs in. The supplied checkout is verified against the live tree first.
// - Captures of one checkout run one at a time, whichever session's run asks; runs never wait.
// - The capture's git steps live in `TurnSnapshotCaptureSteps`; this class orders them.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Database, Statement } from "better-sqlite3";
import {
  type TurnSnapshotCaptureStep,
  type TurnSnapshotDiagnostic,
  type TurnSnapshotRetentionSkipReason,
  warnDiagnostic,
} from "./diagnostics.js";
import { describeRejection } from "../../rejection.js";
import { DEFAULT_GIT_FILESYSTEM, type GitFilesystem } from "../filesystem.js";
import {
  isPathProvablyAbsent,
  parseSnapshotRefListing,
  type RunContextRow,
  RETENTION_WITHOUT_DATABASE_MESSAGE,
  type RunContextLookupParams,
} from "./retention.js";
import {
  buildRunSnapshotRefPrefix,
  buildTurnSnapshotRef,
  isNonNegativeInteger,
  isSafeRefComponent,
  USE_REPLACE_REFS_PIN,
} from "./refs.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGitWithExecFile,
  type GitCommand,
  type GitInvocationResult,
  type GitRunner,
} from "../process.js";
import {
  EXCLUDE_PER_DIRECTORY_GITIGNORE,
  SNAPSHOT_INDEX_SEGMENT,
  type SparseListingPartition,
} from "./capture.js";
import { requireObjectId, TurnSnapshotCaptureSteps } from "./capture-steps.js";
import { KeyedLock } from "../../keyed-lock.js";

/** Constructor dependencies of {@link TurnSnapshotService}. */
export interface TurnSnapshotServiceDeps {
  /** Absolute; holds the scratch-index directory. */
  readonly executionRootsDirectory: string;
  /**
   * Needed by the prune only. Without it `pruneSnapshotsForRun` throws `TypeError`, not "nothing
   * to prune".
   */
  readonly database?: Database;
  /**
   * Git process seam; defaults to `execFile` against `git`. Failure is by exit status alone:
   * `update-index` prints `Ignoring path nested/` and exits 0.
   */
  readonly git?: GitRunner;
  /** Filesystem seam for the scratch index's folder; defaults to `node:fs/promises`. */
  readonly filesystem?: Pick<GitFilesystem, "createDirectory" | "removePath">;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /**
   * The turn-boundary instant in `toISOString()` form. It becomes a fixed `+0000` commit date so
   * the OID never depends on the host timezone.
   */
  readonly now?: () => string;
  /** Defaults to `console.warn`; a sink that throws or rejects is contained. */
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
}

/** Inputs for {@link TurnSnapshotService.captureTurnSnapshot}; every field is caller-resolved. */
export interface CaptureTurnSnapshotInput {
  /** Where the run works: the worktree, or the bound folder in `bound-root` mode. */
  readonly executionRoot: string;
  /**
   * The top level of the working tree holding `executionRoot`, as the run's
   * `run_execution_contexts.checkout_root` records it. A value the live tree disagrees with fails
   * the capture.
   */
  readonly checkoutRoot: string;
  /** Validated as a ref component before any git call. */
  readonly runId: string;
  /** 0 before any rollback, advanced per accepted `run.rolled_back`; the caller supplies it. */
  readonly epoch: number;
  /** Non-negative integer. */
  readonly turnOrdinal: number;
}

/** A snapshot this call created. */
export interface TurnSnapshotCaptured {
  readonly outcome: "captured";
  readonly ref: string;
  /** The snapshot commit the ref now names. */
  readonly snapshotCommit: string;
  /** The one base OID resolved at entry: both the tree base and the recorded parent. */
  readonly baseCommit: string;
  /** Not recorded as gitlinks; repeated from the diagnostic so the caller can record them. */
  readonly skippedEmbeddedRepositories: readonly string[];
}

/** Why one run's prune stopped. */
interface TurnSnapshotRetentionSkip {
  readonly runId: string;
  readonly reason: TurnSnapshotRetentionSkipReason;
  readonly detail: string;
}

/** The create-only ref was already written: a retry or duplicate of the same turn. */
interface TurnSnapshotAlreadyCaptured {
  readonly outcome: "already-captured";
  readonly ref: string;
  /**
   * The OID read back off the ref, not the commit this call built: the first write wins. With a
   * writer that has repository access it need not be an OID this service recorded.
   */
  readonly snapshotCommit: string;
}

/** Capture did not complete; the turn boundary completes anyway. A report, not a retry signal. */
export interface TurnSnapshotCaptureFailed {
  readonly outcome: "failed";
  /** `null` when the inputs were refused before a ref could be built. */
  readonly ref: string | null;
  /** The detail travels on the diagnostic, not here. */
  readonly failedStep: TurnSnapshotCaptureStep;
}

/** Every outcome {@link TurnSnapshotService.captureTurnSnapshot} can report. */
export type TurnSnapshotCaptureResult =
  | TurnSnapshotCaptured
  | TurnSnapshotAlreadyCaptured
  | TurnSnapshotCaptureFailed;

/**
 * What one {@link TurnSnapshotService.pruneSnapshotsForRun} did. Flat, not a union: a prune can
 * delete four refs and then be refused on the fifth.
 */
export interface TurnSnapshotRetentionPruneResult {
  readonly runId: string;
  readonly deletedRefs: readonly string[];
  /** `null` when the prune completed; otherwise why it stopped. */
  readonly skipped: TurnSnapshotRetentionSkip | null;
}

/**
 * Owns the `refs/sidekicks/runs/...` namespace and every git invocation that writes into it. Keeps
 * nothing between calls but the lock that runs one capture of a checkout at a time.
 */
export class TurnSnapshotService {
  readonly #snapshotIndexDirectory: string;
  readonly #runGit: GitCommand;
  readonly #filesystem: Pick<GitFilesystem, "createDirectory" | "removePath">;
  readonly #now: () => string;
  readonly #emitDiagnostic: (diagnostic: TurnSnapshotDiagnostic) => void;
  // `null` without a `database` (capture-only wiring); prepared here so a schema mismatch fails
  // at construction.
  readonly #selectRunContextStmt: Statement<RunContextLookupParams, RunContextRow> | null;
  readonly #captureSteps: TurnSnapshotCaptureSteps;
  // Keyed by the symlink-resolved checkout, so every spelling of one tree takes one lock.
  readonly #checkoutLock = new KeyedLock<string>();

  constructor(deps: TurnSnapshotServiceDeps) {
    this.#snapshotIndexDirectory = join(deps.executionRootsDirectory, SNAPSHOT_INDEX_SEGMENT);
    this.#filesystem = deps.filesystem ?? DEFAULT_GIT_FILESYSTEM;
    this.#runGit = createGitCommand({
      git: deps.git ?? runGitWithExecFile,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#emitDiagnostic = deps.emitDiagnostic ?? warnDiagnostic;
    this.#captureSteps = new TurnSnapshotCaptureSteps({ runGit: this.#runGit, now: this.#now });

    const database: Database | undefined = deps.database;
    this.#selectRunContextStmt =
      database === undefined
        ? null
        : database.prepare<RunContextLookupParams, RunContextRow>(
            `SELECT run_id, git_common_dir
               FROM run_execution_contexts
              WHERE run_id = @run_id`,
          );
  }

  /**
   * Records the checkout's project state (tracked plus non-ignored untracked files) as a snapshot
   * commit at `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`. Never throws: every failure
   * becomes a typed `failed` result, because snapshots never gate a turn.
   */
  async captureTurnSnapshot(input: CaptureTurnSnapshotInput): Promise<TurnSnapshotCaptureResult> {
    if (
      !isSafeRefComponent(input.runId) ||
      !isNonNegativeInteger(input.epoch) ||
      !isNonNegativeInteger(input.turnOrdinal)
    ) {
      return this.#failCapture(input, null, "validate-inputs", "unusable ref components");
    }

    const ref: string = buildTurnSnapshotRef(input.runId, input.epoch, input.turnOrdinal);
    let checkoutRoot: string;
    try {
      checkoutRoot = await this.#verifyCheckoutRoot(input);
    } catch (reason: unknown) {
      return this.#failCapture(input, ref, "verify-checkout-root", describeRejection(reason));
    }
    return this.#checkoutLock.run(checkoutRoot, () =>
      this.#captureCheckout(input, checkoutRoot, ref),
    );
  }

  /**
   * The supplied checkout, symlink-resolved, once the live tree agrees: git names it as the top
   * level of the working tree holding the execution root. Throws when it does not.
   */
  async #verifyCheckoutRoot(input: CaptureTurnSnapshotInput): Promise<string> {
    const [suppliedCheckout, liveTopLevel] = await Promise.all([
      realpath(input.checkoutRoot),
      this.#runGit(["-C", input.executionRoot, "rev-parse", "--show-toplevel"]).then((result) =>
        realpath(result.stdout.toString("utf8").replace(/\n$/u, "")),
      ),
    ]);
    if (suppliedCheckout !== liveTopLevel) {
      throw new Error("the supplied checkout is not the working tree holding the execution root");
    }
    return suppliedCheckout;
  }

  // The capture's git legs, every one run at the top level of the verified checkout.
  async #captureCheckout(
    input: CaptureTurnSnapshotInput,
    checkoutRoot: string,
    ref: string,
  ): Promise<TurnSnapshotCaptureResult> {
    // A collision-free scratch filename, unlinked in the same call; not an id.
    const scratchIndexPath: string = join(this.#snapshotIndexDirectory, `${randomUUID()}.index`);
    // Advanced before each leg. It starts on the first `try` statement so an EACCES on the
    // execution-roots directory reports `prepare-scratch-index`, not `resolve-base`.
    let step: TurnSnapshotCaptureStep = "prepare-scratch-index";

    try {
      await this.#filesystem.createDirectory(this.#snapshotIndexDirectory);

      step = "resolve-base";
      const baseCommit: string = await this.#captureSteps.resolveBaseCommit(checkoutRoot);

      step = "detect-sparse-root";
      const isSparseRoot: boolean = await this.#captureSteps.detectSparseRoot(checkoutRoot);

      step = "seed-index";
      if (isSparseRoot) {
        // Copy the live index, not `read-tree <base>`: a read-tree index lacks skip-worktree bits,
        // so staging would re-stat each out-of-cone path, find it absent and drop it. The live
        // index also carries legitimate differences from `HEAD` (`git add --sparse`).
        await this.#captureSteps.seedScratchIndexFromLiveIndex(checkoutRoot, scratchIndexPath);
      } else {
        // Pinned: a replace ref on the base commit would seed from the replacement's tree and drop
        // a path that is both index-tracked and rule-ignored (measured against `add -A`).
        await this.#runGit(["-C", checkoutRoot, ...USE_REPLACE_REFS_PIN, "read-tree", baseCommit], {
          environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
        });
      }

      step = "list-paths";
      // `-c` re-lists the seeded base paths so `--add --remove` re-stats each one; `-o` adds
      // untracked files under in-tree `.gitignore` rules only.
      const fullListing: Buffer = (
        await this.#runGit(
          ["-C", checkoutRoot, "ls-files", "-co", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"],
          { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
        )
      ).stdout;

      step = "check-sparse-rules";
      // The identity partition (no git spawned) unless sparse, where git's own matcher decides.
      const partition: SparseListingPartition = isSparseRoot
        ? await this.#captureSteps.partitionListingByCone(checkoutRoot, fullListing)
        : { inConeListing: fullListing, outOfConeEntries: [] };
      const listing: Buffer = partition.inConeListing;

      step = "stage-paths";
      await this.#runGit(
        [
          "-C",
          checkoutRoot,
          // Pins for the one leg that hashes worktree bytes: a host `core.autocrlf` changes blob
          // ids, a host `core.safecrlf=true` fails staging on CRLF bytes under `*.txt text` (git
          // 2.50.1), and user/system attribute files must not steer conversion (in-tree
          // `.gitattributes` stays honored). `core.fileMode` is not pinned: true would replace each
          // tracked file's recorded mode with the lstat mode, since the scratch index carries no
          // stat data.
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.safecrlf=false",
          "-c",
          "core.attributesFile=/dev/null",
          "update-index",
          "--add",
          "--remove",
          "-z",
          "--stdin",
        ],
        {
          environmentOverrides: {
            GIT_INDEX_FILE: scratchIndexPath,
            GIT_ATTR_NOSYSTEM: "1",
          },
          stdin: listing,
        },
      );

      step = "normalize-embedded-repositories";
      const skippedEmbeddedRepositories: readonly string[] =
        await this.#captureSteps.normalizeEmbeddedRepositories(
          checkoutRoot,
          scratchIndexPath,
          listing,
        );

      step = "write-tree";
      const treeObjectId: string = requireObjectId(
        (
          await this.#runGit(["-C", checkoutRoot, "write-tree"], {
            environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
          })
        ).stdout,
      );

      // Read back from the tree just written: out-of-cone entries minus those the tree holds (the
      // live-index seed already carries ordinary skip-worktree entries). What remains are paths
      // `write-tree` omits: untracked and intent-to-add ones (git 2.50.1).
      const sparseBoundaryPaths: readonly string[] | null = isSparseRoot
        ? await this.#captureSteps.deriveSparseBoundaryPaths(
            checkoutRoot,
            treeObjectId,
            partition.outOfConeEntries,
          )
        : null;

      step = "commit-tree";
      const snapshotCommit: string = await this.#captureSteps.commitSnapshotTree(
        checkoutRoot,
        treeObjectId,
        baseCommit,
        skippedEmbeddedRepositories,
        sparseBoundaryPaths,
      );

      step = "write-ref";
      const recordedCommit: string | null = await this.#captureSteps.writeCreateOnlyRef(
        checkoutRoot,
        ref,
        snapshotCommit,
      );
      if (recordedCommit !== null) {
        return { outcome: "already-captured", ref, snapshotCommit: recordedCommit };
      }

      if (skippedEmbeddedRepositories.length > 0) {
        this.#emit({
          kind: "embedded-repositories-skipped",
          runId: input.runId,
          epoch: input.epoch,
          turnOrdinal: input.turnOrdinal,
          ref,
          skippedPaths: skippedEmbeddedRepositories,
        });
      }

      return {
        outcome: "captured",
        ref,
        snapshotCommit,
        baseCommit,
        skippedEmbeddedRepositories,
      };
    } catch (reason: unknown) {
      return this.#failCapture(input, ref, step, describeRejection(reason));
    } finally {
      // Never outlives the capture. Own try/catch: a rejection escaping a `finally` would replace
      // the typed result (an antivirus EPERM or EBUSY is enough), so a failed cleanup is reported.
      try {
        await this.#filesystem.removePath(scratchIndexPath);
      } catch (reason: unknown) {
        this.#emit({
          kind: "scratch-index-cleanup-failed",
          runId: input.runId,
          epoch: input.epoch,
          turnOrdinal: input.turnOrdinal,
          scratchIndexPath,
          detail: describeRejection(reason),
        });
      }
    }
  }

  /**
   * Deletes one run's snapshot refs; deleting the run calls it. Idempotent: a second call returns
   * empty `deletedRefs` with `skipped: null`. Never rejects on a runtime fault; throws a
   * `TypeError` when built without a `database`.
   */
  async pruneSnapshotsForRun(runId: string): Promise<TurnSnapshotRetentionPruneResult> {
    const selectRunContext = this.#selectRunContextStmt;
    if (selectRunContext === null) {
      throw new TypeError(RETENTION_WITHOUT_DATABASE_MESSAGE);
    }

    let row: RunContextRow | undefined;
    try {
      row = selectRunContext.get({ run_id: runId });
    } catch (reason: unknown) {
      // "Could not look" gets its own reason so a caller does not conclude the run has no context
      // and skip a needed retry.
      const detail: string = describeRejection(reason);
      this.#emit({ kind: "run-context-read-failed", detail, runId });
      return this.#skipPrune(runId, "run-context-unreadable", detail);
    }
    if (row === undefined) {
      // Not a fault: no context means no recorded git dir. A skip, so "found nothing" stays
      // distinct from "could not look".
      return this.#skipPrune(runId, "run-context-absent", "no run_execution_contexts row");
    }
    return this.#pruneRunRefs(runId, row.git_common_dir);
  }

  /**
   * The ref operations. It holds the `runId` check because it is the only path to git, so no id,
   * database-sourced ones included, reaches a ref path unvalidated.
   */
  async #pruneRunRefs(
    runId: string,
    gitCommonDir: string,
  ): Promise<TurnSnapshotRetentionPruneResult> {
    if (!isSafeRefComponent(runId)) {
      return this.#skipPrune(runId, "unsafe-run-id", "run id is not a safe ref path component");
    }
    const refPrefix: string = buildRunSnapshotRefPrefix(runId);

    // `--git-dir=<git_common_dir>`, not the execution root, which may be gone while its refs
    // remain. The trailing slash scopes the pattern to this run (`run-A/` misses `run-AB`, git
    // 2.50.1).
    let listing: GitInvocationResult;
    try {
      listing = await this.#runGit([
        `--git-dir=${gitCommonDir}`,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        refPrefix,
      ]);
    } catch (reason: unknown) {
      // A removed repository is a skip (`fatal: not a git repository`, exit 128), but the same
      // rejection covers faults (EACCES, missing `git`, hook directory failure). One `stat` on this
      // failure path decides, never stderr parsing, so the happy path pays nothing.
      return this.#skipPrune(
        runId,
        await this.#classifyGitDirFailure(gitCommonDir),
        describeRejection(reason),
      );
    }

    const deletedRefs: string[] = [];
    for (const entry of parseSnapshotRefListing(listing.stdout, refPrefix)) {
      try {
        // `--no-deref` guards deletion beside the prefix check: that judges the reported name,
        // `update-ref -d` acts on its target. A symref planted under the run namespace passes the
        // name check and the compare-and-swap (`for-each-ref` resolves it), so without the flag it
        // deletes `refs/heads/main` and reports a clean prune (git 2.50.1). With it the symref
        // goes.
        await this.#runGit([
          `--git-dir=${gitCommonDir}`,
          "update-ref",
          "--no-deref",
          "-d",
          entry.ref,
          entry.objectId,
        ]);
      } catch (reason: unknown) {
        // Stop at the first refusal: one run's refs share a lock domain, so continuing would spend
        // a doomed process per ref. Pruning is idempotent; deleted refs are still reported.
        return {
          runId,
          deletedRefs,
          skipped: {
            runId,
            reason: "ref-delete-failed",
            detail: `${entry.ref}: ${describeRejection(reason)}`,
          },
        };
      }
      deletedRefs.push(entry.ref);
    }
    return { runId, deletedRefs, skipped: null };
  }

  /** `git-dir-absent` only when provably gone, else `git-dir-unusable`, the arm to look at. */
  async #classifyGitDirFailure(gitCommonDir: string): Promise<TurnSnapshotRetentionSkipReason> {
    return (await isPathProvablyAbsent(gitCommonDir)) ? "git-dir-absent" : "git-dir-unusable";
  }

  /** A prune that deleted nothing, carrying why. */
  #skipPrune(
    runId: string,
    reason: TurnSnapshotRetentionSkipReason,
    detail: string,
  ): TurnSnapshotRetentionPruneResult {
    return { runId, deletedRefs: [], skipped: { runId, reason, detail } };
  }

  /** The one place a capture failure is reported: diagnostic, then typed result. */
  #failCapture(
    input: CaptureTurnSnapshotInput,
    ref: string | null,
    failedStep: TurnSnapshotCaptureStep,
    detail: string,
  ): TurnSnapshotCaptureFailed {
    this.#emit({
      kind: "capture-failed",
      runId: input.runId,
      epoch: input.epoch,
      turnOrdinal: input.turnOrdinal,
      ref,
      failedStep,
      detail,
    });
    return { outcome: "failed", ref, failedStep };
  }

  /**
   * Best-effort: a throwing sink must not become the turn-blocking failure capture exists to avoid.
   * The `try` catches a sync throw; `.catch` catches an `async` sink's rejection, which would
   * otherwise be unhandled and take the daemon down.
   */
  #emit(diagnostic: TurnSnapshotDiagnostic): void {
    try {
      void Promise.resolve(this.#emitDiagnostic(diagnostic)).catch(() => {
        // See the docblock: an async sink's rejection is swallowed as well.
      });
    } catch {
      // See the docblock: swallowed on purpose.
    }
  }
}
