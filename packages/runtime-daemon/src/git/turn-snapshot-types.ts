/**
 * The shapes a turn snapshot service takes and returns: injected git and filesystem seams,
 * diagnostics, and the capture and retention results.
 */

import type { Database } from "better-sqlite3";

import type { GitRunner } from "./git-process.js";

/**
 * The filesystem-mutation seam; both verbs are idempotent, so cleanup in a `finally` cannot turn a
 * capture failure into a second one.
 */
export interface TurnSnapshotFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
}

/**
 * The capture steps in order, named on the failure result. `detect-sparse-root` and
 * `check-sparse-rules` (matcher failed, or git older than 2.41) fail closed, never non-sparse.
 */
export type TurnSnapshotCaptureStep =
  | "validate-inputs"
  | "prepare-scratch-index"
  | "resolve-base"
  | "detect-sparse-root"
  | "seed-index"
  | "list-paths"
  | "check-sparse-rules"
  | "stage-paths"
  | "normalize-embedded-repositories"
  | "write-tree"
  | "commit-tree"
  | "write-ref";

/** Why one run's snapshot refs were not pruned. */
export type TurnSnapshotRetentionSkipReason =
  | "unsafe-run-id"
  | "run-context-absent"
  /** The row read failed (closed handle, schema fault); unlike absent, retry the prune. */
  | "run-context-unreadable"
  /** The recorded `git_common_dir` is gone (repository removed). */
  | "git-dir-absent"
  /** The recorded dir exists but enumeration failed: permissions, bad store, no `git`/hook dir. */
  | "git-dir-unusable"
  /** Enumeration succeeded but an `update-ref -d` did not; refs already deleted still count. */
  | "ref-delete-failed";

/** Why one run's prune stopped. */
interface TurnSnapshotRetentionSkip {
  readonly runId: string;
  readonly reason: TurnSnapshotRetentionSkipReason;
  readonly detail: string;
}

/**
 * What this service reports to observability. Paths appear on purpose: a diagnostic is
 * daemon-local, unlike the typed errors that reach the wire.
 */
export type TurnSnapshotDiagnostic =
  | {
      readonly kind: "capture-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** `null` only when the inputs were refused before a ref could be built. */
      readonly ref: string | null;
      readonly failedStep: TurnSnapshotCaptureStep;
      readonly detail: string;
    }
  | {
      readonly kind: "embedded-repositories-skipped";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      readonly ref: string;
      /**
       * Untracked embedded repositories not recorded as gitlinks: an unborn `HEAD` has no OID, or
       * the object format differs from the superproject's (measured on git 2.50.1).
       */
      readonly skippedPaths: readonly string[];
    }
  | {
      readonly kind: "scratch-index-cleanup-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** Best-effort cleanup reports here so a surviving index file is noticed. Daemon-local. */
      readonly scratchIndexPath: string;
      readonly detail: string;
    }
  | {
      /** One run's context row could not be read, so its refs were not pruned. */
      readonly kind: "run-context-read-failed";
      readonly runId: string;
      readonly detail: string;
    };

/** Constructor dependencies of {@link TurnSnapshotService}. */
export interface TurnSnapshotServiceDeps {
  /** Absolute; holds the hook-neutralization and scratch-index directories. */
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
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: TurnSnapshotFilesystem;
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
  /** The worktree, or the main checkout in `bound-root` mode. */
  readonly executionRoot: string;
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
