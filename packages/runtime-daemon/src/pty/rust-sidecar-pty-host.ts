// Out-of-process Rust PTY sidecar implementation of the `PtyHost` contract.
//
// Exists because node-pty's ConPTY backend on Windows has known bugs (`microsoft/node-pty#904`,
// `#887`, `#894`, `openai/codex#13973`). This is the daemon side: it spawns the sidecar, speaks
// Content-Length framing on its stdio, supervises crashes, and maps `PtyHost` onto wire envelopes.
//
// - Framing: a minimal local framer, not `local-ipc-gateway.ts::parseFrame` (built for network
//   peers). The Rust twin is `framing.rs`; the two are maintained by hand.
// - Crash budget: 5 crashes in a sliding 60 s window make the host permanently unavailable; every
//   call then rejects with `PtyBackendUnavailableError`. A fixed window would let a steady rate
//   through.
// - Method shape and lifecycle match `NodePtyHost`, so `PtyHostSelector` can swap the backends.
// - Effectful primitives are injectable through `RustSidecarPtyHostDeps`.

import { Buffer } from "node:buffer";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import {
  type DrainResult,
  type Envelope,
  type ExitCodeNotification,
  type PtyHost,
  type PtySignal,
  type SpawnRequest,
  type SpawnResponse,
} from "@ai-sidekicks/contracts";
import { defaultSpawnTaskkill, type TaskkillResult } from "./taskkill-windows.js";
import { PtyBackendUnavailableError, resolveSidecarBinaryPath } from "./sidecar-binary-path.js";
import {
  ContentLengthParser,
  isStrictBase64,
  serializeFrame,
  SidecarFrameDecodeError,
} from "./sidecar-frame-codec.js";

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

/** Effectful primitives `RustSidecarPtyHost` reaches through; tests inject a double for each. */
export interface RustSidecarPtyHostDeps {
  readonly resolveBinaryPath: () => string;
  readonly spawn: SidecarSpawnFn;
  /** Monotonic clock in milliseconds for crash-budget timestamps. */
  readonly nowMs: () => number;
  /** Selects the host-timeout hard-kill branch (`escalateHardKillTree`). */
  readonly platform?: NodeJS.Platform;
  /**
   * Runs `taskkill /T /F /PID`; only the Windows host-timeout hard kill calls it (POSIX uses
   * `child.kill("SIGKILL")`).
   */
  readonly spawnTaskkill?: (pid: number) => Promise<TaskkillResult>;
}

/** Width of the sliding crash-budget window. */
export const CRASH_BUDGET_WINDOW_MS = 60_000;

/** Number of crashes inside `CRASH_BUDGET_WINDOW_MS` that exhaust the crash budget. */
export const CRASH_BUDGET_LIMIT = 5;

// The sidecar can deliver a `DataFrame` or `ExitCodeNotification` ahead of its `SpawnResponse`
// (unbiased `select!` in `merge_to_writer`); they are held and replayed. The caps bound memory if
// events arrive for an id no response resolves.
const MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION = 64;

const MAX_PRE_SPAWN_BUFFERED_SESSIONS = 64;

/**
 * Cap on remembered closed session ids, oldest evicted first, so a late exit or data frame for a
 * closed id is dropped instead of buffered.
 */
const MAX_CLOSED_SESSION_IDS = 10_000;

/** Monotonic clock: `Date.now()` can jump backward, which would trip or release the budget. */
function defaultNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Loads `spawn` lazily so a test that injects its own never pays for the import. */
async function loadDefaultSpawn(): Promise<SidecarSpawnFn> {
  const cp: typeof import("node:child_process") = await import("node:child_process");
  return cp.spawn as SidecarSpawnFn;
}

/** Deps with defaults filled in; `spawn` stays `null` until first use (`loadDefaultSpawn`). */
interface ResolvedDeps {
  readonly resolveBinaryPath: () => string;
  readonly spawn: SidecarSpawnFn | null;
  readonly nowMs: () => number;
  readonly platform: NodeJS.Platform;
  readonly spawnTaskkill: (pid: number) => Promise<TaskkillResult>;
}

function resolveDefaultDeps(partial: Partial<RustSidecarPtyHostDeps>): ResolvedDeps {
  return {
    resolveBinaryPath: partial.resolveBinaryPath ?? resolveSidecarBinaryPath,
    spawn: partial.spawn ?? null,
    nowMs: partial.nowMs ?? defaultNowMs,
    platform: partial.platform ?? process.platform,
    spawnTaskkill: partial.spawnTaskkill ?? defaultSpawnTaskkill,
  };
}

/** Per-session state, keyed by the sidecar-minted `s-{n}` session id. */
interface SessionRecord {
  /** Exit code once the sidecar has reported it, `null` while alive; `kill` re-emits from it. */
  exitCode: number | null;
  /** POSIX signal number; `undefined` for a normal exit. */
  signalCode: number | undefined;
}

