// Turn-snapshot ref names: the ref root, the builders, the safety predicate a run id must pass,
// and the replace-ref pin for legs that read an object id back.

// Not `refs/heads/`, so snapshots stay out of branch history, PR preparation and diffs.
const SNAPSHOT_REF_ROOT = "refs/sidekicks/runs";

/**
 * Stops `refs/replace/<oid>` swapping another object for a frozen id, on the legs that read an
 * object id back. Measured: with a replace ref on the base, an unpinned seed silently loses a path
 * that is both index-tracked and ignored; the ref-resolving legs are unaffected.
 */
export const USE_REPLACE_REFS_PIN: readonly string[] = ["-c", "core.useReplaceRefs=false"];

/** The alphabet half of `isSafeRefComponent`; it admits some dot spellings, so never enough. */
const SAFE_REF_COMPONENT_CHARACTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONSECUTIVE_DOTS = "..";

const RESERVED_REF_LOCK_SUFFIX = ".lock";

/** The prefix retention lists; `runId` must pass {@link isSafeRefComponent}. */
export function buildRunSnapshotRefPrefix(runId: string): string {
  return `${SNAPSHOT_REF_ROOT}/${runId}/`;
}

/**
 * The epoch segment keeps a post-rollback re-execution, which reuses turn ordinals, off the
 * superseded epoch's ref.
 */
export function buildTurnSnapshotRef(runId: string, epoch: number, turnOrdinal: number): string {
  return `${buildRunSnapshotRefPrefix(runId)}epoch-${String(epoch)}/turn-${String(turnOrdinal)}`;
}

/**
 * Security predicate for a ref path component, as separate checks so each refusal has a reason.
 * Run ids are UUIDs, so no real caller is refused. Git refuses `..` and a `.lock` suffix (2.50.1).
 * A trailing `.` is refused because Win32 strips it (`run.` and `run` would share a namespace),
 * and `.lock` in any casing because on APFS and NTFS `run.LOCK` is the lock file of ref `run`.
 */
export function isSafeRefComponent(value: string): boolean {
  return (
    SAFE_REF_COMPONENT_CHARACTER_PATTERN.test(value) &&
    !value.includes(CONSECUTIVE_DOTS) &&
    !value.endsWith(".") &&
    !value.toLowerCase().endsWith(RESERVED_REF_LOCK_SUFFIX)
  );
}

/** Whether the value is a safe integer of zero or more. */
export function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
