/**
 * The row shapes and metadata keys the workspace service stores under, and the checks it runs
 * against them: single-row writes, absolute roots, and the metadata readers.
 */

import {
  DEFAULT_DIRECTORY_READABILITY_PROBE,
  type DirectoryReadabilityProbe,
} from "./trust-envelope.js";
import { type FilesystemPathProbe } from "./projector.js";
import { WorkspaceServiceInvariantError, type WorkspaceServiceInvariantKind } from "./errors.js";

/**
 * Measure a path's reachability. The seam is at probe granularity so a test can return a
 * `FilesystemPathProbe` this module did not build. Production sets `probedPath` from its argument
 * only; re-canonicalizing it would defeat the projector's path-match guard.
 */
export type FilesystemPathProbeFn = (path: string) => Promise<FilesystemPathProbe>;

/** The `repo_mounts` columns this service reads. */
export interface MountRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
}

/** The `workspaces` columns this service reads. */
export interface WorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
}

// `lastError` crosses the wire on the list response; `holdingRunId` is daemon-internal and never
// does.
const LAST_ERROR_METADATA_KEY = "lastError";

/** The JSON path in `workspaces.metadata` of a stale workspace's `lastError`. */
export const LAST_ERROR_METADATA_PATH: string = `$.${LAST_ERROR_METADATA_KEY}`;

const HOLDING_RUN_ID_METADATA_KEY = "holdingRunId";

/** The JSON path in `workspaces.metadata` of the run holding a `busy` workspace. */
export const HOLDING_RUN_ID_METADATA_PATH: string = `$.${HOLDING_RUN_ID_METADATA_KEY}`;

/**
 * The production probe. Clock first so `checkedAt` is never newer than the observation it stamps
 * (a hung network mount can take seconds).
 */
export function createDefaultPathProbe(): FilesystemPathProbeFn {
  return async (path: string): Promise<FilesystemPathProbe> => {
    const checkedAt = new Date().toISOString();
    let reachable = true;
    try {
      await readDirectory(path);
    } catch {
      reachable = false;
    }
    return { probedPath: path, reachable, checkedAt };
  };
}

// One implementation of "can the daemon open this directory?", shared with the trust envelope.
const readDirectory: DirectoryReadabilityProbe = DEFAULT_DIRECTORY_READABILITY_PROBE;

/** The failure classes attributed to a row; `Extract`, so renaming a parent member breaks here. */
type RowAttributedInvariantKind = Extract<
  WorkspaceServiceInvariantKind,
  "workspace_row_unprojectable" | "stale_transition_durability_failure"
>;

/**
 * Fixed message per attributed class; a total `Record`, so a class added without one fails to
 * compile.
 */
const ROW_FAILURE_MESSAGES: Record<RowAttributedInvariantKind, string> = {
  workspace_row_unprojectable: "cannot be projected onto the workspace list response",
  stale_transition_durability_failure: "derived a stale transition that could not be made durable",
};

/**
 * Attribute a per-row failure to its workspace, leaving an already-attributed one alone, so a
 * failed stale write is not relabeled `workspace_row_unprojectable` one layer out.
 */
export function wrapRowFailure(
  error: unknown,
  workspaceId: string,
  kind: RowAttributedInvariantKind,
): WorkspaceServiceInvariantError {
  if (error instanceof WorkspaceServiceInvariantError) {
    return error;
  }
  return new WorkspaceServiceInvariantError(
    `workspace "${workspaceId}" ${ROW_FAILURE_MESSAGES[kind]}`,
    { kind, workspaceId, cause: error },
  );
}

/**
 * Refuse an execution root that needs the daemon's own context to become concrete: a relative
 * path, `~`, or a driveless Windows root such as `\repos\app`.
 */
export function assertAbsoluteExecutionRoot(candidate: string, workspaceId: string): void {
  if (namesOneCompleteLocation(candidate)) {
    return;
  }
  // Not echoed: the IPC sanitizer redacts only absolute-form paths.
  throw new WorkspaceServiceInvariantError(
    "execution root does not name one complete location; the daemon would have to " +
      "supply the missing piece from its own context",
    { kind: "non_absolute_execution_root", workspaceId },
  );
}

// The complete forms: POSIX absolute, Windows drive-absolute (`C:\repos\app`, `C:/repos/app`) and
// UNC; a lone leading backslash is the driveless root refused above. Not `node:path`'s
// platform-dependent `isAbsolute`: a root stored on one machine must be recognized on another.
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function namesOneCompleteLocation(candidate: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(candidate);
}

/**
 * Assert a compare-and-swap moved exactly one row. Called inside a `transactionalPrelude`, where
 * the throw aborts the transaction and takes the event row with it. `movedSubject` names the row
 * that failed the predicate (for `bind`'s conditional insert, the repo mount).
 */
export function assertSingleRowChanged(
  result: { readonly changes: number },
  workspaceId: string,
  attemptedAction: string,
  movedSubject: string = "it",
): void {
  if (result.changes !== 1) {
    throw new WorkspaceServiceInvariantError(
      `cannot ${attemptedAction} workspace "${workspaceId}": ${movedSubject} left its ` +
        "expected state before the write committed",
      { kind: "illegal_state_transition", workspaceId },
    );
  }
}

/**
 * Read one string key from a row's `metadata` blob; a non-string value or an unparseable blob
 * reads as `null`.
 */
function readMetadataString(row: WorkspaceRow, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** The stored `lastError` of a workspace row, or `null` when it holds none. */
export function readLastError(row: WorkspaceRow): string | null {
  return readMetadataString(row, LAST_ERROR_METADATA_KEY);
}

/** The run holding a `busy` workspace, or `null` when none is recorded. */
export function readHoldingRunId(row: WorkspaceRow): string | null {
  return readMetadataString(row, HOLDING_RUN_ID_METADATA_KEY);
}
