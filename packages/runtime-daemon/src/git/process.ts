/**
 * How the daemon runs git: one `execFile` runner, one environment, the shared stdio and time
 * bounds, and the hook-neutralized entry point the worktree, execution-root and snapshot services
 * share. Each caller adds its own argv flags.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * The bare name `git`, found by the platform's search. On Windows libuv looks in the daemon's
 * current directory before `PATH`, so a Windows deployment should name an absolute path.
 */
export const DEFAULT_GIT_EXECUTABLE: string = "git";

/**
 * Cap on captured stdio for every daemon git invocation, sized for the largest one: a `-z` path
 * listing of a whole worktree. A cap, not an allocation; overflow fails the invocation and never
 * truncates.
 */
const GIT_STDIO_MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;

/**
 * Two minutes: `worktree add` materializes a full checkout and the snapshot staging legs walk the
 * whole worktree, so a shorter bound would kill healthy work on a large repository.
 */
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS: number = 120_000;

/**
 * A dotted sibling of the per-mount root directories under the execution-roots directory, so it
 * never collides with a mount id. Every service shares this one empty hooks directory, so a temp
 * reaper in one cannot remove a hooks path from under another.
 */
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

/**
 * `GIT_*` variables that bend repository discovery (git 2.50.1). `GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` are the person's choices and stay.
 */
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS: readonly string[] = [
  // With these exported, `git -C <path> rev-parse` still answers about the ambient repository.
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  // A value naming nothing accessible makes git refuse a real repository with the anchored
  // "not a git repository" at exit 128; an accessible one lets an object-less `.git` discover.
  "GIT_OBJECT_DIRECTORY",
  // Config injection, stripped as defense in depth: an injected `core.worktree` did not move the
  // toplevel, but the same key in the repository's own config does.
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

/** Everything stripped from the daemon's environment before git runs. */
export const NEUTRALIZED_GIT_ENV_KEYS: readonly string[] = [
  ...DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  // Objects must resolve from the repository's own object store.
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  // Local ref plumbing ignores it (2.50.1); only the pack protocol applies it.
  "GIT_NAMESPACE",
  // An inherited index would redirect every index-touching command; a caller that needs a scratch
  // index sets its own per call.
  "GIT_INDEX_FILE",
];

/**
 * Compared uppercased: Windows keeps an inherited key's spelling (`Git_Dir`). `toUpperCase`, not
 * the locale variant, which maps `I` to `ı` in Turkish.
 */
const NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED = new Set(
  NEUTRALIZED_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/** Per-invocation bounds and inputs. */
interface GitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
  /**
   * Layered over the stripped environment, per call: a scratch `GIT_INDEX_FILE` must reach only
   * the commands that stage into it.
   */
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /** Written to stdin, which is always closed (`commit-tree -F -` hangs on an open one). */
  readonly stdin?: Buffer;
  /** Defaults to {@link DEFAULT_GIT_EXECUTABLE}. */
  readonly executable?: string;
}

/** Captured stdio of one invocation that exited 0. `stdout` is bytes, since `-z` listings are. */
export interface GitInvocationResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * A rejected invocation: the `execFile` error plus git's output. `code` is the exit status, or an
 * errno string when git never ran; `killed` marks the timeout.
 */
export interface GitInvocationFailure extends Error {
  readonly code?: number | string | null | undefined;
  readonly signal?: NodeJS.Signals | null | undefined;
  readonly killed?: boolean | undefined;
  readonly stdout?: Buffer | undefined;
  readonly stderr?: string | undefined;
}

/**
 * The git process seam: the complete argv (`-C <dir>` included) and no working directory. Rejects
 * on any non-zero exit with a {@link GitInvocationFailure}.
 */
export type GitRunner = (
  argv: readonly string[],
  options: GitInvocationOptions,
) => Promise<GitInvocationResult>;

/** Per-call options of a hook-neutralized command; the bound is the service's. */
type GitCommandOptions = Omit<GitInvocationOptions, "timeoutMs">;

/** One git command through a service's hook-neutralized entry point. */
export type GitCommand = (
  argv: readonly string[],
  options?: GitCommandOptions,
) => Promise<GitInvocationResult>;

/**
 * The environment for every git call, read at call time so a mutated environment is followed: the
 * daemon's minus the strip list, `C` locale (refusals are read off stderr), prompts off, then the
 * caller's overlay.
 */
function buildGitEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
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

/** The default runner: `execFile` with an argv array, never a shell string. */
export const runGitWithExecFile: GitRunner = (argv, options) => {
  return new Promise<GitInvocationResult>((resolve, reject) => {
    const child = execFile(
      options.executable ?? DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "buffer",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildGitEnvironment(options.environmentOverrides),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stderrText: string = stderr.toString("utf8");
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr: stderrText }));
          return;
        }
        resolve({ stdout, stderr: stderrText });
      },
    );
    const childStdin = child.stdin;
    if (childStdin !== null) {
      // A child exiting before it drains stdin makes this write EPIPE; that failure arrives through
      // the exit status, and an unhandled `error` event would crash the daemon.
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

/** The exit status a rejected invocation carries, or `null` when git did not run to an exit. */
export function readGitExitStatus(rejection: unknown): number | null {
  if (typeof rejection !== "object" || rejection === null || !("code" in rejection)) {
    return null;
  }
  return typeof rejection.code === "number" ? rejection.code : null;
}

/** What {@link createHookNeutralizedGitCommand} needs from its service. */
export interface HookNeutralizedGitDependencies {
  readonly git: GitRunner;
  readonly createDirectory: (path: string) => Promise<void>;
  readonly executionRootsDirectory: string;
  readonly timeoutMs: number;
}

/**
 * A service's single git entry point. It prepends `-c core.hooksPath=<empty dir>` and
 * `-c core.fsmonitor=false`, so no call can run a repository hook: a command-line `-c` outranks all
 * config, and the fsmonitor hook is named by config value, so `hooksPath` never governs it.
 *
 * The directory is created per call: a temp-file reaper that removed it would silently restore the
 * repository's hooks. Checkout filter drivers are not neutralized: their commands come from git
 * config, and disabling smudge would corrupt LFS. Probed, no flag needed:
 * `uploadpack.packObjectsHook` is honored only from protected config, and
 * `core.alternateRefsCommand` fires only on receive-pack, which no daemon verb engages.
 */
export function createHookNeutralizedGitCommand(
  dependencies: HookNeutralizedGitDependencies,
): GitCommand {
  const hookNeutralizationDirectory: string = join(
    dependencies.executionRootsDirectory,
    HOOK_NEUTRALIZATION_SEGMENT,
  );
  return async (argv, options = {}) => {
    await dependencies.createDirectory(hookNeutralizationDirectory);
    return dependencies.git(
      [
        "-c",
        `core.hooksPath=${hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...argv,
      ],
      { ...options, timeoutMs: dependencies.timeoutMs },
    );
  };
}
