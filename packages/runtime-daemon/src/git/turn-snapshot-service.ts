// Turn-snapshot service: at each turn boundary, commits the project state of a run's execution
// root under `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`, and deletes a run's refs once its
// retention window closes. Capture reads no database (the caller supplies the epoch).
//
// - Ref names are built from a validated `runId` before any git call: git's own refusal of
//   `../../heads/main` (2.50.1) would arrive as a swallowed capture failure.
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
// - Retention: nothing memoizes a pruned run, so each tick spawns `for-each-ref` for every
//   terminal run past its window (`LIMIT` would starve the rows behind the oldest).

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { copyFile, lstat, mkdir, open, readFile, readlink, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Database, Statement } from "better-sqlite3";

import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
} from "../workspace/repo-root-resolver.js";

/**
 * Stdio of one successful git call. `stdout` is a Buffer because `-z` listings are bytes. `stderr`
 * is unread: `update-index` prints `Ignoring path nested/` and exits 0, so failure is by exit
 * status.
 */
export interface TurnSnapshotGitInvocationResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

interface TurnSnapshotGitInvocationOptions {
  readonly timeoutMs: number;
  /**
   * Layered over the stripped environment. Per call: the embedded-repository `rev-parse HEAD` must
   * not get the scratch `GIT_INDEX_FILE`.
   */
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /** Written to stdin, which is always closed (`commit-tree -F -` hangs on an open one). */
  readonly stdin?: Buffer;
}

/** The git process seam: the full argv, `-C <dir>` included; failure is by exit status only. */
export type TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
) => Promise<TurnSnapshotGitInvocationResult>;

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

/** One run the sweep declined to finish. */
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
      /**
       * One per sweep pass that skipped a run. Carries no `runId`, `epoch` or `turnOrdinal`;
       * {@link warnDiagnostic} branches on that.
       */
      readonly kind: "retention-prune-skipped";
      /** Every skip of the pass. Never empty: the sweep does not emit an empty enumeration. */
      readonly skipped: readonly TurnSnapshotRetentionSkip[];
      readonly examinedRunCount: number;
    }
  | {
      /**
       * A retention read failed: the sweep's candidate read or clock (no `runId`; the timer-driven
       * sweep never throws, so this is its only signal), or one run's row (carries `runId`).
       */
      readonly kind: "retention-sweep-failed";
      readonly detail: string;
      readonly runId?: string;
    };

