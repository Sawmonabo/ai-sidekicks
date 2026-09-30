// Turn-snapshot service: at each turn boundary, commits the project state of a run's execution
// root under `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`, and deletes a run's refs once its
// retention window closes. Capture reads no database (the caller supplies the epoch).
//
// - Ref names are built from a validated `runId` before any git call: git's own refusal of
//   `../../heads/main` (2.50.1) would arrive as a swallowed capture failure.
// - The capture's git steps live in `TurnSnapshotCaptureSteps`; this class orders them.
// - Retention: nothing memoizes a pruned run, so each tick spawns `for-each-ref` for every
//   terminal run past its window (`LIMIT` would starve the rows behind the oldest).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database, Statement } from "better-sqlite3";
import type {
  CaptureTurnSnapshotInput,
  TurnSnapshotCaptureFailed,
  TurnSnapshotCaptureResult,
  TurnSnapshotCaptureStep,
  TurnSnapshotDiagnostic,
  TurnSnapshotFilesystem,
  TurnSnapshotGitInvocationResult,
  TurnSnapshotGitRunner,
  TurnSnapshotRetentionPruneResult,
  TurnSnapshotRetentionSkip,
  TurnSnapshotRetentionSkipReason,
  TurnSnapshotRetentionSweepResult,
  TurnSnapshotServiceDeps,
} from "./turn-snapshot-types.js";
import {
  DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS,
  isPathProvablyAbsent,
  MAXIMUM_RETENTION_WINDOW_MS,
  parseSnapshotRefListing,
  type PrunableRunRow,
  RETENTION_WITHOUT_DATABASE_MESSAGE,
  type RetentionCutoffParams,
  type RunContextLookupParams,
} from "./turn-snapshot-retention.js";
import {
  buildRunSnapshotRefPrefix,
  buildTurnSnapshotRef,
  DEFAULT_TURN_SNAPSHOT_FILESYSTEM,
  DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS,
  describeRejection,
  HOOK_NEUTRALIZATION_SEGMENT,
  isNonNegativeInteger,
  isSafeRefComponent,
  runTurnSnapshotGitWithExecFile,
  SNAPSHOT_INDEX_SEGMENT,
  USE_REPLACE_REFS_PIN,
  warnDiagnostic,
} from "./turn-snapshot-git.js";
import {
  EXCLUDE_PER_DIRECTORY_GITIGNORE,
  type SparseListingPartition,
} from "./turn-snapshot-capture.js";
import {
  requireObjectId,
  TurnSnapshotCaptureSteps,
  type TurnSnapshotGitCommandOptions,
} from "./turn-snapshot-capture-steps.js";

/**
 * Owns the `refs/sidekicks/runs/...` namespace and every git invocation that writes into it.
 * Stateless between calls: captures share only the (empty) hook-neutralization directory.
 */
export class TurnSnapshotService {
  readonly #hookNeutralizationDirectory: string;
  readonly #snapshotIndexDirectory: string;
  readonly #git: TurnSnapshotGitRunner;
  readonly #filesystem: TurnSnapshotFilesystem;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #emitDiagnostic: (diagnostic: TurnSnapshotDiagnostic) => void;
  readonly #retentionWindowMs: number;
  // `null` without a `database` (capture-only wiring); prepared here so a schema mismatch fails
  // at construction.
  readonly #selectPrunableRunsStmt: Statement<RetentionCutoffParams, PrunableRunRow> | null;
  readonly #selectRunContextStmt: Statement<RunContextLookupParams, PrunableRunRow> | null;
  readonly #captureSteps: TurnSnapshotCaptureSteps;

