// Windows `taskkill /T /F /PID` primitive shared by both PTY backends.
//
// `NodePtyHost.invokeTaskkill` (per-session escalation) and
// `RustSidecarPtyHost.escalateHardKillTree` (host-shutdown escalation) need the same OS behavior:
// `/T` walks the target's descendant tree and `/F` force-terminates each entry. It lives here so
// neither backend duplicates the spawn and the `error` / `exit` handler wiring.
//
// The caller, not this module, bounds the wall-clock wait (each host races the call against a 5 s
// timer), so the bound holds for an injected mock as well as for this default.

/** Result of a `taskkill` invocation. */
export interface TaskkillResult {
  /** Exit code of the `taskkill` process, or `null` if killed by signal. */
  readonly exitCode: number | null;
}

/**
 * Spawns `taskkill /T /F /PID <pid>` and resolves with its exit code. It never rejects: a spawn
 * failure resolves with `exitCode: null` so the caller can still fire its synthetic exit.
 */
export async function defaultSpawnTaskkill(pid: number): Promise<TaskkillResult> {
  // No `process.platform` guard: tests inject `spawnTaskkill` directly, and the hosts only reach
  // this loader on Windows. The import is dynamic so `node:child_process` loads only there.
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
      // distinguishable in logs from a healthy exit. Replace `console.warn` once the daemon has a
      // structured logger.
      console.warn(
        `defaultSpawnTaskkill: taskkill spawn failed for pid=${pid}; ` +
          `treating as exit=null so caller can fire synthetic exit.`,
        { cause: err },
      );
      resolve({ exitCode: null });
    });
  });
}