/** Constructor dependencies of {@link TurnSnapshotService}. */
export interface TurnSnapshotServiceDeps {
  /** Absolute; holds the hook-neutralization and scratch-index directories. */
  readonly executionRootsDirectory: string;
  /** Retention only. Without it the sweep methods throw `TypeError`, not "nothing to prune". */
  readonly database?: Database;
  /** How long refs outlive a run's terminal release, in ms; defaults to a week. */
  readonly retentionWindowMs?: number;
  /** Git process seam; defaults to {@link runTurnSnapshotGitWithExecFile}. */
  readonly git?: TurnSnapshotGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: TurnSnapshotFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /**
   * The turn-boundary instant in `toISOString()` form. It becomes a fixed `+0000` commit date so
   * the OID never depends on the host timezone; retention compares it as text with `released_at`.
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

/** What one {@link TurnSnapshotService.sweepPrunableRuns} pass did. */
export interface TurnSnapshotRetentionSweepResult {
  /** Every run whose window had closed at the cutoff, skips included. */
  readonly examinedRunIds: readonly string[];
  /** The subset that completed with no skip. */
  readonly prunedRunIds: readonly string[];
  readonly deletedRefs: readonly string[];
  /** The enumeration the `retention-prune-skipped` diagnostic carries. */
  readonly skipped: readonly TurnSnapshotRetentionSkip[];
}

// Not `refs/heads/`, so snapshots stay out of branch history, PR preparation and diffs.
const SNAPSHOT_REF_ROOT = "refs/sidekicks/runs";

// The same bytes for every snapshot: the message is an OID input, so identity content would make
// identical state hash differently. Trailers derived from project state keep that property.
const SNAPSHOT_COMMIT_MESSAGE = "sidekicks: turn-boundary snapshot";

// Names the embedded repositories the capture could not record. A skipped one is absent from the
// tree, so a restore would delete it and its `.git` as untracked. Written only when non-empty,
// JSON-encoded (a newline cannot forge a trailer) and sorted (message bytes are an OID input).
const SKIPPED_EMBEDDED_REPOSITORIES_TRAILER = "Skipped-Embedded-Repositories:";

// Names out-of-cone paths at the boundary that the tree lacks (untracked, or intent-to-add:
// `write-tree` omits them, git 2.50.1); a restore would delete them. Written in every sparse root
// (`[]` when empty), so presence is the format marker. JSON, sorted, latin1 (see
// {@link listingEntryKey}). A trailing slash marks a directory git did not descend into (a restore
// exempts everything beneath it).
const SPARSE_BOUNDARY_PATHS_TRAILER = "Sparse-Boundary-Paths:";

// An explicit identity: without one `commit-tree` fails in a container with no passwd entry, and
// elsewhere stamps the OS user.
const SNAPSHOT_IDENTITY_NAME = "AI Sidekicks";
const SNAPSHOT_IDENTITY_EMAIL = "snapshots@ai-sidekicks.invalid";

// Must match `./worktree-service.ts`, so a temp reaper cannot remove one from under the other.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

// Outside the worktree, so scratch indexes never show up in `ls-files -o` or `git status`.
const SNAPSHOT_INDEX_SEGMENT = ".snapshot-indexes";

// Matches `./worktree-service.ts`: the staging legs walk the whole worktree.
const DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS = 120_000;

/** Seven days; too short a window silently loses a wanted rollback, so it errs long. */
const DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * ECMAScript's Date range (8.64e15 ms). A larger window makes `now - window` unrepresentable and
 * every sweep fail; a clock far from the epoch can still overflow (`#retentionCutoff` covers it).
 */
const MAXIMUM_RETENTION_WINDOW_MS = 8_640_000_000_000_000;

// Eight times `./worktree-service.ts`'s 8 MiB (a `-z` listing holds one path per file); overflow
// fails the capture and never truncates.
const GIT_STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// A SHA-1 or SHA-256 id, checked before it enters an argv. With `show-ref --verify` and the
// runner's exit check it stops a bare `rev-parse` echo from passing as `already-captured`.
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Hex length per `rev-parse --show-object-format` name. A valid id can be un-insertable in a
// repository of the other width (see `#normalizeEmbeddedRepositories`); an unknown name throws.
const OBJECT_ID_HEX_LENGTHS: ReadonlyMap<string, number> = new Map<string, number>([
  ["sha1", 40],
  ["sha256", 64],
]);

const GITLINK_TREE_MODE = "160000";

// The listing's only exclude source: porcelain `add -A` also honors `core.excludesFile` and
// `$GIT_DIR/info/exclude`, which are not project declarations.
const EXCLUDE_PER_DIRECTORY_GITIGNORE = "--exclude-per-directory=.gitignore";

// Stops `refs/replace/<oid>` swapping another object for a frozen id, on the legs that read an
// object id back. Measured: with a replace ref on the base, an unpinned seed silently loses a path
// that is both index-tracked and ignored; the ref-resolving legs are unaffected.
const USE_REPLACE_REFS_PIN: readonly string[] = ["-c", "core.useReplaceRefs=false"];

const NUL_TERMINATOR: Buffer = Buffer.from([0]);

const CORE_SPARSE_CHECKOUT_KEY = "core.sparseCheckout";

// The lock is held for one index write, so contention clears at once. A stale lock from a crashed
// git must fail fast as a typed error; this code never removes a lock it did not create.
const SPARSE_SEED_INDEX_LOCK_ATTEMPTS = 4;
const SPARSE_SEED_INDEX_LOCK_RETRY_DELAY_MS = 25;

/** The alphabet half of `isSafeRefComponent`; it admits some dot spellings, so never enough. */
const SAFE_REF_COMPONENT_CHARACTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONSECUTIVE_DOTS = "..";

const RESERVED_REF_LOCK_SUFFIX = ".lock";

/**
 * Stripped from the git environment besides {@link DISCOVERY_REDIRECTING_GIT_ENV_KEYS}.
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` stay: `-c` pins outrank every config source.
 * Exported for the tests.
 */
export const SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS: readonly string[] = [
  ...DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  // The snapshot objects must resolve from the execution root's own object store.
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  // Local ref plumbing ignores it (2.50.1); only the pack protocol applies it.
  "GIT_NAMESPACE",
  // Every index-touching leg sets its own scratch index.
  "GIT_INDEX_FILE",
];

/**
 * The strip list uppercased: on Windows a `Git_Dir` variable would survive
 * `delete environment["GIT_DIR"]`. `toUpperCase`, since the locale variant maps `I` to `ı` in
 * Turkish.
 */
const SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED = new Set(
  SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/** The prefix retention lists; `runId` must pass {@link isSafeRefComponent}. */
function buildRunSnapshotRefPrefix(runId: string): string {
  return `${SNAPSHOT_REF_ROOT}/${runId}/`;
}

/**
 * The epoch segment keeps a post-rollback re-execution, which reuses turn ordinals, off the
 * superseded epoch's ref.
 */
function buildTurnSnapshotRef(runId: string, epoch: number, turnOrdinal: number): string {
  return `${buildRunSnapshotRefPrefix(runId)}epoch-${String(epoch)}/turn-${String(turnOrdinal)}`;
}

/**
 * Security predicate for a ref path component, as separate checks so each refusal has a reason.
 * Run ids are UUIDs, so no real caller is refused. Git refuses `..` and a `.lock` suffix (2.50.1).
 * A trailing `.` is refused because Win32 strips it (`run.` and `run` would share a namespace),
 * and `.lock` in any casing because on APFS and NTFS `run.LOCK` is the lock file of ref `run`.
 */
function isSafeRefComponent(value: string): boolean {
  return (
    SAFE_REF_COMPONENT_CHARACTER_PATTERN.test(value) &&
    !value.includes(CONSECUTIVE_DOTS) &&
    !value.endsWith(".") &&
    !value.toLowerCase().endsWith(RESERVED_REF_LOCK_SUFFIX)
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The environment for every git call: the daemon's minus the strip list, `C` locale, prompts off,
 * then the caller's overlay (so an inherited `GIT_INDEX_FILE` stays stripped).
 */
function buildTurnSnapshotGitEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // A git that prompted would block on a terminal the daemon lacks until the timeout.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      environment[key] = value;
    }
  }
  return environment;
}

/** The default runner: `execFile` with an argv array, never a shell string. Exported for tests. */
export const runTurnSnapshotGitWithExecFile: TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
): Promise<TurnSnapshotGitInvocationResult> => {
  return new Promise<TurnSnapshotGitInvocationResult>((resolve, reject) => {
    const child = execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "buffer",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildTurnSnapshotGitEnvironment(options.environmentOverrides),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stderrText: string = stderr.toString("utf8");
        if (error !== null) {
          reject(Object.assign(error, { stderr: stderrText }));
          return;
        }
        resolve({ stdout, stderr: stderrText });
      },
    );
    const childStdin = child.stdin;
    if (childStdin !== null) {
      // A child exiting before it drains stdin makes this write EPIPE; that arrives via the exit
      // status, and an unhandled `error` event would crash the daemon.
      childStdin.on("error", () => {
        /* see above */
      });
      if (options.stdin !== undefined) {
        childStdin.write(options.stdin);
      }
      childStdin.end();
    }
  });
};