  constructor(deps: TurnSnapshotServiceDeps) {
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#snapshotIndexDirectory = join(deps.executionRootsDirectory, SNAPSHOT_INDEX_SEGMENT);
    this.#git = deps.git ?? runTurnSnapshotGitWithExecFile;
    this.#filesystem = deps.filesystem ?? DEFAULT_TURN_SNAPSHOT_FILESYSTEM;
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#emitDiagnostic = deps.emitDiagnostic ?? warnDiagnostic;
    this.#captureSteps = new TurnSnapshotCaptureSteps({
      runGit: (argv, options) => this.#runGit(argv, options),
      now: this.#now,
    });

    // Refuse a bad window at construction. Zero or negative would fail open (every terminal run
    // matches and the first sweep deletes snapshots meant to be kept); NaN, Infinity or a value
    // above the maximum make every cutoff unrepresentable.
    const retentionWindowMs: number =
      deps.retentionWindowMs ?? DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS;
    if (
      !Number.isFinite(retentionWindowMs) ||
      retentionWindowMs <= 0 ||
      retentionWindowMs > MAXIMUM_RETENTION_WINDOW_MS
    ) {
      throw new RangeError(
        "TurnSnapshotService: retentionWindowMs must be a positive finite number of " +
          `milliseconds no greater than ${String(MAXIMUM_RETENTION_WINDOW_MS)} ` +
          `(received ${String(retentionWindowMs)})`,
      );
    }
    this.#retentionWindowMs = retentionWindowMs;

    const database: Database | undefined = deps.database;
    if (database === undefined) {
      this.#selectPrunableRunsStmt = null;
      this.#selectRunContextStmt = null;
    } else {
      // Terminal runs only: a still-open run has NULL `released_at`. The TEXT comparison is
      // chronological because `released_at` is a fixed-width UTC ISO string; oldest release first,
      // `run_id` breaking ties.
      this.#selectPrunableRunsStmt = database.prepare<RetentionCutoffParams, PrunableRunRow>(
        `SELECT run_id, git_common_dir
           FROM run_execution_contexts
          WHERE released_at IS NOT NULL
            AND released_at <= @released_before
          ORDER BY released_at ASC, run_id ASC`,
      );

      // Not filtered by `released_at`: this backs `pruneSnapshotsForRun`, which ignores the window.
      this.#selectRunContextStmt = database.prepare<RunContextLookupParams, PrunableRunRow>(
        `SELECT run_id, git_common_dir
           FROM run_execution_contexts
          WHERE run_id = @run_id`,
      );
    }
  }

  /**
   * Records the execution root's project state (tracked plus non-ignored untracked files) as a
   * snapshot commit at `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`. Never throws: every
   * failure becomes a typed `failed` result, because snapshots never gate a turn.
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
    // A collision-free scratch filename, unlinked in the same call; not an id.
    const scratchIndexPath: string = join(this.#snapshotIndexDirectory, `${randomUUID()}.index`);
    // Advanced before each leg. It starts on the first `try` statement so an EACCES on the
    // execution-roots directory reports `prepare-scratch-index`, not `resolve-base`.
    let step: TurnSnapshotCaptureStep = "prepare-scratch-index";

    try {
      await this.#filesystem.createDirectory(this.#snapshotIndexDirectory);

      step = "resolve-base";
      const baseCommit: string = await this.#captureSteps.resolveBaseCommit(input.executionRoot);

      step = "detect-sparse-root";
      const isSparseRoot: boolean = await this.#captureSteps.detectSparseRoot(input.executionRoot);

      step = "seed-index";
      if (isSparseRoot) {
        // Copy the live index, not `read-tree <base>`: a read-tree index lacks skip-worktree bits,
        // so staging would re-stat each out-of-cone path, find it absent and drop it. The live
        // index also carries legitimate differences from `HEAD` (`git add --sparse`).
        await this.#captureSteps.seedScratchIndexFromLiveIndex(
          input.executionRoot,
          scratchIndexPath,
        );
      } else {
        // Pinned: a replace ref on the base commit would seed from the replacement's tree and drop
        // a path that is both index-tracked and rule-ignored (measured against `add -A`).
        await this.#runGit(
          ["-C", input.executionRoot, ...USE_REPLACE_REFS_PIN, "read-tree", baseCommit],
          {
            environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
          },
        );
      }

      step = "list-paths";
      // `-c` re-lists the seeded base paths so `--add --remove` re-stats each one; `-o` adds
      // untracked files under in-tree `.gitignore` rules only.
      const fullListing: Buffer = (
        await this.#runGit(
          ["-C", input.executionRoot, "ls-files", "-co", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"],
          { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
        )
      ).stdout;

      step = "check-sparse-rules";
      // The identity partition (no git spawned) unless sparse, where git's own matcher decides.
      const partition: SparseListingPartition = isSparseRoot
        ? await this.#captureSteps.partitionListingByCone(input.executionRoot, fullListing)
        : { inConeListing: fullListing, outOfConeEntries: [] };
      const listing: Buffer = partition.inConeListing;

      step = "stage-paths";
      await this.#runGit(
        [
          "-C",
          input.executionRoot,
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
          input.executionRoot,
          scratchIndexPath,
          listing,
        );

      step = "write-tree";
      const treeObjectId: string = requireObjectId(
        (
          await this.#runGit(["-C", input.executionRoot, "write-tree"], {
            environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
          })
        ).stdout,
      );

      // Read back from the tree just written: out-of-cone entries minus those the tree holds (the
      // live-index seed already carries ordinary skip-worktree entries). What remains are paths
      // `write-tree` omits: untracked and intent-to-add ones (git 2.50.1).
      const sparseBoundaryPaths: readonly string[] | null = isSparseRoot
        ? await this.#captureSteps.deriveSparseBoundaryPaths(
            input.executionRoot,
            treeObjectId,
            partition.outOfConeEntries,
          )
        : null;

      step = "commit-tree";
      const snapshotCommit: string = await this.#captureSteps.commitSnapshotTree(
        input.executionRoot,
        treeObjectId,
        baseCommit,
        skippedEmbeddedRepositories,
        sparseBoundaryPaths,
      );

      step = "write-ref";
      const recordedCommit: string | null = await this.#captureSteps.writeCreateOnlyRef(
        input.executionRoot,
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
   * Deletes the snapshot refs of every run whose retention window has closed, at startup and on a
   * timer. Never rejects on a runtime fault (nobody awaits the timer): failures become diagnostics
   * and skips in the result. Throws a `TypeError` when built without a `database`.
   */
  async sweepPrunableRuns(): Promise<TurnSnapshotRetentionSweepResult> {
    // Outside the `try`: a wiring defect must throw; the funnel swallows runtime faults only.
    const selectPrunableRuns = this.#selectPrunableRunsStmt;
    if (selectPrunableRuns === null) {
      throw new TypeError(RETENTION_WITHOUT_DATABASE_MESSAGE);
    }

    const examinedRunIds: string[] = [];
    const prunedRunIds: string[] = [];
    const deletedRefs: string[] = [];
    const skipped: TurnSnapshotRetentionSkip[] = [];

    try {
      const cutoff: string | null = this.#retentionCutoff();
      if (cutoff === null) {
        // `null` covers a bad clock and an out-of-range difference.
        throw new Error("turn-snapshot retention cutoff is not a representable instant");
      }
      const candidates: readonly PrunableRunRow[] = selectPrunableRuns.all({
        released_before: cutoff,
      });
      for (const candidate of candidates) {
        examinedRunIds.push(candidate.run_id);
        const outcome: TurnSnapshotRetentionPruneResult = await this.#pruneRunRefs(
          candidate.run_id,
          candidate.git_common_dir,
        );
        deletedRefs.push(...outcome.deletedRefs);
        if (outcome.skipped === null) {
          prunedRunIds.push(candidate.run_id);
        } else {
          skipped.push(outcome.skipped);
        }
      }
    } catch (reason: unknown) {
      // Covers the candidate read, the clock, and anything not already converted to a skip.
      this.#emit({ kind: "retention-sweep-failed", detail: describeRejection(reason) });
    } finally {
      // In a `finally` so a pass that failed halfway still enumerates the runs it skipped.
      if (skipped.length > 0) {
        this.#emit({
          kind: "retention-prune-skipped",
          skipped,
          examinedRunCount: examinedRunIds.length,
        });
      }
    }

    return { examinedRunIds, prunedRunIds, deletedRefs, skipped };
  }

  /**
   * Deletes one run's snapshot refs regardless of its retention window. Idempotent: a second call
   * returns empty `deletedRefs` with `skipped: null`. Never rejects on a runtime fault; throws the
   * sweep's `TypeError` when built without a `database`.
   */
  async pruneSnapshotsForRun(runId: string): Promise<TurnSnapshotRetentionPruneResult> {
    const selectRunContext = this.#selectRunContextStmt;
    if (selectRunContext === null) {
      throw new TypeError(RETENTION_WITHOUT_DATABASE_MESSAGE);
    }

    let row: PrunableRunRow | undefined;
    try {
      row = selectRunContext.get({ run_id: runId });
    } catch (reason: unknown) {
      // "Could not look" gets its own reason so a caller does not conclude the run has no context
      // and skip a needed retry; it is diagnosed like the sweep's candidate read.
      const detail: string = describeRejection(reason);
      // `runId` attributes this emission; the sweep's pass-scoped one omits it.
      this.#emit({ kind: "retention-sweep-failed", detail, runId });
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
   * The ref operations both entry points share. It holds the `runId` check because it is the only
   * path to git, so no id, database-sourced ones included, reaches a ref path unvalidated.
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
    let listing: TurnSnapshotGitInvocationResult;
    try {
      listing = await this.#runGit(
        [
          `--git-dir=${gitCommonDir}`,
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          refPrefix,
        ],
        {},
      );
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
        await this.#runGit(
          [
            `--git-dir=${gitCommonDir}`,
            "update-ref",
            "--no-deref",
            "-d",
            entry.ref,
            entry.objectId,
          ],
          {},
        );
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

  /**
   * `now - retentionWindow` in the ISO spelling `released_at` uses, or `null` when the clock is not
   * ISO-8601 or the result is outside Date's range (`getTime()` detects both; it agrees with
   * `toISOString()`'s own throw). `null`, not a throw, keeps it a reported sweep failure.
   */
  #retentionCutoff(): string | null {
    const cutoff = new Date(Date.parse(this.#now()) - this.#retentionWindowMs);
    if (Number.isNaN(cutoff.getTime())) {
      return null;
    }
    return cutoff.toISOString();
  }

  /**
   * The single git entry point. It prepends `core.hooksPath` at an empty directory and
   * `core.fsmonitor=false` and nothing else, so no invocation can run a hook.
   */
  async #runGit(
    argv: readonly string[],
    options: TurnSnapshotGitCommandOptions,
  ): Promise<TurnSnapshotGitInvocationResult> {
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(
      [
        "-c",
        `core.hooksPath=${this.#hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...argv,
      ],
      {
        timeoutMs: this.#gitCommandTimeoutMs,
        ...(options.environmentOverrides === undefined
          ? {}
          : { environmentOverrides: options.environmentOverrides }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      },
    );
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