/**
 * A pending request awaiting a response of `responseKind`. The wire has no request id: a response
 * goes to the oldest pending request of its kind, safe because callers await each method in turn.
 */
interface OutstandingRequest {
  readonly resolve: (envelope: Envelope) => void;
  readonly reject: (err: Error) => void;
  readonly responseKind: Envelope["kind"];
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

  public currentWindowSize(): number {
    return this.timestamps.length;
  }
}

/**
 * `PtyHost` backed by a supervised Rust sidecar child process (all three stdio streams piped)
 * speaking Content-Length framing. A child exit triggers a respawn through `ensureChild`; an
 * exhausted crash budget surfaces `PtyBackendUnavailableError`.
 */
export class RustSidecarPtyHost implements PtyHost {
  private readonly deps: ResolvedDeps;

  private cachedSpawn: SidecarSpawnFn | null = null;

  private child: SidecarChildProcess | null = null;

  /**
   * Replaced on every child exit or error: leftover partial-frame bytes would desync the next child
   * and burn the crash budget.
   */
  private parser: ContentLengthParser = new ContentLengthParser();

  /**
   * The current child's stdout `data` listener, kept so exit and error can detach it before the
   * parser swap; late bytes from a dead child would corrupt the new parser.
   */
  private childStdoutListener: ((chunk: Buffer) => void) | null = null;

  private readonly sessions: Map<string, SessionRecord> = new Map();

  private readonly crashBudget: CrashBudget;

  /** Set when the crash budget is exhausted; every later call rejects instead of spawning. */
  private permanentlyUnavailable = false;

  /**
   * Set at `shutdown()` entry: suppresses respawn and crash accounting for the deliberate exit and
   * makes `ensureChild` reject a concurrent `spawn()`. Terminal; the instance is single-use.
   */
  private shuttingDown = false;

  /** Memoized `shutdown()` result: a second call awaits the same drain. */
  private shutdownPromise: Promise<DrainResult> | null = null;

  /** Per-session drain resolvers made at `shutdown()` entry; settled by `notifyShutdownWaiter`. */
  private readonly shutdownWaiters: Map<string, () => void> = new Map();

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

  /** Pending requests by response kind, oldest first; normally at most one per kind. */
  private readonly outstanding: Map<Envelope["kind"], OutstandingRequest[]> = new Map();

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

  private dataListener: (sessionId: string, chunk: Uint8Array) => void = () => undefined;

  private exitListener: (sessionId: string, exitCode: number, signalCode?: number) => void = () =>
    undefined;

  /**
   * `DataFrame` chunks for a session whose `SpawnResponse` has not arrived, replayed by
   * `replayPreSpawnEvents`. Cleared on child teardown: the sidecar's session counter restarts on
   * respawn, so old ids would replay against a new session.
   */
  private readonly pendingDataFrames: Map<string, Uint8Array[]> = new Map();

  /**
   * The `ExitCodeNotification` (at most one per session) awaiting its `SpawnResponse`; replayed and
   * cleared like `pendingDataFrames`.
   */
  private readonly pendingExits: Map<string, ExitCodeNotification> = new Map();

  /**
   * Ids removed by `close()`: a late exit or data frame for one is dropped, so `onExit` never fires
   * after `close()` resolves. Cleared on child teardown because the counter restarts on respawn and
   * a stale entry would suppress a new session that mints the same id (`s-0`).
   */
  private readonly closedSessionIds: Set<string> = new Set();

  public constructor(deps?: Partial<RustSidecarPtyHostDeps>) {
    this.deps = resolveDefaultDeps(deps ?? {});
    this.crashBudget = new CrashBudget(this.deps.nowMs);
  }

