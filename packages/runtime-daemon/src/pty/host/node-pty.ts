// In-process `node-pty` implementation of the `PtyHost` contract.
//
// - The selector picks it on every platform (see `host/selector.ts`).
// - Each child is recorded through the orphan guard: its intent before the start, its process
//   after, its end; a child the guard cannot record is killed and the spawn rejects.
// - A session's output and exit wait until `spawn()` has resolved, so its caller knows the id.
// - `node-pty.kill(signal)` on Windows signals one PID and does not walk console-control or
//   process-tree semantics (microsoft/node-pty#167, #437), so the Windows kill translation
//   lives here:
//     - SIGINT maps to `GenerateConsoleCtrlEvent(CTRL_C_EVENT)`.
//     - SIGTERM maps to CTRL_BREAK_EVENT, then escalates to `taskkill /T /F` after 2 s.
//     - SIGKILL runs `taskkill /T /F` on the whole descendant tree (a single-PID kill orphans
//       children on Windows). The reap is bounded to 5 s, and `onExit` fires either way.
// - `node-pty` does not expose `GenerateConsoleCtrlEvent`, so it is bound through `koffi`, loaded
//   on the first Windows kill.
// - Every effectful primitive (`node-pty.spawn`, the FFI binding, the `taskkill` spawn, timers)
//   is injectable through `NodePtyHostDeps`, so tests run on every platform without `node-pty`,
//   `koffi` or Windows.

import { randomUUID } from "node:crypto";

import { importKoffi } from "../koffi.js";
import { HeldSessionEvents } from "./held-events.js";
import type { TerminalOperatingSystem } from "../operating-system/contract.js";
import type { OrphanGuard } from "../orphan/guard.js";
import { SPAWN_NONCE_ENVIRONMENT_NAME } from "../orphan/registry.js";
import { PtyBackendUnavailableError } from "../sidecar/binary-path.js";
import { defaultSpawnTaskkill, type TaskkillResult } from "../taskkill-windows.js";
import type { PtySignal, SpawnRequest, SpawnResponse } from "./protocol.js";
import type { DrainResult, PtyHost } from "./contract.js";

// Local types instead of `node-pty`'s own: the file never imports `node-pty` at the type layer
// (it is loaded lazily), and the types list exactly what is consumed: `pid`, `onData`,
// `onExit`, `kill`, `resize`, `write`, `pause` and `resume`.

/** Shape of a single PTY-child wrapper as returned by `node-pty.spawn`. */
export interface NodePtyChild {
  /** OS-level process id of the child attached to the PTY pair. */
  readonly pid: number;
  /** Subscribe to stdout/stderr chunks. Returns a disposable handle. */
  onData(listener: (chunk: string | Uint8Array) => void): { dispose: () => void };
  /** Subscribe to child-exit. Returns a disposable handle. */
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): {
    dispose: () => void;
  };
  /** Send a POSIX signal name to the child. POSIX-only behavior. */
  kill(signal?: string): void;
  /** Resize the PTY window. */
  resize(cols: number, rows: number): void;
  /** Write a chunk to the PTY's master FD; `callback` follows once it is written, or fails. */
  write(data: string | Uint8Array, callback: (error?: Error) => void): void;
  /** Stop reading the PTY's master FD. */
  pause(): void;
  /** Read the PTY's master FD again. */
  resume(): void;
}

/** The part of the orphan guard the host reports each child's life to. */
export type NodePtyOrphanGuard = Pick<OrphanGuard, "prepareSpawn" | "completeSpawn" | "retire">;

/** Options passed to `node-pty.spawn`. */
interface NodePtySpawnOptions {
  readonly name?: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /**
   * Must stay `false` until microsoft/node-pty#894 is fixed: `true` opts into the bundled
   * ConPTY DLL, which delays PowerShell 7 startup by 3.5 s.
   */
  readonly useConptyDll?: false;
}

/** Factory shape of `node-pty.spawn`, as exported by the pinned `node-pty` version. */
export type NodePtySpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodePtySpawnOptions,
) => NodePtyChild;

/** Windows console-control event codes per Win32 `GenerateConsoleCtrlEvent`. */
export type ConsoleCtrlEvent = 0 | 1; // CTRL_C_EVENT | CTRL_BREAK_EVENT