const DEFAULT_TURN_SNAPSHOT_FILESYSTEM: TurnSnapshotFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

function warnDiagnostic(diagnostic: TurnSnapshotDiagnostic): void {
  // Pass-scoped kinds carry no run or turn identity.
  if (diagnostic.kind === "retention-prune-skipped") {
    console.warn(
      `turn-snapshot ${diagnostic.kind}: ` +
        `skipped=${String(diagnostic.skipped.length)} of ` +
        `examined=${String(diagnostic.examinedRunCount)}`,
      diagnostic,
    );
    return;
  }
  if (diagnostic.kind === "retention-sweep-failed") {
    console.warn(`turn-snapshot ${diagnostic.kind}: ${diagnostic.detail}`, diagnostic);
    return;
  }
  console.warn(
    `turn-snapshot ${diagnostic.kind}: run=${diagnostic.runId} ` +
      `epoch=${String(diagnostic.epoch)} turn=${String(diagnostic.turnOrdinal)}`,
    diagnostic,
  );
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

/**
 * An ISO instant as git's raw `<unix-seconds> +0000` date; the fixed offset keeps the snapshot id
 * independent of the host timezone. `null` for an unparseable clock.
 */
function toRawGitDate(isoInstant: string): string | null {
  const milliseconds: number = Date.parse(isoInstant);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return `${String(Math.floor(milliseconds / 1000))} +0000`;
}

/**
 * Decoded paths, used only to classify trailing-slash entries; comparisons against the boundary
 * set use {@link splitNulTerminatedListingBytes} and {@link listingEntryKey}.
 */
function splitNulTerminatedListing(listing: Buffer): readonly string[] {
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.toString("utf8", start, index));
      }
      start = index + 1;
    }
  }
  // Not a shape git produces, but dropping a trailing path would silently omit it.
  if (start < listing.length) {
    entries.push(listing.toString("utf8", start));
  }
  return entries;
}