  public async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    await this.ensureChild();
    // The session is registered in `resolveOutstanding`, not after this await: frames dispatch
    // synchronously, so a `DataFrame` following the response in the same chunk would find no
    // session. Frames arriving before the response are held and replayed by `replayPreSpawnEvents`.
    const response = await this.sendRequest(spec, "spawn_response");
    if (response.kind !== "spawn_response") {
      throw new Error(`RustSidecarPtyHost.spawn: unexpected response kind ${response.kind}`);
    }
    return response;
  }

  /** Resizes a session's terminal. Rejects for an unknown session id. */
  public async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    // An unknown id rejects before any request is sent, as in NodePtyHost.
    if (!this.sessions.has(sessionId)) {
      throw new Error(`RustSidecarPtyHost.resize: unknown sessionId '${sessionId}'`);
    }
    await this.ensureChild();
    await this.sendRequest(
      { kind: "resize_request", session_id: sessionId, rows, cols },
      "resize_response",
    );
  }

  /** Writes bytes to a session's terminal. Rejects for an unknown session id. */
  public async write(sessionId: string, bytes: Uint8Array): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`RustSidecarPtyHost.write: unknown sessionId '${sessionId}'`);
    }
    await this.ensureChild();
    const base64: string = Buffer.from(bytes).toString("base64");
    await this.sendRequest(
      { kind: "write_request", session_id: sessionId, bytes: base64 },
      "write_response",
    );
  }

  /** Signals a session; an exited one re-emits its cached exit. Rejects for an unknown id. */
  public async kill(sessionId: string, signal: PtySignal): Promise<void> {
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`RustSidecarPtyHost.kill: unknown sessionId '${sessionId}'`);
    }
    if (record.exitCode !== null) {
      this.fireExit(sessionId, record.exitCode, record.signalCode);
      return;
    }
    await this.ensureChild();
    await this.sendRequest(
      { kind: "kill_request", session_id: sessionId, signal },
      "kill_response",
    );
  }

  /** Closes a session; no listener fires for it afterwards. Closing an unknown id is a no-op. */
  public async close(sessionId: string): Promise<void> {
    // Delete the record and remember the id before the kill request goes out, so an exit or data
    // frame arriving during the await is suppressed, not buffered as pre-spawn. The kill response
    // is matched by kind, so it still resolves without a record.
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    this.sessions.delete(sessionId);
    this.recordClosedSessionId(sessionId);
    if (record.exitCode === null) {
      try {
        await this.sendRequest(
          { kind: "kill_request", session_id: sessionId, signal: "SIGTERM" },
          "kill_response",
        );
      } catch {
        // close() must not throw when the child already exited mid-request.
      }
    }
  }

  /**
   * Drains active sessions (SIGTERM, then SIGKILL after `perSessionTimeoutMs`), then closes the
   * sidecar's stdin and hard-kills it after `hostTimeoutMs`. Terminal; a second call returns the
   * same promise.
   */
  public shutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    // Not `async`, so a second call returns the identical memoized promise.
    this.shutdownPromise = this.runShutdown(options);
    return this.shutdownPromise;
  }

  private async runShutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    // Flipped first so a crash mid-drain takes the deliberate-shutdown paths; never reset.
    this.shuttingDown = true;

    const activeSessionIds: string[] = Array.from(this.sessions.keys()).filter((sessionId) => {
      const record: SessionRecord | undefined = this.sessions.get(sessionId);
      return record !== undefined && record.exitCode === null;
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

    const hostResult: { sidecarExitedCleanly: boolean; taskkillEscalated: boolean } =
      await this.drainSidecarHost(options.hostTimeoutMs);

    return {
      sessionsDrained,
      sessionsForcedKilled,
      sidecarExitedCleanly: hostResult.sidecarExitedCleanly,
      taskkillEscalated: hostResult.taskkillEscalated,
    };
  }

  /**
   * Sends SIGTERM to one session and waits for its exit, escalating to SIGKILL after `timeoutMs`;
   * resolves "forced" when the timeout fired.
   */
  private async drainSingleSession(
    sessionId: string,
    timeoutMs: number,
  ): Promise<"drained" | "forced"> {
    const drainWaiter: Promise<void> = new Promise<void>((resolve) => {
      this.shutdownWaiters.set(sessionId, resolve);
    });

    try {
      // Armed before the SIGTERM request so the budget covers ack and exit; a wedged sidecar cannot
      // stall shutdown().
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise: Promise<"timeout"> = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve("timeout");
        }, timeoutMs);
      });

      // A crash mid-drain fires a -1 exit and rejects the request (swallowed); nothing settles the
      // waiter, so the timer fires and the session counts as forced.
      const gracefulDrain: Promise<"drained"> = (async (): Promise<"drained"> => {
        try {
          await this.sendRequest(
            { kind: "kill_request", session_id: sessionId, signal: "SIGTERM" },
            "kill_response",
          );
        } catch {
          // Best-effort; see the crash case above.
        }
        await drainWaiter;
        return "drained";
      })();

      const outcome: "drained" | "timeout" = await Promise.race([gracefulDrain, timeoutPromise]);

      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      if (outcome === "drained") {
        return "drained";
      }

      // Escalate to SIGKILL without awaiting: a sidecar that ignored SIGTERM would hang this
      // request too (the host-level kill is the backstop). The catch avoids an unhandled rejection.
      void this.sendRequest(
        { kind: "kill_request", session_id: sessionId, signal: "SIGKILL" },
        "kill_response",
      ).catch(() => {
        // Best-effort.
      });
      // onExit fires with code 1 and no signal, as in NodePtyHost, not the -1 crash sentinel;
      // without it the consumer could wait forever if the sidecar reaps the child but sends no
      // notification. The exitCode check prevents a double fire; a later real notification hits the
      // duplicate branch.
      const record: SessionRecord | undefined = this.sessions.get(sessionId);
      if (record !== undefined && record.exitCode === null) {
        record.exitCode = 1;
        record.signalCode = undefined;
        try {
          this.fireExit(sessionId, 1, undefined);
        } catch (err: unknown) {
          const message: string = err instanceof Error ? err.message : String(err);
          console.warn(
            `RustSidecarPtyHost: synthetic forced-kill onExit listener threw for session ${sessionId}: ${message}; continuing drain.`,
          );
        }
        this.notifyShutdownWaiter(sessionId);
      }
      return "forced";
    } finally {
      this.shutdownWaiters.delete(sessionId);
    }
  }

  /**
   * Closes the sidecar's stdin, waits up to `timeoutMs` for it to exit, and hard-kills it on
   * timeout. With no active child it reports clean unless the child exited before the drain.
   */
  private async drainSidecarHost(
    timeoutMs: number,
  ): Promise<{ sidecarExitedCleanly: boolean; taskkillEscalated: boolean }> {
    const child: SidecarChildProcess | null = this.child;
    if (child === null) {
      // Never spawned (clean) or exited before the drain (not clean); desktop quit telemetry reads
      // this field.
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
    } catch {
      // Best-effort.
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
   * Hard-kills the sidecar and its PTY children; errors are swallowed. Windows needs
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
    } catch {
      // The `exit` event may already have fired and cleared `this.child`.
    }
  }

  private notifyShutdownWaiter(sessionId: string): void {
    const resolver: (() => void) | undefined = this.shutdownWaiters.get(sessionId);
    if (resolver !== undefined) {
      resolver();
    }
  }

  private notifyHostExitWaiter(): void {
    if (this.hostExitWaiter !== null) {
      this.hostExitWaiter();
    }
  }

  /** Delivers a data chunk to the registered data listener. */
  public onData(sessionId: string, chunk: Uint8Array): void {
    this.dataListener(sessionId, chunk);
  }

  /** Delivers an exit event to the registered exit listener. */
  public onExit(sessionId: string, exitCode: number, signalCode?: number): void {
    this.exitListener(sessionId, exitCode, signalCode);
  }

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

  /**
   * Ensures a sidecar child is alive, spawning on first use and after a crash. Throws
   * `PtyBackendUnavailableError` when the crash budget is spent, after shutdown, or when the binary
   * cannot be resolved or spawned. A failed spawn charges the crash budget; a failed resolution
   * not.
   */
  private async ensureChild(): Promise<void> {
    if (this.permanentlyUnavailable) {
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "rust-sidecar" },
        "RustSidecarPtyHost: crash-respawn budget exhausted " +
          `(${CRASH_BUDGET_LIMIT} crashes within ${CRASH_BUDGET_WINDOW_MS}ms); ` +
          "refusing to respawn.",
      );
    }
    if (this.shuttingDown) {
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
        } catch {
          // Best-effort — child may have already exited (ESRCH).
        }
      };
    child.stdin.on("error", pipeErrorHandler("stdin"));
    child.stdout.on("error", pipeErrorHandler("stdout"));
    child.stderr.on("error", pipeErrorHandler("stderr"));

    // Named so handleChildExit and handleChildError can detach it before the parser is replaced.
    const stdoutListener = (chunk: Buffer): void => {
      this.parser.feed(chunk);
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
      this.handleChildExit(child, code, signal);
    });

    // Error: async spawn failure, accounted like a crash.
    child.on("error", (err: Error) => {
      this.handleChildError(child, err);
    });
  }

  /** Pulls every complete frame from the parser, since one stdout chunk can carry several. */
  private drainParserUntilIncomplete(): void {
    for (;;) {
      const result = this.parser.nextFrame();
      if (result.kind === "incomplete") {
        return;
      }
      if (result.kind === "error") {
        // The stream is desynced and cannot recover. Callers get the generic "sidecar exited"
        // rejection; only JSON-decode failures stash a typed cause (failFatallyOnDecodeError).
        console.warn(
          `RustSidecarPtyHost: framing error on sidecar stdout (${result.message}); ` +
            "tearing down child for respawn.",
        );
        // The exit handler then records the crash and respawns, or reports the backend unavailable.
        if (this.child !== null) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // The child may already have exited.
          }
        }
        return;
      }
      this.handleInbound(result.body);
    }
  }

  /**
   * Decodes a frame body as an `Envelope` and routes it to a pending request or to the data and
   * exit handlers.
   */
  private handleInbound(body: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (err: unknown) {
      // Invalid JSON is fatal, like a framing error: dropping the frame would leave its response
      // pending forever and could desync the stream. Tear the child down and respawn.
      const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
        "json-parse",
        `RustSidecarPtyHost: failed to parse inbound JSON envelope ` +
          `(${(err as Error).message}); tearing down child for respawn.`,
      );
      this.failFatallyOnDecodeError(cause);
      return;
    }

    // `null`, an array or a primitive cannot be an `Envelope`: `envelope.kind` would throw on null
    // and match no case on an array. Same teardown as a parse failure.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const observedKind: string =
        parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
        "non-object-envelope",
        `RustSidecarPtyHost: decoded payload is not an object envelope ` +
          `(observedKind=${observedKind}); tearing down child for respawn.`,
      );
      this.failFatallyOnDecodeError(cause);
      return;
    }

    const envelope: Envelope = parsed as Envelope;

    switch (envelope.kind) {
      case "data_frame": {
        // `Buffer.from` silently drops invalid base64 characters, so check first: corrupt data
        // would otherwise be delivered as a wrong byte stream. Same fatal teardown as bad JSON.
        if (!isStrictBase64(envelope.bytes)) {
          const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
            "invalid-base64",
            `RustSidecarPtyHost: data_frame.bytes is not strict base64 ` +
              `(session=${envelope.session_id}, length=${envelope.bytes.length}); ` +
              `tearing down child for respawn.`,
          );
          this.failFatallyOnDecodeError(cause);
          break;
        }
        const bytes: Uint8Array = Buffer.from(envelope.bytes, "base64");
        // Alive: fire onData. Closed: drop, close() already removed the record. Unknown: buffer,
        // because the sidecar's reader task and its random-order writer can put a frame or exit
        // notification on the wire before the SpawnResponse; replayPreSpawnEvents drains it.
        if (this.sessions.has(envelope.session_id)) {
          this.dataListener(envelope.session_id, bytes);
          break;
        }
        if (this.closedSessionIds.has(envelope.session_id)) {
          break;
        }
        this.bufferPreSpawnData(envelope.session_id, bytes);
        break;
      }
      case "exit_code_notification": {
        this.handleExitNotification(envelope);
        break;
      }
      case "spawn_response":
      case "resize_response":
      case "write_response":
      case "kill_response":
      case "ping_response": {
        this.resolveOutstanding(envelope);
        break;
      }
      // The sidecar never sends requests; warn and skip.
      case "spawn_request":
      case "resize_request":
      case "write_request":
      case "kill_request":
      case "ping_request": {
        console.warn(
          `RustSidecarPtyHost: unexpected inbound request kind ${envelope.kind} from sidecar; skipping.`,
        );
        break;
      }
      // An unknown kind (version skew or sidecar bug) is fatal, like malformed JSON: skipping it
      // would leave the response it replaced pending forever.
      default: {
        // `envelope` is `never` here, so `.kind` is read through a cast; JSON.stringify keeps
        // control bytes or CRLF from a faulty sidecar from forging log lines.
        const rawKind: unknown = (envelope as { kind?: unknown }).kind;
        const unknownKind: string =
          typeof rawKind === "string" ? JSON.stringify(rawKind) : `<non-string:${typeof rawKind}>`;
        const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
          "unknown-kind",
          `RustSidecarPtyHost: unknown inbound envelope kind ${unknownKind} ` +
            `(version skew or sidecar bug); tearing down child for respawn.`,
        );
        this.failFatallyOnDecodeError(cause);
        // Compiles only while the switch above covers every `Envelope` variant.
        const _exhaustive: never = envelope;
        return _exhaustive;
      }
    }
  }

  /**
   * Fires the exit once per known session and drops duplicates. A closed session is suppressed,
   * since close() promises no onExit after it resolves; an unknown one is buffered until its
   * SpawnResponse.
   */
  private handleExitNotification(notification: ExitCodeNotification): void {
    const record: SessionRecord | undefined = this.sessions.get(notification.session_id);
    if (record !== undefined) {
      if (record.exitCode !== null) {
        // Duplicate. Still tick the shutdown waiter so a shutdown racing a re-emission converges.
        this.notifyShutdownWaiter(notification.session_id);
        return;
      }
      record.exitCode = notification.exit_code;
      record.signalCode = notification.signal_code ?? undefined;
      this.fireExit(notification.session_id, notification.exit_code, record.signalCode);
      // Lets drainSingleSession finish once the real exit has been dispatched.
      this.notifyShutdownWaiter(notification.session_id);
      return;
    }
    if (this.closedSessionIds.has(notification.session_id)) {
      // This warn is the one most likely to fire in a normal close(): SIGTERM, then a late exit.
      console.warn(
        `RustSidecarPtyHost: late ExitCodeNotification for closed ` +
          `session_id ${notification.session_id} (exit_code=` +
          `${notification.exit_code}); suppressed.`,
      );
      // Tick anyway: the drain budget is measured against the exit reaching the wire.
      this.notifyShutdownWaiter(notification.session_id);
      return;
    }
    this.bufferPreSpawnExit(notification);
  }

  /**
   * Resolves or rejects the head of the FIFO for the response's kind. A response carrying `error`
   * rejects it (most often `UnknownSession` for a request that lost a race with natural exit;
   * close() swallows that) and a rejected `spawn_response` registers no session.
   */
  private resolveOutstanding(envelope: Envelope): void {
    const queue: OutstandingRequest[] | undefined = this.outstanding.get(envelope.kind);
    if (queue === undefined || queue.length === 0) {
      console.warn(
        `RustSidecarPtyHost: received uncorrelated response kind ${envelope.kind}; dropping.`,
      );
      return;
    }
    const head: OutstandingRequest | undefined = queue.shift();
    if (head === undefined) {
      return;
    }
    // Only these four response kinds carry the optional `error` field.
    if (
      (envelope.kind === "spawn_response" ||
        envelope.kind === "resize_response" ||
        envelope.kind === "write_response" ||
        envelope.kind === "kill_response") &&
      envelope.error !== undefined
    ) {
      head.reject(
        new Error(
          `RustSidecarPtyHost: sidecar ${envelope.kind} returned error for session_id='${envelope.session_id}': ${envelope.error}`,
        ),
      );
      return;
    }
    // Registered here, not after spawn()'s await, so frames trailing this SpawnResponse in the same
    // stdout chunk see `sessions.has(id)`. Earlier frames are replayed by replayPreSpawnEvents,
    // deferred so the caller's `await spawn()` records the id before onData or onExit fires.
    if (envelope.kind === "spawn_response") {
      // A spawn racing shutdown() slips past runShutdown's snapshot, and the sidecar's exit
      // teardown would delete the unregistered session, so refuse like ensureChild. No replay:
      // nobody awaits a rejected spawn, and buffered frames are cleared when the sidecar exits.
      if (this.shuttingDown) {
        head.reject(
          new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar" },
            "RustSidecarPtyHost: shutdown() in progress or complete; " +
              "the host is terminal — re-create a fresh instance for new sessions.",
          ),
        );
        return;
      }
      this.sessions.set(envelope.session_id, {
        exitCode: null,
        signalCode: undefined,
      });
      this.replayPreSpawnEvents(envelope.session_id);
    }
    head.resolve(envelope);
  }

  /** Fires the exit listener, omitting the third argument when there is no signal. */
  private fireExit(sessionId: string, exitCode: number, signalCode: number | undefined): void {
    if (signalCode === undefined) {
      this.exitListener(sessionId, exitCode);
    } else {
      this.exitListener(sessionId, exitCode, signalCode);
    }
  }

  /**
   * Buffers a data frame that arrived before its SpawnResponse, bounded by
   * `MAX_PRE_SPAWN_BUFFERED_SESSIONS` sessions and `MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION` chunks
   * each; frames over either cap are logged and dropped.
   */
  private bufferPreSpawnData(sessionId: string, bytes: Uint8Array): void {
    const existing: Uint8Array[] | undefined = this.pendingDataFrames.get(sessionId);
    if (existing === undefined) {
      if (this.pendingDataFrames.size >= MAX_PRE_SPAWN_BUFFERED_SESSIONS) {
        console.warn(
          `RustSidecarPtyHost: pre-spawn buffer at capacity ` +
            `(${MAX_PRE_SPAWN_BUFFERED_SESSIONS} stale sessions); ` +
            `dropping DataFrame for session_id ${sessionId}.`,
        );
        return;
      }
      this.pendingDataFrames.set(sessionId, [bytes]);
      return;
    }
    if (existing.length >= MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION) {
      console.warn(
        `RustSidecarPtyHost: pre-spawn DataFrame buffer for session_id ` +
          `${sessionId} at capacity ` +
          `(${MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION} chunks); ` +
          `dropping further chunks until SpawnResponse arrives.`,
      );
      return;
    }
    existing.push(bytes);
  }

  /**
   * Stores the pre-spawn `ExitCodeNotification`; the sidecar sends one per session, so a duplicate
   * is dropped with a warn. Bounded by `MAX_PRE_SPAWN_BUFFERED_SESSIONS`, like
   * `bufferPreSpawnData`.
   */
  private bufferPreSpawnExit(notification: ExitCodeNotification): void {
    if (this.pendingExits.has(notification.session_id)) {
      console.warn(
        `RustSidecarPtyHost: duplicate pre-spawn ExitCodeNotification ` +
          `for session_id ${notification.session_id} (exit_code=` +
          `${notification.exit_code}); dropping (sidecar contract is ` +
          `exactly-once-per-session).`,
      );
      return;
    }
    if (
      !this.pendingDataFrames.has(notification.session_id) &&
      this.pendingExits.size >= MAX_PRE_SPAWN_BUFFERED_SESSIONS
    ) {
      console.warn(
        `RustSidecarPtyHost: pre-spawn exit buffer at capacity ` +
          `(${MAX_PRE_SPAWN_BUFFERED_SESSIONS} stale sessions); ` +
          `dropping ExitCodeNotification for session_id ` +
          `${notification.session_id}.`,
      );
      return;
    }
    this.pendingExits.set(notification.session_id, notification);
  }

  /**
   * Replays the buffered pre-spawn data, then the exit, for `sessionId` in `setImmediate`, so the
   * `spawn()` caller's continuation records the id first. `unref()` keeps the timer from holding
   * the daemon open.
   */
  private replayPreSpawnEvents(sessionId: string): void {
    const dataFrames: Uint8Array[] | undefined = this.pendingDataFrames.get(sessionId);
    const exit: ExitCodeNotification | undefined = this.pendingExits.get(sessionId);
    this.pendingDataFrames.delete(sessionId);
    this.pendingExits.delete(sessionId);
    if (dataFrames === undefined && exit === undefined) {
      return;
    }
    const handle: NodeJS.Immediate = setImmediate(() => {
      // Re-check at fire time: a close() since scheduling removed the record and must suppress
      // the fan-out.
      if (this.closedSessionIds.has(sessionId)) {
        return;
      }
      if (dataFrames !== undefined && this.sessions.has(sessionId)) {
        for (const bytes of dataFrames) {
          this.dataListener(sessionId, bytes);
        }
      }
      if (exit !== undefined) {
        const record: SessionRecord | undefined = this.sessions.get(sessionId);
        if (record === undefined || record.exitCode !== null) {
          // The record is gone (same-tick teardown) or an exit was cached; deliver at most once.
          return;
        }
        record.exitCode = exit.exit_code;
        record.signalCode = exit.signal_code ?? undefined;
        this.fireExit(sessionId, exit.exit_code, record.signalCode);
      }
    });
    handle.unref();
  }

  /**
   * Remembers a closed session id, evicting the oldest beyond `MAX_CLOSED_SESSION_IDS`. An evicted
   * id falls back to pre-spawn buffering, harmless because ids are not reused within one lifetime.
   */
  private recordClosedSessionId(sessionId: string): void {
    if (this.closedSessionIds.has(sessionId)) {
      // Already recorded; re-adding would not refresh a Set's insertion order.
      return;
    }
    if (this.closedSessionIds.size >= MAX_CLOSED_SESSION_IDS) {
      const oldest: string | undefined = this.closedSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.closedSessionIds.delete(oldest);
      }
    }
    this.closedSessionIds.add(sessionId);
  }

  /**
   * Clears the pre-spawn buffers and closed-id memory when the sidecar goes away. A respawned
   * sidecar restarts its ids at `s-0`, so stale entries would replay into or suppress a new
   * session.
   */
  private clearPreSpawnState(): void {
    this.pendingDataFrames.clear();
    this.pendingExits.clear();
    this.closedSessionIds.clear();
  }

  /**
   * Sends a request and resolves with the next response of `expectedResponseKind`, matched by the
   * kind-keyed FIFO. Rejects if the stdin write throws or the sidecar exits first. Callers must
   * `await ensureChild()` first.
   */
  private sendRequest(
    request: Envelope,
    expectedResponseKind: Envelope["kind"],
  ): Promise<Envelope> {
    return new Promise<Envelope>((resolve, reject) => {
      const child: SidecarChildProcess | null = this.child;
      if (child === null) {
        reject(new Error("RustSidecarPtyHost.sendRequest: no child process"));
        return;
      }
      // Queued before the write so a synchronous exit during the write can still reject this entry.
      const queue: OutstandingRequest[] = this.outstanding.get(expectedResponseKind) ?? [];
      queue.push({ resolve, reject, responseKind: expectedResponseKind });
      this.outstanding.set(expectedResponseKind, queue);

      const frame: Buffer = serializeFrame(request);
      // Write backpressure is ignored: about one request per kind is outstanding at a time.
      try {
        child.stdin.write(frame);
      } catch (err: unknown) {
        // The response will never arrive; drop the entry just queued.
        const removed: OutstandingRequest | undefined = queue.pop();
        if (removed !== undefined && removed.resolve === resolve) {
          reject(
            err instanceof Error
              ? err
              : new Error(`RustSidecarPtyHost.sendRequest: stdin.write threw: ${String(err)}`),
          );
        }
      }
    });
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
   * On sidecar death, fires a synthetic `onExit(-1)` (outside real exit codes, distinct from the
   * forced-kill `1`) for each session not yet exited, then deletes every record. A throwing
   * listener is caught so it cannot strand the remaining sessions or the rest of teardown.
   */
  private fireCrashTimeOnExit(): void {
    const sessionIds: string[] = Array.from(this.sessions.keys());
    // Each session gets one terminal onExit: its real exit, the forced-kill exit from
    // drainSingleSession, or the -1 below; the `exitCode !== null` check is the dedupe.
    for (const sessionId of sessionIds) {
      const record: SessionRecord | undefined = this.sessions.get(sessionId);
      if (record === undefined) {
        continue;
      }
      if (record.exitCode === null) {
        record.exitCode = -1;
        record.signalCode = undefined;
        try {
          this.fireExit(sessionId, -1, undefined);
        } catch (err: unknown) {
          const message: string = err instanceof Error ? err.message : String(err);
          console.warn(
            `RustSidecarPtyHost: crash-time onExit listener threw for session ${sessionId}: ${message}; continuing teardown.`,
          );
        }
      }
      // Deleted for already-fired sessions too, so stale ids cannot pass `sessions.has()` after a
      // respawn.
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Tears down after the sidecar exits. The parser is replaced first so a later throw cannot leave
   * partial-frame bytes for the next sidecar; `crashCountedChildren` keeps the budget from being
   * charged twice when Node emits both `error` and `exit`.
   */
  private handleChildExit(
    child: SidecarChildProcess,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.child !== child) {
      // Ignore events for a replaced child: teardown would clear the new child and reject its
      // pending requests with the old child's failure.
      return;
    }
    // After the stale-event guard, so a late event cannot mark the live child as exited.
    this.childExitedBeforeDrain = true;
    this.detachChildStdoutListener(child);
    this.parser = new ContentLengthParser();
    this.child = null;
    this.clearPreSpawnState();
    this.fireCrashTimeOnExit();
    const stashed: Error | null = this.consumePendingTeardownCause();
    this.rejectAllOutstanding(
      stashed ??
        new Error(
          `RustSidecarPtyHost: sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"}) ` +
            "before response was received",
        ),
    );
    this.recordCrashOncePerChild(child);
    // Wakes drainSidecarHost's wait for the sidecar's exit (a no-op outside shutdown).
    this.notifyHostExitWaiter();
  }

  /** Same teardown as `handleChildExit`, for an async `error` event. */
  private handleChildError(child: SidecarChildProcess, err: Error): void {
    if (this.child !== child) {
      // Stale event for a replaced child; see handleChildExit.
      return;
    }
    this.childExitedBeforeDrain = true;
    this.detachChildStdoutListener(child);
    this.parser = new ContentLengthParser();
    this.child = null;
    this.clearPreSpawnState();
    this.fireCrashTimeOnExit();
    const stashed: Error | null = this.consumePendingTeardownCause();
    this.rejectAllOutstanding(
      stashed ??
        new Error(
          `RustSidecarPtyHost: sidecar emitted 'error' event (${err.message}); ` +
            "rejecting outstanding requests",
        ),
    );
    this.recordCrashOncePerChild(child);
    this.notifyHostExitWaiter();
  }

  /**
   * Fatal teardown for a payload decode failure: stashes `cause` for the exit handler to reject
   * outstanding requests with, then SIGKILLs the child. Only the first failure in a drain pass
   * acts, and the stash is set only when a child exists so it cannot leak into the next one.
   */
  private failFatallyOnDecodeError(cause: SidecarFrameDecodeError): void {
    console.warn(cause.message);
    if (this.pendingTeardownCause !== null) {
      return;
    }
    if (this.child !== null) {
      this.pendingTeardownCause = cause;
      try {
        this.child.kill("SIGKILL");
      } catch {
        // The child may already have exited.
      }
    }
  }

  /** Returns and clears the stashed teardown cause, so the next child does not inherit it. */
  private consumePendingTeardownCause(): Error | null {
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
   * Charges one crash-budget slot for `child`, once. Marks `permanentlyUnavailable` when the budget
   * is exhausted, so the next `ensureChild` throws.
   */
  private recordCrashOncePerChild(child: SidecarChildProcess): void {
    if (this.crashCountedChildren.has(child)) {
      return;
    }
    // Recorded even during shutdown so a stale second event for this child stays a no-op. The
    // deliberate exit during shutdown is not a crash and must not charge the budget.
    this.crashCountedChildren.add(child);
    if (this.shuttingDown) {
      return;
    }
    if (this.crashBudget.recordAndIsExhausted()) {
      this.permanentlyUnavailable = true;
    }
  }

  private rejectAllOutstanding(err: Error): void {
    for (const [, queue] of this.outstanding) {
      while (queue.length > 0) {
        const entry: OutstandingRequest | undefined = queue.shift();
        if (entry !== undefined) {
          entry.reject(err);
        }
      }
    }
  }
}

/**
 * Creates the production `RustSidecarPtyHost`. An explicit `binaryPath` skips the default
 * resolution (CI paths, hand-built binaries, integration tests).
 */
export function createRustSidecarPtyHost(opts?: {
  readonly binaryPath?: string;
}): RustSidecarPtyHost {
  const binaryPath: string | undefined = opts?.binaryPath;
  if (binaryPath !== undefined) {
    return new RustSidecarPtyHost({
      resolveBinaryPath: (): string => binaryPath,
    });
  }
  return new RustSidecarPtyHost();
}
