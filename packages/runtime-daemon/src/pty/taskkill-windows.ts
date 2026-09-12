// Shared Windows `taskkill /T /F /PID` OS-level primitive.
//
// Why this exists
// ---------------
//
// `taskkill /T /F /PID <pid>` is a Windows-only command that walks the
// descendant process tree of the target pid (via ToolHelp32 enumeration)
// and forcibly terminates each entry. It is the load-bearing primitive
// behind `taskkill /T /F` the entire descendant tree) AND behind.
//
// Both `NodePtyHost.invokeTaskkill` (per-session escalation on the
// node-pty backend) and `RustSidecarPtyHost.escalateHardKillTree` (host-
// shutdown escalation on the rust-sidecar backend) require the same
// OS-level behavior, so the primitive lives here rather than in either
// backend. This avoids duplicating the `node:child_process.spawn` shape
// + the `error` / `exit` handler wiring + the `console.warn` TRIPWIRE
// across two files.
//
// Wall-clock bounding for is enforced by the *caller* — each host wraps
// the invocation in a race against a 5 s timer. Centralizing the timeout
// in the call site means it applies regardless of which `spawnTaskkill`
// implementation (injected mock vs default loader) is in play; the
// matching regression tests can inject a never-resolving mock and still
// observe the synthetic onExit / drain resolution fire on schedule.
//

/** Result of a `taskkill` invocation. */
export interface TaskkillResult {
  /** Exit code of the `taskkill` process, or `null` if killed by signal. */
  readonly exitCode: number | null;
}

/**
 * Spawn `taskkill /T /F /PID <pid>` and resolve with its exit-code.
 *
 * Uses `node:child_process` directly — no FFI involved. The /T flag
 * walks the descendant tree (the load-bearing piece for); /F forces
 * termination of processes that ignore graceful signals.
 */
export async function defaultSpawnTaskkill(pid: number): Promise<TaskkillResult> {
  // No `process.platform` guard here: see the
  // matching note in `loadGenerateConsoleCtrlEvent` above. Tests
  // inject `spawnTaskkill` directly; the production Windows path
  // never reaches this loader on non-Windows because the host's
  // `killOnWindows` is gated on `deps.platform === "win32"`.
  // Dynamic import so `node:child_process` is only paid for on the
  // Windows path. Static `import` would be fine too — keeping the
  // lazy-import pattern uniform with the other Windows-only loads.
  //
  // Wall-clock bounding for is enforced by the *caller*
  // (`NodePtyHost.invokeTaskkill`), not here. Centralizing the timeout
  // in the host means it applies
  // regardless of which `spawnTaskkill` implementation (injected
  // mock vs default loader) is in play, so the invariant is locally
  // enforced and the matching regression test in
  // `tree-kill.test.ts` can inject a never-resolving mock and still
  // observe the synthetic onExit fire on schedule.
  const cp: typeof import("node:child_process") = await import("node:child_process");
  return await new Promise<TaskkillResult>((resolve) => {
    const proc = cp.spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
    });
    proc.once("exit", (code: number | null) => {
      resolve({ exitCode: code });
    });
    proc.once("error", (err: Error) => {
      // `taskkill` itself failed to spawn (binary missing? Treat as a
      // non-zero outcome but still resolve so the kill path continues —
      // `onExit` MUST fire.
      //
      // Surface the cause to operators. Without
      // this breadcrumb a persistent misconfig (missing taskkill.exe,
      // PATH stripped, AV-blocked binary) is indistinguishable from a
      // healthy synthetic-exit fire from logs alone. `console.warn` is
      // the interim primitive until ships a centralized daemon-logger;
      // both call sites can be migrated then. TRIPWIRE: replace
      // `console.warn` once a structured logger surfaces in the
      // runtime-daemon.
      console.warn(
        `defaultSpawnTaskkill: taskkill spawn failed for pid=${pid}; ` +
          `treating as exit=null so caller can fire synthetic exit.`,
        { cause: err },
      );
      resolve({ exitCode: null });
    });
  });
}