/** Undecoded {@link splitNulTerminatedListing}: a decode would break the match with git's echo. */
function splitNulTerminatedListingBytes(listing: Buffer): readonly Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.subarray(start, index));
      }
      start = index + 1;
    }
  }
  if (start < listing.length) {
    entries.push(listing.subarray(start));
  }
  return entries;
}

function joinNulTerminatedListing(entries: readonly Buffer[]): Buffer {
  if (entries.length === 0) {
    return Buffer.alloc(0);
  }
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(entry, NUL_TERMINATOR);
  }
  return Buffer.concat(parts);
}

/** A byte-exact map key: `latin1` maps bytes one-to-one; `utf8` would merge invalid sequences. */
function listingEntryKey(entry: Buffer): string {
  return entry.toString("latin1");
}

interface SnapshotRefListingEntry {
  readonly objectId: string;
  readonly ref: string;
}

/**
 * Keeps well-formed `<oid> <refname>` lines under `expectedPrefix`. This judges the name git
 * reported; `--no-deref` at deletion governs what it resolves to. A bad line is dropped, not
 * refused, so it cannot strand the refs beside it.
 */
function parseSnapshotRefListing(
  listing: Buffer,
  expectedPrefix: string,
): readonly SnapshotRefListingEntry[] {
  const entries: SnapshotRefListingEntry[] = [];
  for (const line of listing.toString("utf8").split("\n")) {
    const separatorIndex: number = line.indexOf(" ");
    if (separatorIndex <= 0) {
      continue;
    }
    const objectId: string = line.slice(0, separatorIndex);
    const ref: string = line.slice(separatorIndex + 1);
    if (!OBJECT_ID_PATTERN.test(objectId) || !ref.startsWith(expectedPrefix)) {
      continue;
    }
    entries.push({ objectId, ref });
  }
  return entries;
}

/** The object-id hex length for a `--show-object-format` name; throws on an unknown one. */
function requireObjectIdHexLength(stdout: Buffer): number {
  const format: string = stdout.toString("utf8").trim();
  const hexLength: number | undefined = OBJECT_ID_HEX_LENGTHS.get(format);
  if (hexLength === undefined) {
    throw new Error(`git reported an unrecognized object format: ${format}`);
  }
  return hexLength;
}

/**
 * A type-aware fingerprint of the entry at `path` (`absent`, `directory`, `other`,
 * `file:<sha256>`, `symlink:<sha256 of target>`, or `...:unreadable`), so equal fingerprints mean
 * the same kind and content. Uses `lstat` and no git; directories carry no hash; an `lstat`
 * failure reads `absent`.
 *
 * @consumedBy the turn checkpointer
 */
