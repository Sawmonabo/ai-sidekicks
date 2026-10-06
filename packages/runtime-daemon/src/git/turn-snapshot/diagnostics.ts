// What the snapshot service reports to observability: the capture steps a failure names, why a
// prune was skipped, the diagnostic union, and its default sink.

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

/** Logs a diagnostic as a warning; the sink used when the service is given none. */
export function warnDiagnostic(diagnostic: TurnSnapshotDiagnostic): void {
  if (diagnostic.kind === "run-context-read-failed") {
    console.warn(`turn-snapshot ${diagnostic.kind}: run=${diagnostic.runId}`, diagnostic);
    return;
  }
  console.warn(
    `turn-snapshot ${diagnostic.kind}: run=${diagnostic.runId} ` +
      `epoch=${String(diagnostic.epoch)} turn=${String(diagnostic.turnOrdinal)}`,
    diagnostic,
  );
}

/** The message of a rejected value, or its string form when it is not an Error. */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}
