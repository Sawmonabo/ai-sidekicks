/**
 * Runs git for worktree operations: the runner and filesystem seams, the neutralized environment
 * every invocation gets, and the default `execFile` runner.
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  GIT_STDIO_MAX_BUFFER_BYTES,
} from "../workspace/repo-root-resolver.js";

/** Captured stdio from one completed git invocation. */
export interface WorktreeGitInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-invocation bounds. */
interface WorktreeGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
}

/**
 * The git process seam: takes the complete argv (including `-C <dir>`) and no working directory.
 * A rejection carries git's `stdout` and `stderr`; only git's branch-name refusal is read from it,
 * since any other `stderr` line can name a filesystem path.
 */
export type WorktreeGitRunner = (
  argv: readonly string[],
  options: WorktreeGitInvocationOptions,
) => Promise<WorktreeGitInvocationResult>;

/**
 * Two idempotent verbs: create tolerates an existing directory, remove a missing one. The sweep
 * retries removal until `cleaned_at` is stamped, so the tolerance is load-bearing.
 */
export interface WorktreeFilesystem {
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

/**
 * A dotted sibling of the per-mount root directories, so it can never collide with a mount id.
 * The worktree, turn-snapshot and execution-root services share this one hooks directory, so a
 * temp reaper in one cannot remove a hooks path from under another.
 */
export const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

/**
 * Well above `DEFAULT_GIT_COMMAND_TIMEOUT_MS`: `worktree add` materializes a full checkout, and 10
 * seconds would kill a healthy provisioning on a large repository.
 */
export const DEFAULT_WORKTREE_GIT_TIMEOUT_MS = 120_000;

// Imported from the resolver: two copies of this security list would drift.
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED = new Set(
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/** The environment for every git call, read at call time so a mutated environment is followed. */
function buildWorktreeGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // Defense in depth: a git that prompted would block on a terminal the daemon lacks.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  return environment;
}

/** `execFile` with an argv array, never a shell string. */
export function runGitWithExecFile(
  argv: readonly string[],
  options: WorktreeGitInvocationOptions,
): Promise<WorktreeGitInvocationResult> {
  return new Promise<WorktreeGitInvocationResult>((resolve, reject) => {
    execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildWorktreeGitEnvironment(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** The real filesystem the worktree service uses unless a test injects another. */
export const DEFAULT_WORKTREE_FILESYSTEM: WorktreeFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};