export async function fingerprintPath(path: string): Promise<string> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch {
    return "absent";
  }
  if (entry.isSymbolicLink()) {
    try {
      return `symlink:${hashBytes(Buffer.from(await readlink(path), "utf8"))}`;
    } catch {
      return "symlink:unreadable";
    }
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (!entry.isFile()) {
    return "other";
  }
  try {
    return `file:${hashBytes(await readFile(path))}`;
  } catch {
    return "file:unreadable";
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether `path` is provably absent: only `ENOENT` and `ENOTDIR` count, so any other failure
 * resolves `false` and lands in `git-dir-unusable`. A read, so it bypasses the mutation seam.
 */
async function isPathProvablyAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (reason: unknown) {
    const code: string | undefined = (reason as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * The cone partition of one `-z` listing. `outOfConeEntries` stay undecoded byte slices (trailing
 * slash kept) because the boundary subtraction compares them against another git listing.
 */
interface SparseListingPartition {
  readonly inConeListing: Buffer;
  readonly outOfConeEntries: readonly Buffer[];
}

/** One prune candidate; field names are the SQL column names. */
interface PrunableRunRow {
  readonly run_id: string;
  readonly git_common_dir: string;
}

interface RetentionCutoffParams {
  readonly released_before: string;
}

interface RunContextLookupParams {
  readonly run_id: string;
}

/** The refusal when a retention entry point is called on a service built without a `database`. */
const RETENTION_WITHOUT_DATABASE_MESSAGE =
  "TurnSnapshotService: the retention leg needs a `database` dependency " +
  "(construct with `database` to call sweepPrunableRuns / pruneSnapshotsForRun)";

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
      const baseCommit: string = await this.#resolveBaseCommit(input.executionRoot);

      step = "detect-sparse-root";
      const isSparseRoot: boolean = await this.#detectSparseRoot(input.executionRoot);

      step = "seed-index";
      if (isSparseRoot) {
        // Copy the live index, not `read-tree <base>`: a read-tree index lacks skip-worktree bits,
        // so staging would re-stat each out-of-cone path, find it absent and drop it. The live
        // index also carries legitimate differences from `HEAD` (`git add --sparse`).
        await this.#seedScratchIndexFromLiveIndex(input.executionRoot, scratchIndexPath);
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
        ? await this.#partitionListingByCone(input.executionRoot, fullListing)
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
        await this.#normalizeEmbeddedRepositories(input.executionRoot, scratchIndexPath, listing);

      step = "write-tree";
      const treeObjectId: string = this.#requireObjectId(
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
        ? await this.#deriveSparseBoundaryPaths(
            input.executionRoot,
            treeObjectId,
            partition.outOfConeEntries,
          )
        : null;

      step = "commit-tree";
      const snapshotCommit: string = await this.#commitSnapshotTree(
        input.executionRoot,
        treeObjectId,
        baseCommit,
        skippedEmbeddedRepositories,
        sparseBoundaryPaths,
      );

      step = "write-ref";
      const recordedCommit: string | null = await this.#writeCreateOnlyRef(
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
   * Resolves `HEAD` once; the id is both the tree base and the recorded parent, so a branch moving
   * mid-capture cannot pair an old tree with a new parent. An unborn `HEAD` fails as
   * `resolve-base`.
   */
  async #resolveBaseCommit(executionRoot: string): Promise<string> {
    // `--verify` prints nothing on a miss; the bare form echoes `HEAD` with a non-zero exit.
    const result = await this.#runGit(["-C", executionRoot, "rev-parse", "--verify", "HEAD"], {});
    return this.#requireObjectId(result.stdout);
  }

  /**
   * Whether the root is sparse, read from `core.sparseCheckout` alone (what git consults before
   * skip-worktree). A rules file without the bit fails the matcher (exit 128), so capture fails
   * closed as `check-sparse-rules`. Read per root, not per mode: a worktree inherits sparseness.
   */
  async #detectSparseRoot(executionRoot: string): Promise<boolean> {
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
  async #seedScratchIndexFromLiveIndex(
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
  async #partitionListingByCone(
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
  async #deriveSparseBoundaryPaths(
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
  async #normalizeEmbeddedRepositories(
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
      const embeddedHead: string = this.#requireObjectId(headStdout);
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
  async #commitSnapshotTree(
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
    return this.#requireObjectId(result.stdout);
  }

  /**
   * The create-only ref write. Returns `null` when this call wrote the ref, or the recorded id when
   * the compare-and-swap found one already there. Any other failure propagates to the funnel.
   */
  async #writeCreateOnlyRef(
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

  /** The recorded OID, or `null` when the ref does not resolve. */
  async #readRefIfPresent(executionRoot: string, ref: string): Promise<string | null> {
    try {
      // `--verify` on a fully-qualified ref: no abbreviation, no search path, no echo on a miss.
      const result = await this.#runGit(
        ["-C", executionRoot, "show-ref", "--verify", "--hash", ref],
        {},
      );
      return this.#requireObjectId(result.stdout);
    } catch {
      return null;
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
    options: {
      readonly environmentOverrides?: Readonly<Record<string, string>>;
      readonly stdin?: Buffer;
    },
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

  /** See {@link OBJECT_ID_PATTERN}. Throws into the funnel on anything else. */
  #requireObjectId(stdout: Buffer): string {
    const candidate: string = stdout.toString("utf8").trim();
    if (!OBJECT_ID_PATTERN.test(candidate)) {
      throw new Error("git did not report an object id");
    }
    return candidate;
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
