/**
 * How the snapshot service talks to git: the neutralized environment, the process runner, the
 * snapshot ref names, and the diagnostics a failed step produces.
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  GIT_STDIO_MAX_BUFFER_BYTES,
} from "../workspace/repo-root-resolver.js";
import type {
  TurnSnapshotDiagnostic,
  TurnSnapshotFilesystem,
  TurnSnapshotGitInvocationOptions,
  TurnSnapshotGitInvocationResult,
  TurnSnapshotGitRunner,
} from "./turn-snapshot-types.js";

// Not `refs/heads/`, so snapshots stay out of branch history, PR preparation and diffs.
const SNAPSHOT_REF_ROOT = "refs/sidekicks/runs";

/** Outside the worktree, so scratch indexes never show up in `ls-files -o` or `git status`. */
export const SNAPSHOT_INDEX_SEGMENT = ".snapshot-indexes";

/** Matches `./worktree-service.ts`: the staging legs walk the whole worktree. */
export const DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS = 120_000;

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

/** The real filesystem behind the snapshot service's filesystem seam. */
export const DEFAULT_TURN_SNAPSHOT_FILESYSTEM: TurnSnapshotFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

/** Logs a diagnostic as a warning; the sink used when the service is given none. */
export function warnDiagnostic(diagnostic: TurnSnapshotDiagnostic): void {
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

/** The message of a rejected value, or its string form when it is not an Error. */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}
