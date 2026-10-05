// The Rust PTY sidecar's child process: spawn on first use and after a crash, the stdio listeners
// and frame parser, the crash budget, and the host-level drain and hard kill at shutdown.
//
// - Crash budget: 5 crashes in a sliding 60 s window make the host permanently unavailable; every
//   call then rejects with `PtyBackendUnavailableError`. A fixed window would let a steady rate
//   through.

import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

import {
  FramingError,
  parseFrame,
  type ParseFrameResult,
} from "@ai-sidekicks/contracts/content-length-framing";

import type { TaskkillResult } from "./taskkill-windows.js";
import { PtyBackendUnavailableError } from "./sidecar-binary-path.js";
import { MAX_FRAME_BODY_BYTES, SidecarFrameDecodeError } from "./sidecar-frame-codec.js";

/** The subset of `ChildProcess` the supervisor uses, so tests can build a fake. */
export interface SidecarChildProcess {
  /** OS pid; `undefined` if spawn failed first. Only the Windows hard-kill escalation reads it. */
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The `child_process.spawn` overload the supervisor calls; it always pipes all three streams. */
export type SidecarSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

/** Width of the sliding crash-budget window. */
export const CRASH_BUDGET_WINDOW_MS = 60_000;

/** Number of crashes inside `CRASH_BUDGET_WINDOW_MS` that exhaust the crash budget. */
export const CRASH_BUDGET_LIMIT = 5;

/** Loads `spawn` lazily so a test that injects its own never pays for the import. */
async function loadDefaultSpawn(): Promise<SidecarSpawnFn> {
  const cp: typeof import("node:child_process") = await import("node:child_process");
  return cp.spawn as SidecarSpawnFn;
}

/** The supervisor's effectful primitives, defaults filled in; `spawn` is `null` until first use. */
export interface SidecarChildSupervisorDependencies {
  readonly resolveBinaryPath: () => string;
  readonly spawn: SidecarSpawnFn | null;
  readonly nowMs: () => number;
  readonly platform: NodeJS.Platform;
  readonly spawnTaskkill: (pid: number) => Promise<TaskkillResult>;
}

/** Where the supervisor hands each complete frame the child produces, and its exit or error. */
export interface SidecarChildSupervisorEvents {
  readonly onFrame: (body: Buffer) => void;
  readonly onChildExit: (
    child: SidecarChildProcess,
    code: number | null,
    signal: string | null,
  ) => void;
  readonly onChildError: (child: SidecarChildProcess, err: Error) => void;
}

/** Sliding window of recent sidecar crash timestamps; exhausting it disables the host. */
class CrashBudget {
  private readonly timestamps: number[] = [];

  public constructor(
    private readonly nowMs: () => number,
    private readonly windowMs: number = CRASH_BUDGET_WINDOW_MS,
    private readonly limit: number = CRASH_BUDGET_LIMIT,
  ) {}

  /** Records a crash and returns whether the budget is now exhausted. */
  public recordAndIsExhausted(): boolean {
    const now: number = this.nowMs();
    const cutoff: number = now - this.windowMs;
    // Timestamps are pushed in ascending order, so the stale entries are a prefix.
    let staleCount = 0;
    for (const ts of this.timestamps) {
      if (ts <= cutoff) {
        staleCount += 1;
      } else {
        break;
      }
    }
    if (staleCount > 0) {
      this.timestamps.splice(0, staleCount);
    }
    this.timestamps.push(now);
    return this.timestamps.length >= this.limit;
  }
}

/**
 * Keeps one sidecar child alive for `RustSidecarPtyHost`: spawns it, parses its stdout into frames,
 * charges the crash budget, and drains and hard-kills it at shutdown. The host owns the sessions
 * and requests and runs the teardown when the child goes away.
 */
export class SidecarChildSupervisor {
  private readonly deps: SidecarChildSupervisorDependencies;

  private readonly events: SidecarChildSupervisorEvents;

  private cachedSpawn: SidecarSpawnFn | null = null;