/**
 * Effectful primitives `NodePtyHost` reaches through, all injectable so tests run on every
 * platform with `vi.fn()` doubles. Callers pass `Partial<NodePtyHostDeps>` to the constructor;
 * missing fields get production implementations.
 */
export interface NodePtyHostDeps {
  /** Effective platform. Defaults to `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `node-pty.spawn` factory. Production loads the real one on first spawn when not injected. */
  readonly ptySpawn: NodePtySpawnFn;
  /** Windows-only `GenerateConsoleCtrlEvent(event, pid)`; unused when `platform` is not `win32`. */
  readonly generateConsoleCtrlEvent?: (event: ConsoleCtrlEvent, pid: number) => void;
  /** Windows-only `taskkill /T /F /PID <pid>`; unused when `platform` is not `win32`. */
  readonly spawnTaskkill?: (pid: number) => Promise<TaskkillResult>;
  /** Timer for the escalation and reap budgets; tests swap in fake timers. */
  readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Cancels a timer created by `setTimer`. */
  readonly clearTimer: (handle: NodeJS.Timeout) => void;
  /** Signals a whole process group, as `process.kill(-leaderId, signal)` does. */
  readonly signalProcessGroup: (leaderId: number, signal: NodeJS.Signals) => void;
}

/** `NodePtyHostDeps` after defaults; a `null` `ptySpawn` means `node-pty` loads on first spawn. */
interface ResolvedNodePtyHostDeps {
  readonly platform: NodeJS.Platform;
  readonly ptySpawn: NodePtySpawnFn | null;
  readonly generateConsoleCtrlEvent?: (event: ConsoleCtrlEvent, pid: number) => void;
  readonly spawnTaskkill?: (pid: number) => Promise<TaskkillResult>;
  readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer: (handle: NodeJS.Timeout) => void;
  readonly signalProcessGroup: (leaderId: number, signal: NodeJS.Signals) => void;
}

interface PtySessionRecord {
  /** Underlying `node-pty` child. */
  readonly child: NodePtyChild;
  /** The nonce the orphan registry records the child under. */
  readonly nonce: string;
  /** The consumer's data and exit, held while `spawn()` has not resolved. */
  readonly heldEvents: HeldSessionEvents;
  /** Whether the consumer paused the read, and whether the read is paused now. */
  isPausedByConsumer: boolean;
  isReadPaused: boolean;
  /** The consumer-facing listeners on the child, which `close()` disposes. */
  readonly subscriptions: Array<{ dispose: () => void }>;
  /**
   * `true` once `onExit` has fired for this session, from the child's own exit or the synthetic
   * taskkill exit. Write-once, so the exit is reported exactly once and a later `kill()` sends
   * nothing.
   */
  hasExited: boolean;
  /** Pending escalation timer, if `SIGTERM` is mid-flight on Windows. */
  pendingEscalation: NodeJS.Timeout | null;
  /**
   * `true` once `invokeTaskkill` has committed to the forced kill for this session. It lets the
   * shutdown drain count a session killed by the taskkill escalation as forced rather than
   * drained. Set only in `invokeTaskkill`, never reset.
   */
  escalated: boolean;
}

// The real `node-pty` and `koffi` bindings load through dynamic `import(...)`, so nothing couples
// the file to them at module load.

/** Lazily resolve `node-pty.spawn`. Called on the first `spawn()` call. */
async function loadNodePtySpawn(): Promise<NodePtySpawnFn> {
  // The specifier sits in a variable so TypeScript does not resolve the module statically.
  // `.default ?? mod` covers both ESM-bridge shapes: `cjs-module-lexer` cannot always detect
  // named exports of a CJS package, in which case the binding lives on `.default`.
  const specifier: string = "node-pty";
  const ptyMod = (await import(specifier)) as {
    default?: { spawn: NodePtySpawnFn };
    spawn?: NodePtySpawnFn;
  };
  const nodePty: { spawn?: NodePtySpawnFn } = ptyMod.default ?? ptyMod;
  if (typeof nodePty.spawn !== "function") {
    throw new Error(
      "loadNodePtySpawn: `node-pty` module did not expose a `spawn` " +
        "function (checked both default-export and named-export shapes). " +
        "This usually means the installed `node-pty` version's ESM-bridge " +
        "shape changed; pin the dep to a known-good version or update this " +
        "loader.",
    );
  }
  return nodePty.spawn;
}

