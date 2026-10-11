// How Windows ends a process tree: no signal reaches a tree there, so `taskkill /T /F /PID` walks
// the root's descendants (`/T`) and ends each outright (`/F`). The terminal hosts, the provider
// drivers and the daemon's own children all end a tree through it.

import type { ProcessTreeEnding } from "./contract.js";

// `taskkill` exits 128 when no process has the id: the tree is already gone.
const TASKKILL_NO_SUCH_PROCESS_EXIT_CODE = 128;

/** How long a bounded `taskkill` is waited for; a healthy one takes under a second. */
const TASKKILL_BOUND_MS = 5_000;

/** Result of a `taskkill` invocation. */
export interface TaskkillResult {
  /** Exit code of the `taskkill` process, or `null` if killed by signal. */
  readonly exitCode: number | null;
}

/** Runs `taskkill /T /F /PID <pid>`; a test hands in a double. */
export type TaskkillRunner = (pid: number) => Promise<TaskkillResult>;

/**
 * Spawns `taskkill /T /F /PID <pid>` and resolves with its exit code. It never rejects: a spawn
 * failure resolves with `exitCode: null` so the caller can still fire its synthetic exit.
 */
export async function defaultSpawnTaskkill(pid: number): Promise<TaskkillResult> {
  // The import is dynamic so `node:child_process` loads only where a tree is ended this way.
  const cp: typeof import("node:child_process") = await import("node:child_process");
  return await new Promise<TaskkillResult>((resolve) => {
    const proc = cp.spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
    });
    proc.once("exit", (code: number | null) => {
      resolve({ exitCode: code });
    });
    proc.once("error", (err: Error) => {
      // `taskkill` itself failed to spawn (binary missing, PATH stripped, blocked by antivirus).
      // Resolve anyway so the kill path continues, and warn so a persistent misconfiguration is
      // distinguishable in logs from a healthy exit.
      console.warn(
        `defaultSpawnTaskkill: taskkill spawn failed for pid=${pid}; ` +
          `treating as exit=null so caller can fire synthetic exit.`,
        { cause: err },
      );
      resolve({ exitCode: null });
    });
  });
}

/**
 * Runs `taskkill` on `pid` through `runTaskkill` and resolves once it settles or 5 s have passed,
 * so a stuck call cannot hang its caller. Never rejects: a rejected run is handed to `onRejected`.
 */
export async function runTaskkillWithin(
  pid: number,
  runTaskkill: TaskkillRunner,
  onRejected: (error: unknown) => void,
): Promise<void> {
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    boundTimer = setTimeout(resolve, TASKKILL_BOUND_MS);
  });
  const run = runTaskkill(pid).then(
    () => undefined,
    (error: unknown) => {
      onRejected(error);
    },
  );
  await Promise.race([run, bound]);
  clearTimeout(boundTimer);
}

/** A tree ended from its root by `taskkill`, whatever the signal; the root stays in our group. */
export const WINDOWS_PROCESS_TREE_ENDING: ProcessTreeEnding = {
  startsOwnGroup: false,
  endProcessTree: async (pid) => {
    const { exitCode } = await defaultSpawnTaskkill(pid);
    if (exitCode !== 0 && exitCode !== TASKKILL_NO_SUCH_PROCESS_EXIT_CODE) {
      throw new Error(`taskkill could not end process ${String(pid)} (exit ${String(exitCode)})`);
    }
  },
};