  private child: SidecarChildProcess | null = null;

  /**
   * The current child's unparsed stdout bytes. Emptied on every child exit or error: leftover
   * partial-frame bytes would desync the next child and burn the crash budget.
   */
  private stdoutBuffer: Buffer = Buffer.alloc(0);

  /**
   * The current child's stdout `data` listener, kept so exit and error can detach it before the
   * parser swap; late bytes from a dead child would corrupt the new parser.
   */
  private childStdoutListener: ((chunk: Buffer) => void) | null = null;

  private readonly crashBudget: CrashBudget;

  /** Set when the crash budget is exhausted; every later call rejects instead of spawning. */
  private permanentlyUnavailable = false;

  /**
   * Resolves the wait for the sidecar process to exit inside `shutdown()`; settled by
   * `handleChildExit`.
   */
  private hostExitWaiter: (() => void) | null = null;

  /**
   * Whether the active child exited or errored before `drainSidecarHost` ran, to tell "never
   * spawned" (clean) from "died before the drain" (not clean). Set after the exit and error
   * handlers' stale-event guard; cleared by `attachChildListeners`.
   */
  private childExitedBeforeDrain: boolean = false;

  /**
   * The in-flight cold-start spawn shared by concurrent callers; without it two callers could both
   * pass the `child === null` check and the second spawn would orphan the first child.
   */
  private inflightSpawn: Promise<void> | null = null;

  /**
   * Children whose crash was already counted: Node can emit both `error` and `exit` for one failed
   * child, and the second must not spend the budget again. A `WeakSet` lets the GC reclaim them.
   */
  private readonly crashCountedChildren: WeakSet<SidecarChildProcess> = new WeakSet();

  /**
   * Error stashed before a fatal `child.kill("SIGKILL")` (framing or decode failure) so the exit or
   * error handler rejects outstanding requests with it. Taken once through
   * `consumePendingTeardownCause`.
   */
  private pendingTeardownCause: Error | null = null;

  public constructor(
    deps: SidecarChildSupervisorDependencies,
    events: SidecarChildSupervisorEvents,
  ) {
    this.deps = deps;
    this.events = events;
    this.crashBudget = new CrashBudget(this.deps.nowMs);
  }

  /** The live child, or `null` before the first spawn and between a crash and the respawn. */
  public get currentChild(): SidecarChildProcess | null {
    return this.child;
  }