/**
 * Binds `GenerateConsoleCtrlEvent` from `kernel32.dll` through `koffi` on first use.
 * Throws with an install hint when `koffi` cannot be loaded. Only the Windows kill path calls it.
 */
async function loadGenerateConsoleCtrlEvent(): Promise<
  (event: ConsoleCtrlEvent, pid: number) => void
> {
  // No platform guard: tests inject the FFI seam directly, and a real Windows failure surfaces
  // with its own diagnostics.
  const koffi = await importKoffi("Windows kill-translation");
  const kernel32 = koffi.load("kernel32.dll");
  const binding = kernel32.func(
    "int __stdcall GenerateConsoleCtrlEvent(uint32 dwCtrlEvent, uint32 dwProcessGroupId)",
  );
  return (event: ConsoleCtrlEvent, pid: number): void => {
    binding(event, pid);
  };
}

/**
 * In-process `node-pty` implementation of `PtyHost`. After `shutdown()` the instance is terminal:
 * `spawn()` rejects with `PtyBackendUnavailableError`, so create a new host for new sessions.
 */
export class NodePtyHost implements PtyHost {
  /** Per-session table keyed by the host-minted session id. */
  private readonly sessions = new Map<string, PtySessionRecord>();

  /** Lazily-resolved `node-pty.spawn`. Cached after first call. */
  private cachedPtySpawn: NodePtySpawnFn | null = null;

  /** Lazily-resolved `GenerateConsoleCtrlEvent` binding. Cached after first call. */
  private cachedGCCE: ((event: ConsoleCtrlEvent, pid: number) => void) | null = null;

  /** Effective deps record after constructor wiring. */
  private readonly deps: ResolvedNodePtyHostDeps;

  /** Records each child in the orphan registry from before its start to its end. */
  private readonly orphanGuard: NodePtyOrphanGuard;

  /** How each child starts on the system the daemon runs on. */
  private readonly operatingSystem: TerminalOperatingSystem;

  /** Consumer callbacks; no-ops until the daemon registers its own with `setOnData`/`setOnExit`. */
  private dataListener: (sessionId: string, chunk: Uint8Array) => void = () => {};

  private exitListener: (sessionId: string, exitCode: number, signalCode?: number) => void =
    () => {};

  /** Memoized `shutdown()` result, so a second call awaits the same drain. */
  private shutdownPromise: Promise<DrainResult> | null = null;

  /**
   * Set at `shutdown()` entry. Any later `spawn()` rejects, so no session can register after the
   * `activeSessionIds` snapshot and escape the drain.
   */
  private shuttingDown: boolean = false;

  /**
   * Per-session drain resolvers, set while `shutdown()` drains. The outcome distinguishes a
   * natural exit (`"drained"`) from a taskkill-forced one (`"forced"`).
   */
  private readonly shutdownWaiters: Map<string, (result: "drained" | "forced") => void> = new Map();

  /** Partial `deps` merge with production defaults. */
  public constructor(
    orphanGuard: NodePtyOrphanGuard,
    operatingSystem: TerminalOperatingSystem,
    deps?: Partial<NodePtyHostDeps>,
  ) {
    this.orphanGuard = orphanGuard;
    this.operatingSystem = operatingSystem;
    this.deps = resolveDefaultDeps(deps ?? {});
  }

  // ---- PtyHost methods --------------------------------------------------

  /**
   * Starts a PTY child and returns its session id. Rejects once `shutdown()` has begun, and when
   * the orphan registry cannot record the child, which is then killed.
   */
  public async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    if (this.shuttingDown) {
      // Refuse new spawns so no PTY child can outlive `shutdown()`.
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "node-pty" },
        "NodePtyHost: shutdown() in progress or complete; " +
          "the host is terminal — re-create a fresh instance for new sessions.",
      );
    }
    const ptySpawn: NodePtySpawnFn = await this.resolvePtySpawn();
    // The intent is durable before the child exists, so a crash at any later moment leaves the
    // registry able to find it.
    const nonce: string = await this.orphanGuard.prepareSpawn();
    const env: Record<string, string> = {
      ...envTuplesToRecord(spec.env),
      [SPAWN_NONCE_ENVIRONMENT_NAME]: nonce,
    };

    let child: NodePtyChild;
    try {
      if (this.shuttingDown) {
        // `shutdown()` may have started during the awaits above, after the drain snapshot was
        // taken. Reject before `ptySpawn`, so no orphan child exists to clean up.
        throw new PtyBackendUnavailableError(
          { attemptedBackend: "node-pty" },
          "NodePtyHost: shutdown() in progress or complete; " +
            "the host is terminal — re-create a fresh instance for new sessions.",
        );
      }
      const launch = this.operatingSystem.launchTerminalChild(spec.command, spec.args, process.pid);
      child = ptySpawn(launch.command, launch.args, {
        name: spec.terminal_name ?? "xterm-color",
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env,
        // Must stay `false`; see `NodePtySpawnOptions.useConptyDll`.
        useConptyDll: false,
      });
    } catch (error) {
      this.orphanGuard.retire(nonce);
      throw error;
    }

    // Not `mintUuidV7`: this is a host-local handle, dead when the PTY closes, with a
    // backend-private format (the Rust sidecar backend mints `s-{n}`), and no row stores it.
    const sessionId: string = randomUUID();
    // One record shared by the listeners and the map, so exits seen in `child.onExit` are
    // visible to `kill()`.
    const record: PtySessionRecord = {
      child,
      nonce,
      heldEvents: new HeldSessionEvents(() => {
        this.applyReadPause(record);
      }),
      isPausedByConsumer: false,
      isReadPaused: false,
      subscriptions: [],
      hasExited: false,
      pendingEscalation: null,
      escalated: false,
    };

    // Kept through `close()`, so a closed child that ignores the hangup is retired when it ends.
    child.onExit(() => {
      this.orphanGuard.retire(nonce);
    });
    record.subscriptions.push(
      child.onData((chunk: string | Uint8Array) => {
        const bytes: Uint8Array =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        record.heldEvents.deliver(() => {
          this.dataListener(sessionId, bytes);
        }, bytes.byteLength);
      }),
    );
    record.subscriptions.push(
      child.onExit((event: { exitCode: number; signal?: number | undefined }) => {
        // The child exited on its own, so the taskkill escalation is no longer needed.
        this.clearPendingEscalation(record);
        // `invokeTaskkill` already reported a synthetic exit (code 1); the exit is reported once.
        if (record.hasExited) {
          // The synthetic exit only happens after the forced kill, so a waiting `shutdown()`
          // gets `"forced"`.
          this.notifyShutdownWaiter(sessionId, "forced");
          return;
        }
        record.hasExited = true;
        record.heldEvents.deliver(() => {
          this.fireExit(sessionId, event.exitCode, event.signal);
        }, 0);
        // Notify after `fireExit` so listeners see the exit before the drain completes. On Windows
        // the 2 s taskkill escalation can win before the drain timeout, so the outcome reads
        // `record.escalated`. The closure-captured `record` is used, not a `sessions` lookup, so a
        // concurrent `close()` cannot change it.
        this.notifyShutdownWaiter(sessionId, record.escalated ? "forced" : "drained");
      }),
    );

    this.sessions.set(sessionId, record);
    // Listeners attach before this read, so an exit during it is still seen.
    try {
      await this.orphanGuard.completeSpawn(nonce, child.pid);
    } catch (failure) {
      await this.killUnrecordedChild(sessionId, record, failure);
    }
    this.releaseHeldDeliveries(sessionId, record);

    return { kind: "spawn_response", session_id: sessionId };
  }

  /** Resizes the PTY. Throws for an unknown session id. */
  public async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.resize: unknown sessionId '${sessionId}'`);
    }
    record.child.resize(cols, rows);
  }

  /**
   * Writes bytes to the PTY, resolving once all of them are written, so a program that is not
   * reading holds its writer back. Rejects for an unknown session id and a terminal that closed.
   */
  public async write(sessionId: string, bytes: Uint8Array): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.write: unknown sessionId '${sessionId}'`);
    }
    const written = Promise.withResolvers<void>();
    record.child.write(bytes, (error) => {
      if (error === undefined) {
        written.resolve();
      } else {
        written.reject(error);
      }
    });
    await written.promise;
  }

  /** Stops reading the PTY. Throws for an unknown session id; an exited child gets nothing. */
  public async pause(sessionId: string): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.pause: unknown sessionId '${sessionId}'`);
    }
    record.isPausedByConsumer = true;
    this.applyReadPause(record);
  }

  /** Reads the PTY again. Throws for an unknown session id; an exited child gets nothing. */
  public async resume(sessionId: string): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.resume: unknown sessionId '${sessionId}'`);
    }
    record.isPausedByConsumer = false;
    this.applyReadPause(record);
  }

  /**
   * Sends `signal` to the session's child. Throws for an unknown session id; a child that
   * already exited gets nothing, and its exit is not reported again.
   *
   * On Windows the signal is translated: SIGINT sends CTRL_C_EVENT, SIGTERM sends CTRL_BREAK_EVENT
   * and escalates to `taskkill /T /F` after 2 s, SIGKILL runs `taskkill /T /F` directly, and
   * SIGHUP behaves like SIGTERM. Elsewhere it calls `node-pty.kill(signal)`.
   *
   * It resolves once the kill has begun, not when the child has exited (the `KillResponse` ack
   * contract), so the taskkill paths are fire-and-forget; awaiting a stuck taskkill would block
   * the caller for up to 5 s. The exit arrives through `onExit`.
   */
  public async kill(sessionId: string, signal: PtySignal): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.kill: unknown sessionId '${sessionId}'`);
    }

    if (record.hasExited) {
      return;
    }

    if (this.deps.platform === "win32") {
      await this.killOnWindows(sessionId, record, signal);
      return;
    }

    // POSIX: `node-pty` takes the signal name.
    record.child.kill(signal);
  }

  /** Disposes the session and stops its child. Closing an unknown session is not an error. */
  public async close(sessionId: string): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    // Cancel a pending escalation so a stale `taskkill` cannot fire 2 s after close.
    this.clearPendingEscalation(record);
    // Dispose listeners before killing, so an exit landing during the kill reaches nobody.
    for (const sub of record.subscriptions) {
      sub.dispose();
    }
    // On Windows `child.kill()` would orphan descendants (see the file header), so use the same
    // `taskkill /T /F` as `kill(SIGKILL)`. Fire-and-forget: close must not wait for the reap.
    if (!record.hasExited) {
      if (this.deps.platform === "win32") {
        // The synthetic exit from `invokeTaskkill` is suppressed by the `sessions.delete` below:
        // after `close()` nothing is emitted for this session.
        void this.invokeTaskkill(sessionId, record, record.child.pid);
      } else {
        // POSIX: the TTY's foreground-process-group semantics carry the kill to descendants.
        // Close does not fail on a child that is already gone; the failure is logged.
        try {
          record.child.kill();
        } catch (err: unknown) {
          console.warn(`NodePtyHost: close: child.kill() threw for session=${sessionId}.`, {
            cause: err,
          });
        }
      }
    }
    this.sessions.delete(sessionId);
  }

  // A child the orphan registry could not record must not outlive its spawn, which rejects with
  // why; its whole tree is killed outright, since a hangup can be ignored.
  private async killUnrecordedChild(
    sessionId: string,
    record: PtySessionRecord,
    failure: unknown,
  ): Promise<never> {
    if (this.deps.platform === "win32") {
      // There `close()` ends the tree with `taskkill /T /F`.
      await this.close(sessionId);
      throw failure;
    }
    for (const subscription of record.subscriptions) {
      subscription.dispose();
    }
    this.sessions.delete(sessionId);
    try {
      // The child leads its own process group.
      this.deps.signalProcessGroup(record.child.pid, "SIGKILL");
    } catch (killError: unknown) {
      // A group already gone needs no kill; any other refusal leaves it running.
      if (!(killError instanceof Error && "code" in killError && killError.code === "ESRCH")) {
        throw new AggregateError(
          [failure, killError],
          "The orphan registry could not record a terminal child, and killing it failed",
          { cause: killError },
        );
      }
    }
    throw failure;
  }

  // Delivers what was held on a later turn, once the caller of `spawn()` has the session id,
  // holding what comes meanwhile so the order stands; with nothing held, events go straight on.
  private releaseHeldDeliveries(sessionId: string, record: PtySessionRecord): void {
    if (!record.heldEvents.isHolding) {
      record.heldEvents.release();
      return;
    }
    setImmediate(() => {
      const held = record.heldEvents.release();
      if (this.sessions.get(sessionId) !== record) {
        return;
      }
      for (const delivery of held) {
        delivery();
      }
      this.applyReadPause(record);
    }).unref();
  }

  // Pauses the read while the consumer asked or too much output is held; skips an exited child.
  private applyReadPause(record: PtySessionRecord): void {
    const shouldPause = record.isPausedByConsumer || record.heldEvents.isOverBound;
    if (shouldPause === record.isReadPaused || record.hasExited) {
      return;
    }
    record.isReadPaused = shouldPause;
    if (shouldPause) {
      record.child.pause();
    } else {
      record.child.resume();
    }
  }

  /**
   * Drains every active session before daemon shutdown and reports how each ended. Each live
   * session gets SIGTERM and up to `perSessionTimeoutMs` to exit; after that it is killed with
   * SIGKILL and counted in `sessionsForcedKilled`. A session that exits earlier counts as drained,
   * unless the Windows taskkill escalation killed it.
   *
   * `hostTimeoutMs` is ignored and the host fields of the result are vacuous, since there is no
   * sidecar. A second call returns the same in-flight Promise. The host is terminal afterwards:
   * `spawn()` rejects with `PtyBackendUnavailableError`.
   */
  public shutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    // Not `async`: a wrapper would return a new Promise per call instead of the memoized one.
    this.shutdownPromise = this.runShutdown(options);
    return this.shutdownPromise;
  }

  private async runShutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    // `hostTimeoutMs` only bounds the sidecar wind-down of the other backend.
    void options.hostTimeoutMs;

    // Set the flag before the snapshot so a racing `spawn()` is rejected instead of escaping it.
    this.shuttingDown = true;

    const activeSessionIds: string[] = Array.from(this.sessions.keys()).filter((sessionId) => {
      const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
      return record !== undefined && !record.hasExited;
    });

    const perSessionOutcomes: Array<"drained" | "forced"> = await Promise.all(
      activeSessionIds.map((sessionId) =>
        this.drainSingleSession(sessionId, options.perSessionTimeoutMs),
      ),
    );

    let sessionsDrained = 0;
    let sessionsForcedKilled = 0;
    for (const outcome of perSessionOutcomes) {
      if (outcome === "drained") {
        sessionsDrained++;
      } else {
        sessionsForcedKilled++;
      }
    }

    return {
      sessionsDrained,
      sessionsForcedKilled,
      // No sidecar process to drain.
      sidecarExitedCleanly: true,
      taskkillEscalated: false,
    };
  }

  /**
   * Drains one session: SIGTERM, then SIGKILL after `timeoutMs`. Returns the outcome for the
   * `DrainResult` counters. The waiter is installed before the kill so the exit cannot be missed.
   */
  private async drainSingleSession(
    sessionId: string,
    timeoutMs: number,
  ): Promise<"drained" | "forced"> {
    const drainWaiter: Promise<"drained" | "forced"> = new Promise<"drained" | "forced">(
      (resolve) => {
        this.shutdownWaiters.set(sessionId, resolve);
      },
    );

    try {
      // Go through `kill()` so the Windows translation and POSIX path stay in one place. A failed
      // kill is logged, not thrown: the timeout below still bounds the drain and escalates.
      try {
        await this.kill(sessionId, "SIGTERM");
      } catch (err: unknown) {
        console.warn(`NodePtyHost: shutdown: SIGTERM failed for session=${sessionId}.`, {
          cause: err,
        });
      }

      // The injected timer lets tests advance time under fake timers.
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise: Promise<"timeout"> = new Promise<"timeout">((resolve) => {
        timeoutHandle = this.deps.setTimer(() => {
          resolve("timeout");
        }, timeoutMs);
      });

      // The waiter already carries its outcome ("forced" when taskkill did the kill), so nothing
      // needs re-reading from the record.
      const outcome: "drained" | "forced" | "timeout" = await Promise.race([
        drainWaiter,
        timeoutPromise,
      ]);

      if (timeoutHandle !== null) {
        this.deps.clearTimer(timeoutHandle);
      }

      if (outcome !== "timeout") {
        // A Windows taskkill escalation can beat the timeout, so a resolved outcome may be
        // "forced".
        return outcome;
      }

      // Timed out: SIGKILL is fire-and-forget and shutdown does not wait for the exit. A failed
      // escalation is logged; the session still counts as forced.
      try {
        await this.kill(sessionId, "SIGKILL");
      } catch (err: unknown) {
        console.warn(`NodePtyHost: shutdown: SIGKILL escalation failed for session=${sessionId}.`, {
          cause: err,
        });
      }
      return "forced";
    } finally {
      this.shutdownWaiters.delete(sessionId);
    }
  }

  /**
   * Resolves the session's shutdown waiter, if a drain is waiting, with the drain outcome.
   * Callers pass `"forced"` from `invokeTaskkill` and from the duplicate-exit branch that follows
   * it, and `record.escalated ? "forced" : "drained"` from the natural-exit branch.
   */
  private notifyShutdownWaiter(sessionId: string, result: "drained" | "forced"): void {
    const resolver: ((result: "drained" | "forced") => void) | undefined =
      this.shutdownWaiters.get(sessionId);
    if (resolver !== undefined) {
      resolver(result);
    }
  }

  // ---- PtyHost callback surface (settable by the daemon) ----------------

  /** Register the daemon's data-chunk consumer. */
  public setOnData(listener: (sessionId: string, chunk: Uint8Array) => void): void {
    this.dataListener = listener;
  }

  /** Register the daemon's exit-event consumer. */
  public setOnExit(
    listener: (sessionId: string, exitCode: number, signalCode?: number) => void,
  ): void {
    this.exitListener = listener;
  }

  // ---- Internals --------------------------------------------------------

  private fireExit(sessionId: string, exitCode: number, signalCode: number | undefined): void {
    if (signalCode === undefined) {
      this.exitListener(sessionId, exitCode);
    } else {
      this.exitListener(sessionId, exitCode, signalCode);
    }
  }

  private async resolvePtySpawn(): Promise<NodePtySpawnFn> {
    if (this.cachedPtySpawn !== null) {
      return this.cachedPtySpawn;
    }
    if (this.deps.ptySpawn !== null) {
      this.cachedPtySpawn = this.deps.ptySpawn;
      return this.cachedPtySpawn;
    }
    // `node-pty` is a hard dependency; it loads here on first use.
    this.cachedPtySpawn = await loadNodePtySpawn();
    return this.cachedPtySpawn;
  }

  private async killOnWindows(
    sessionId: string,
    record: PtySessionRecord,
    signal: PtySignal,
  ): Promise<void> {
    const pid: number = record.child.pid;

    // Every signal clears a stale timer first: otherwise an old SIGTERM timer would fire taskkill
    // 2 s later, possibly on a recycled PID.
    this.clearPendingEscalation(record);

    if (signal === "SIGINT") {
      // CTRL_C_EVENT is 0.
      const gcce = await this.resolveGCCE();
      gcce(0, pid);
      return;
    }

    if (signal === "SIGKILL") {
      // Skip CTRL_BREAK_EVENT. `/T` kills the descendant tree; `/F` kills processes that ignore
      // graceful signals. Not awaited: `kill()` acks once the kill has begun, and a stuck taskkill
      // would otherwise block it for up to 5 s (see `kill`).
      void this.invokeTaskkill(sessionId, record, pid);
      return;
    }

    // SIGTERM and SIGHUP: graceful CTRL_BREAK_EVENT, then taskkill if the child has not exited
    // within 2 s.
    const gcce = await this.resolveGCCE();
    // CTRL_BREAK_EVENT is 1.
    gcce(1, pid);

    // The exit handler in `spawn` clears this timer if the child exits first.
    record.pendingEscalation = this.deps.setTimer(() => {
      // The child may have exited between arming and firing.
      if (record.hasExited) {
        record.pendingEscalation = null;
        return;
      }
      void this.invokeTaskkill(sessionId, record, pid);
    }, 2000);
  }

  /** Cancels the pending Windows escalation timer, if any. */
  private clearPendingEscalation(record: PtySessionRecord): void {
    if (record.pendingEscalation !== null) {
      this.deps.clearTimer(record.pendingEscalation);
      record.pendingEscalation = null;
    }
  }

  private async resolveGCCE(): Promise<(event: ConsoleCtrlEvent, pid: number) => void> {
    if (this.cachedGCCE !== null) {
      return this.cachedGCCE;
    }
    if (this.deps.generateConsoleCtrlEvent !== undefined) {
      this.cachedGCCE = this.deps.generateConsoleCtrlEvent;
      return this.cachedGCCE;
    }
    this.cachedGCCE = await loadGenerateConsoleCtrlEvent();
    return this.cachedGCCE;
  }

  private async invokeTaskkill(
    sessionId: string,
    record: PtySessionRecord,
    pid: number,
  ): Promise<void> {
    record.pendingEscalation = null;
    // Committed to the forced kill. Set before the await so the exit handler in `spawn` reads
    // `escalated === true` however soon the OS reaps the child. Both callers (SIGKILL, and the
    // SIGTERM timer after its exit re-check) know the child has not exited naturally.
    record.escalated = true;
    const spawnTaskkill = this.deps.spawnTaskkill ?? ((p: number) => defaultSpawnTaskkill(p));

    // Bound `spawnTaskkill` to 5 s so a stuck OS call cannot hang the daemon; healthy taskkill
    // takes well under a second. If the timer wins, the synthetic exit below still fires. The
    // injected timers keep this testable under fake timers.
    await new Promise<void>((resolve) => {
      let settled = false;
      const fallbackHandle = this.deps.setTimer(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 5000);
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.deps.clearTimer(fallbackHandle);
        resolve();
      };
      // `finish()` runs when taskkill settles, resolved or rejected, unless the timer won first.
      void (async (): Promise<void> => {
        try {
          await spawnTaskkill(pid);
        } catch (err: unknown) {
          // A failed taskkill must not stop the synthetic `onExit`, so it is logged, not thrown.
          // Without the log, a persistent failure (bad PATH, blocked taskkill.exe) looks like a
          // healthy exit.
          console.warn(
            `NodePtyHost: invokeTaskkill: spawnTaskkill rejected for ` +
              `session=${sessionId} pid=${pid}; synthetic onExit will ` +
              `fire to honor.`,
            { cause: err },
          );
        }
        finish();
      })();
    });

    // Emit an exit even if the reap is incomplete: code 1 with no signal means "killed by the
    // daemon, OS reap status unknown". A later real `child.onExit` is ignored because
    // `hasExited` is write-once.
    //
    // `sessions.has` gates the emit so a `close()` that landed during the await above (it is the
    // only place sessions are deleted) cannot produce an exit after teardown.
    if (!record.hasExited && this.sessions.has(sessionId)) {
      record.hasExited = true;
      this.fireExit(sessionId, 1, undefined);
      // Resolve the drain waiter now instead of waiting for `child.onExit`, which is best-effort.
      // This is the forced-kill path, so the outcome is always "forced".
      this.notifyShutdownWaiter(sessionId, "forced");
    }
  }
}

/** Converts wire env tuples to the record `node-pty.spawn` takes; the last duplicate key wins. */
function envTuplesToRecord(
  tuples: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of tuples) {
    record[key] = value;
  }
  return record;
}

/**
 * Merges partial deps with production defaults. A `null` `ptySpawn` means `node-pty` loads on
 * first spawn, so tests that inject it and non-Windows hosts never load `node-pty` or `koffi`.
 */
function resolveDefaultDeps(partial: Partial<NodePtyHostDeps>): ResolvedNodePtyHostDeps {
  // The optional fields are spread conditionally: `exactOptionalPropertyTypes` forbids assigning
  // `undefined` to them, and spreading `false` from `cond && obj` fails type inference.
  const base: {
    readonly platform: NodeJS.Platform;
    readonly ptySpawn: NodePtySpawnFn | null;
    readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
    readonly clearTimer: (handle: NodeJS.Timeout) => void;
    readonly signalProcessGroup: (leaderId: number, signal: NodeJS.Signals) => void;
  } = {
    platform: partial.platform ?? process.platform,
    ptySpawn: partial.ptySpawn ?? null,
    setTimer: partial.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
    clearTimer: partial.clearTimer ?? ((handle) => clearTimeout(handle)),
    signalProcessGroup:
      partial.signalProcessGroup ??
      ((leaderId, signal) => {
        process.kill(-leaderId, signal);
      }),
  };
  return {
    ...base,
    ...(partial.generateConsoleCtrlEvent !== undefined
      ? { generateConsoleCtrlEvent: partial.generateConsoleCtrlEvent }
      : {}),
    ...(partial.spawnTaskkill !== undefined ? { spawnTaskkill: partial.spawnTaskkill } : {}),
  };
}