  /**
   * Ensures a sidecar child is alive, spawning on first use and after a crash. Throws
   * `PtyBackendUnavailableError` when the crash budget is spent, after shutdown, or when the binary
   * cannot be resolved or spawned. A failed spawn charges the crash budget; a failed resolution
   * not.
   */
  public async ensureChild(shuttingDown: boolean): Promise<void> {
    if (this.permanentlyUnavailable) {
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "rust-sidecar" },
        "RustSidecarPtyHost: crash-respawn budget exhausted " +
          `(${CRASH_BUDGET_LIMIT} crashes within ${CRASH_BUDGET_WINDOW_MS}ms); ` +
          "refusing to respawn.",
      );
    }
    if (shuttingDown) {
      // Terminal once shutdown() starts, so a concurrent spawn() cannot restart the sidecar
      // mid-drain.
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "rust-sidecar" },
        "RustSidecarPtyHost: shutdown() in progress or complete; " +
          "the host is terminal — re-create a fresh instance for new sessions.",
      );
    }
    if (this.child !== null) {
      return;
    }
    // Concurrent cold-start callers share one spawn attempt.
    if (this.inflightSpawn !== null) {
      return this.inflightSpawn;
    }

    this.inflightSpawn = (async (): Promise<void> => {
      try {
        const spawnFn: SidecarSpawnFn = await this.resolveSpawn();

        // Re-checked: the budget may have been exhausted while spawn resolution yielded.
        if (this.permanentlyUnavailable) {
          throw new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar" },
            "RustSidecarPtyHost: crash-respawn budget exhausted " +
              `(${CRASH_BUDGET_LIMIT} crashes within ${CRASH_BUDGET_WINDOW_MS}ms); ` +
              "refusing to respawn.",
          );
        }

        let binaryPath: string;
        try {
          binaryPath = this.deps.resolveBinaryPath();
        } catch (err: unknown) {
          // A missing binary fails the same way on every retry, so it does not charge the crash
          // budget. The resolver's `PtyBackendUnavailableError` is rethrown unchanged; others wrap.
          if (err instanceof PtyBackendUnavailableError) {
            throw err;
          }
          throw new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar", cause: err },
            "RustSidecarPtyHost: failed to resolve sidecar binary path",
          );
        }

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnFn(binaryPath, [], {
            // stdin and stdout carry frames; stderr carries sidecar diagnostics.
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: unknown) {
          // A synchronous spawn failure (ENOENT, EACCES) counts as a crash.
          if (this.crashBudget.recordAndIsExhausted()) {
            this.permanentlyUnavailable = true;
          }
          throw new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar", cause: err },
            `RustSidecarPtyHost: spawn(${binaryPath}) failed`,
          );
        }
        this.child = child;
        this.attachChildListeners(child);
      } finally {
        // Cleared on success and failure: success short-circuits on `this.child`; failure retries.
        this.inflightSpawn = null;
      }
    })();

    return this.inflightSpawn;
  }

  private attachChildListeners(child: SidecarChildProcess): void {
    // A fresh child has not exited, so drop any `true` left by the crashed one.
    this.childExitedBeforeDrain = false;

    // Pipe failures (EPIPE, ERR_STREAM_DESTROYED, EIO) arrive as async `error` events, not throws,
    // and would crash the daemon as `uncaughtException`. SIGTERM (not SIGKILL: the protocol is not
    // corrupt) makes the child exit so the normal teardown runs.
    const pipeErrorHandler =
      (which: "stdin" | "stdout" | "stderr") =>
      (err: Error): void => {
        console.warn(
          `RustSidecarPtyHost (${which}): ${err.message}; terminating child for respawn.`,
        );
        try {
          child.kill("SIGTERM");
        } catch (killError: unknown) {
          // The child may have already exited (ESRCH); its exit event runs the teardown.
          console.warn(`RustSidecarPtyHost (${which}): SIGTERM to the child failed.`, {
            cause: killError,
          });
        }
      };
    child.stdin.on("error", pipeErrorHandler("stdin"));
    child.stdout.on("error", pipeErrorHandler("stdout"));
    child.stderr.on("error", pipeErrorHandler("stderr"));

    // Named so handleChildExit and handleChildError can detach it before the parser is replaced.
    const stdoutListener = (chunk: Buffer): void => {
      this.stdoutBuffer =
        this.stdoutBuffer.length === 0 ? chunk : Buffer.concat([this.stdoutBuffer, chunk]);
      this.drainParserUntilIncomplete();
    };
    child.stdout.on("data", stdoutListener);
    this.childStdoutListener = stdoutListener;

    // Stderr: the sidecar's `eprintln!` output, forwarded to the daemon's log.
    child.stderr.on("data", (chunk: Buffer) => {
      console.warn(`RustSidecarPtyHost (stderr): ${chunk.toString("utf8").trimEnd()}`);
    });

    // The child is passed so the handlers can ignore events for a replaced child.
    child.on("exit", (code: number | null, signal: string | null) => {
      this.events.onChildExit(child, code, signal);
    });

    // Error: async spawn failure, accounted like a crash.
    child.on("error", (err: Error) => {
      this.events.onChildError(child, err);
    });
  }

  /** Pulls every complete frame from the stdout buffer, since one chunk can carry several. */
  private drainParserUntilIncomplete(): void {
    for (;;) {
      let result: ParseFrameResult;
      try {
        result = parseFrame(this.stdoutBuffer, MAX_FRAME_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof FramingError)) {
          throw error;
        }
        // The stream is desynced and cannot recover. Callers get the generic "sidecar exited"
        // rejection; only JSON-decode failures stash a typed cause (failFatallyOnDecodeError).
        console.warn(
          `RustSidecarPtyHost: framing error on sidecar stdout (${error.message}); ` +
            "tearing down child for respawn.",
        );
        // The exit handler then records the crash and respawns, or reports the backend unavailable.
        if (this.child !== null) {
          try {
            this.child.kill("SIGKILL");
          } catch (killError: unknown) {
            // The child may already have exited; its exit event runs the teardown.
            console.warn("RustSidecarPtyHost: SIGKILL after a framing error failed.", {
              cause: killError,
            });
          }
        }
        return;
      }
      if (result.frame === null) {
        return;
      }
      // Copy the remainder: a `subarray` view would keep the whole original allocation alive.
      this.stdoutBuffer = Buffer.from(this.stdoutBuffer.subarray(result.consumed));
      // A view over the parser's own copy, so the frame keeps `Buffer`'s decoding methods.
      this.events.onFrame(
        Buffer.from(result.frame.buffer, result.frame.byteOffset, result.frame.byteLength),
      );
    }
  }

  /** Resolves the spawn function: an injected one, else `node:child_process` loaded on demand. */
  private async resolveSpawn(): Promise<SidecarSpawnFn> {
    if (this.cachedSpawn !== null) {
      return this.cachedSpawn;
    }
    if (this.deps.spawn !== null) {
      this.cachedSpawn = this.deps.spawn;
      return this.cachedSpawn;
    }
    this.cachedSpawn = await loadDefaultSpawn();
    return this.cachedSpawn;
  }

  /**
   * The first half of the teardown when `child` exits or errors: marks it exited, detaches its
   * stdout, replaces the parser and forgets the child. Returns `false`, doing nothing, when `child`
   * is not the live one.
   */
  public releaseExitedChild(child: SidecarChildProcess): boolean {
    if (this.child !== child) {
      return false;
    }
    // After the stale-event guard, so a late event cannot mark the live child as exited.
    this.childExitedBeforeDrain = true;
    this.detachChildStdoutListener(child);
    this.stdoutBuffer = Buffer.alloc(0);
    this.child = null;
    return true;
  }

  /**
   * Fatal teardown for a payload decode failure: stashes `cause` for the exit handler to reject
   * outstanding requests with, then SIGKILLs the child. Only the first failure in a drain pass
   * acts, and the stash is set only when a child exists so it cannot leak into the next one.
   */
  public failFatallyOnDecodeError(cause: SidecarFrameDecodeError): void {
    console.warn(cause.message);
    if (this.pendingTeardownCause !== null) {
      return;
    }
    if (this.child !== null) {
      this.pendingTeardownCause = cause;
      try {
        this.child.kill("SIGKILL");
      } catch (killError: unknown) {
        // The child may already have exited; its exit event runs the teardown.
        console.warn("RustSidecarPtyHost: SIGKILL after a decode error failed.", {
          cause: killError,
        });
      }
    }
  }

  /** Returns and clears the stashed teardown cause, so the next child does not inherit it. */
  public consumePendingTeardownCause(): Error | null {
    const cause: Error | null = this.pendingTeardownCause;
    this.pendingTeardownCause = null;
    return cause;
  }

  /**
   * Detaches the stdout listener before the parser is replaced, so late bytes from the dying child
   * cannot feed the fresh parser.
   */
  private detachChildStdoutListener(child: SidecarChildProcess): void {
    if (this.childStdoutListener !== null) {
      child.stdout.off("data", this.childStdoutListener);
      this.childStdoutListener = null;
    }
  }

  /**
   * Charges the crash budget once for `child`. Marks `permanentlyUnavailable` when the budget is
   * exhausted, so the next `ensureChild` throws.
   */
  public recordCrashOncePerChild(child: SidecarChildProcess, shuttingDown: boolean): void {
    if (this.crashCountedChildren.has(child)) {
      return;
    }
    // Recorded even during shutdown so a stale second event for this child stays a no-op. The
    // deliberate exit during shutdown is not a crash and must not charge the budget.
    this.crashCountedChildren.add(child);
    if (shuttingDown) {
      return;
    }
    if (this.crashBudget.recordAndIsExhausted()) {
      this.permanentlyUnavailable = true;
    }
  }

  /** Wakes `drainSidecarHost`'s wait for the sidecar to exit; a no-op outside shutdown. */
  public notifyHostExitWaiter(): void {
    if (this.hostExitWaiter !== null) {
      this.hostExitWaiter();
    }
  }

  /**
   * Closes the sidecar's stdin, waits up to `timeoutMs` for it to exit, and hard-kills it on
   * timeout. With no active child it reports clean unless the child exited before the drain.
   */
  public async drainSidecarHost(
    timeoutMs: number,
  ): Promise<{ sidecarExitedCleanly: boolean; taskkillEscalated: boolean }> {
    const child: SidecarChildProcess | null = this.child;
    if (child === null) {
      // Never spawned (clean) or exited before the drain (not clean); the daemon's stop writes this
      // field to its service log.
      return {
        sidecarExitedCleanly: !this.childExitedBeforeDrain,
        taskkillEscalated: false,
      };
    }

    const hostWaiter: Promise<void> = new Promise<void>((resolve) => {
      this.hostExitWaiter = resolve;
    });

    // Closing stdin ends the sidecar's read loop so it drains and exits. If the pipe is already
    // broken, the sidecar died and the exit event reaches handleChildExit on its own.
    try {
      child.stdin.end();
    } catch (endError: unknown) {
      console.warn("RustSidecarPtyHost: closing the sidecar's stdin failed.", {
        cause: endError,
      });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise: Promise<"timeout"> = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
    });

    const outcome: "clean" | "timeout" = await Promise.race([
      hostWaiter.then((): "clean" => "clean"),
      timeoutPromise,
    ]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    this.hostExitWaiter = null;

    if (outcome === "clean") {
      return { sidecarExitedCleanly: true, taskkillEscalated: false };
    }

    // Timeout: the wedged sidecar cannot translate kills itself, so the daemon kills the tree.
    await this.escalateHardKillTree(child);
    return { sidecarExitedCleanly: false, taskkillEscalated: true };
  }

  /**
   * Hard-kills the sidecar and its PTY children; a failure is logged, never thrown. Windows needs
   * `taskkill /T /F` (`child.kill` ends one process); on POSIX the closed PTY masters SIGHUP the
   * `setsid` children, which a group kill would miss.
   */
  private async escalateHardKillTree(child: SidecarChildProcess): Promise<void> {
    if (this.deps.platform === "win32" && child.pid !== undefined) {
      const pid: number = child.pid;
      const spawnTaskkill = this.deps.spawnTaskkill;
      // Bounded so a stuck taskkill cannot hang the drain; a healthy one takes under a second.
      await new Promise<void>((resolve) => {
        let settled = false;
        const fallbackHandle = setTimeout(() => {
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
          clearTimeout(fallbackHandle);
          resolve();
        };
        void (async (): Promise<void> => {
          try {
            await spawnTaskkill(pid);
          } catch (err: unknown) {
            // A failed taskkill must not hang the drain; the warn surfaces a recurring failure (bad
            // PATH, blocked taskkill.exe).
            console.warn(
              `RustSidecarPtyHost: escalateHardKillTree: spawnTaskkill rejected for ` +
                `sidecar pid=${pid}; drain will continue.`,
              { cause: err },
            );
          }
          finish();
        })();
      });
      return;
    }

    // POSIX, or a Windows child without a pid: a single-process kill is all that is available.
    try {
      child.kill("SIGKILL");
    } catch (killError: unknown) {
      // The `exit` event may already have fired and cleared `this.child`.
      console.warn("RustSidecarPtyHost: SIGKILL to the wedged sidecar failed.", {
        cause: killError,
      });
    }
  }
}
