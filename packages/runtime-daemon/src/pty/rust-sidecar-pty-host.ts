// Out-of-process Rust PTY sidecar implementation of the `PtyHost` contract.
//
// Exists because node-pty's ConPTY backend on Windows has known bugs (`microsoft/node-pty#904`,
// `#887`, `#894`, `openai/codex#13973`). This is the daemon side: it spawns the sidecar, speaks
// Content-Length framing on its stdio, supervises crashes, and maps `PtyHost` onto wire envelopes.
//
// - Framing: the shared Content-Length `parseFrame` under the sidecar's own body limit. The Rust
//   twin is `framing.rs`; the two are maintained by hand.
// - Method shape and lifecycle match `NodePtyHost`, so `PtyHostSelector` can swap the backends.
// - Effectful primitives are injectable through `RustSidecarPtyHostDeps`.

import { Buffer } from "node:buffer";
import { defaultSpawnTaskkill, type TaskkillResult } from "./taskkill-windows.js";
import { PtyBackendUnavailableError, resolveSidecarBinaryPath } from "./sidecar-binary-path.js";
import { isStrictBase64, serializeFrame, SidecarFrameDecodeError } from "./sidecar-frame-codec.js";
import {
  SidecarChildSupervisor,
  type SidecarChildProcess,
  type SidecarChildSupervisorDependencies,
  type SidecarSpawnFn,
} from "./sidecar-child-supervisor.js";
import { SidecarPreSpawnBuffer } from "./sidecar-pre-spawn-buffer.js";
import type {
  Envelope,
  ExitCodeNotification,
  PtySignal,
  SpawnRequest,
  SpawnResponse,
} from "./pty-host-protocol.js";
import type { DrainResult, PtyHost } from "./pty-host.js";

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

/** Monotonic clock: `Date.now()` can jump backward, which would trip or release the budget. */
function defaultNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Fills in the production primitives the caller did not inject. */
function resolveDefaultDeps(
  partial: Partial<RustSidecarPtyHostDeps>,
): SidecarChildSupervisorDependencies {
  return {
    resolveBinaryPath: partial.resolveBinaryPath ?? resolveSidecarBinaryPath,
    spawn: partial.spawn ?? null,
    nowMs: partial.nowMs ?? defaultNowMs,
    platform: partial.platform ?? process.platform,
    spawnTaskkill: partial.spawnTaskkill ?? defaultSpawnTaskkill,
  };
}

/** Per-session state, keyed by the sidecar-minted `s-{n}` session id. */
interface PtySessionRecord {
  /** `true` once `onExit` has fired for this session; write-once, so the exit is reported once. */
  hasExited: boolean;
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

/**
 * `PtyHost` backed by a supervised Rust sidecar child process (all three stdio streams piped)
 * speaking Content-Length framing. A child exit triggers a respawn through `ensureChild`; an
 * exhausted crash budget surfaces `PtyBackendUnavailableError`.
 */
export class RustSidecarPtyHost implements PtyHost {
  private readonly childProcess: SidecarChildSupervisor;

  private readonly sessions: Map<string, PtySessionRecord> = new Map();

  /**
   * Set at `shutdown()` entry: suppresses respawn and crash accounting for the deliberate exit and
   * makes `ensureChild` reject a concurrent `spawn()`. Terminal; the instance is single-use.
   */
  private shuttingDown = false;

  /** Memoized `shutdown()` result: a second call awaits the same drain. */
  private shutdownPromise: Promise<DrainResult> | null = null;

  /** Per-session drain resolvers made at `shutdown()` entry; settled by `notifyShutdownWaiter`. */
  private readonly shutdownWaiters: Map<string, () => void> = new Map();

  /** Pending requests by response kind, oldest first; normally at most one per kind. */
  private readonly outstanding: Map<Envelope["kind"], OutstandingRequest[]> = new Map();

  private dataListener: (sessionId: string, chunk: Uint8Array) => void = () => undefined;

  private exitListener: (sessionId: string, exitCode: number, signalCode?: number) => void = () =>
    undefined;

  private readonly preSpawnBuffer: SidecarPreSpawnBuffer = new SidecarPreSpawnBuffer();

  public constructor(deps?: Partial<RustSidecarPtyHostDeps>) {
    this.childProcess = new SidecarChildSupervisor(resolveDefaultDeps(deps ?? {}), {
      onFrame: (body: Buffer): void => {
        this.handleInbound(body);
      },
      onChildExit: (child: SidecarChildProcess, code: number | null, signal: string | null) => {
        this.handleChildExit(child, code, signal);
      },
      onChildError: (child: SidecarChildProcess, err: Error) => {
        this.handleChildError(child, err);
      },
    });
  }

  /**
   * Starts a PTY session in the sidecar, spawning the sidecar first if needed. Rejects with the
   * sidecar's error, or with `PtyBackendUnavailableError` once the crash budget is spent or after
   * `shutdown()`.
   */
  public async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    await this.childProcess.ensureChild(this.shuttingDown);
    // The session is registered in `resolveOutstanding`, not after this await: frames dispatch
    // synchronously, so a `DataFrame` following the response in the same chunk would find no
    // session. Frames arriving before the response are held and delivered by
    // `deliverBufferedSpawnEvents`.
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
    await this.childProcess.ensureChild(this.shuttingDown);
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
    await this.childProcess.ensureChild(this.shuttingDown);
    const base64: string = Buffer.from(bytes).toString("base64");
    await this.sendRequest(
      { kind: "write_request", session_id: sessionId, bytes: base64 },
      "write_response",
    );
  }

  /**
   * Signals a session; an exited one gets nothing and its exit is not reported again. Rejects for
   * an unknown id.
   */
  public async kill(sessionId: string, signal: PtySignal): Promise<void> {
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`RustSidecarPtyHost.kill: unknown sessionId '${sessionId}'`);
    }
    if (record.hasExited) {
      return;
    }
    await this.childProcess.ensureChild(this.shuttingDown);
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
    const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    this.sessions.delete(sessionId);
    this.preSpawnBuffer.recordClosedSessionId(sessionId);
    if (!record.hasExited) {
      try {
        await this.sendRequest(
          { kind: "kill_request", session_id: sessionId, signal: "SIGTERM" },
          "kill_response",
        );
      } catch (err: unknown) {
        // close() does not throw when the child exited mid-request; the failure is logged.
        console.warn(`RustSidecarPtyHost: close: kill request failed for session ${sessionId}.`, {
          cause: err,
        });
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

    const hostResult: { sidecarExitedCleanly: boolean; taskkillEscalated: boolean } =
      await this.childProcess.drainSidecarHost(options.hostTimeoutMs);

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

      // A crash mid-drain fires a -1 exit and rejects the request (logged); nothing settles the
      // waiter, so the timer fires and the session counts as forced.
      const gracefulDrain: Promise<"drained"> = (async (): Promise<"drained"> => {
        try {
          await this.sendRequest(
            { kind: "kill_request", session_id: sessionId, signal: "SIGTERM" },
            "kill_response",
          );
        } catch (err: unknown) {
          // Logged, not thrown; see the crash case above.
          console.warn(
            `RustSidecarPtyHost: shutdown: SIGTERM request failed for session ${sessionId}.`,
            { cause: err },
          );
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
      ).catch((err: unknown) => {
        console.warn(
          `RustSidecarPtyHost: shutdown: SIGKILL request failed for session ${sessionId}.`,
          { cause: err },
        );
      });
      // onExit fires with code 1 and no signal, as in NodePtyHost, not the -1 crash sentinel;
      // without it the consumer could wait forever if the sidecar reaps the child but sends no
      // notification. The hasExited check prevents a double fire; a later real notification hits
      // the duplicate branch.
      const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
      if (record !== undefined && !record.hasExited) {
        record.hasExited = true;
        try {
          this.fireExit(sessionId, 1, undefined);
        } catch (err: unknown) {
          const message: string = err instanceof Error ? err.message : String(err);
          console.warn(
            `RustSidecarPtyHost: synthetic forced-kill onExit listener threw for session ` +
              `${sessionId}: ${message}; continuing drain.`,
          );
        }
        this.notifyShutdownWaiter(sessionId);
      }
      return "forced";
    } finally {
      this.shutdownWaiters.delete(sessionId);
    }
  }

  private notifyShutdownWaiter(sessionId: string): void {
    const resolver: (() => void) | undefined = this.shutdownWaiters.get(sessionId);
    if (resolver !== undefined) {
      resolver();
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
      this.childProcess.failFatallyOnDecodeError(cause);
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
      this.childProcess.failFatallyOnDecodeError(cause);
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
          this.childProcess.failFatallyOnDecodeError(cause);
          break;
        }
        const bytes: Uint8Array = Buffer.from(envelope.bytes, "base64");
        // Alive: fire onData. Closed: drop, close() already removed the record. Unknown: buffer,
        // because the sidecar's reader task and its random-order writer can put a frame or exit
        // notification on the wire before the SpawnResponse; deliverBufferedSpawnEvents
        // delivers it.
        if (this.sessions.has(envelope.session_id)) {
          this.dataListener(envelope.session_id, bytes);
          break;
        }
        if (this.preSpawnBuffer.isClosed(envelope.session_id)) {
          break;
        }
        this.preSpawnBuffer.bufferPreSpawnData(envelope.session_id, bytes);
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
          `RustSidecarPtyHost: unexpected inbound request kind ${envelope.kind} ` +
            `from sidecar; skipping.`,
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
        this.childProcess.failFatallyOnDecodeError(cause);
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
    const record: PtySessionRecord | undefined = this.sessions.get(notification.session_id);
    if (record !== undefined) {
      if (record.hasExited) {
        // Duplicate. Still tick the shutdown waiter so a shutdown racing a re-emission converges.
        this.notifyShutdownWaiter(notification.session_id);
        return;
      }
      record.hasExited = true;
      this.fireExit(
        notification.session_id,
        notification.exit_code,
        notification.signal_code ?? undefined,
      );
      // Lets drainSingleSession finish once the real exit has been dispatched.
      this.notifyShutdownWaiter(notification.session_id);
      return;
    }
    if (this.preSpawnBuffer.isClosed(notification.session_id)) {
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
    this.preSpawnBuffer.bufferPreSpawnExit(notification);
  }

  /**
   * Resolves or rejects the head of the FIFO for the response's kind. A response carrying `error`
   * rejects it (most often `UnknownSession` for a request that lost a race with natural exit;
   * close() logs that) and a rejected `spawn_response` registers no session.
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
          `RustSidecarPtyHost: sidecar ${envelope.kind} returned error for ` +
            `session_id='${envelope.session_id}': ${envelope.error}`,
        ),
      );
      return;
    }
    // Registered here, not after spawn()'s await, so frames trailing this SpawnResponse in the same
    // stdout chunk see `sessions.has(id)`. Earlier frames are delivered by
    // deliverBufferedSpawnEvents, deferred so the caller's `await spawn()` records the id before
    // onData or onExit fires.
    if (envelope.kind === "spawn_response") {
      // A spawn racing shutdown() slips past runShutdown's snapshot, and the sidecar's exit
      // teardown would delete the unregistered session, so refuse like ensureChild. Nothing is
      // correlated: nobody awaits a rejected spawn, and buffered frames are cleared when the
      // sidecar exits.
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
      this.sessions.set(envelope.session_id, { hasExited: false });
      this.deliverBufferedSpawnEvents(envelope.session_id);
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
   * Delivers the buffered pre-spawn data, then the exit, for `sessionId` in `setImmediate`, so the
   * `spawn()` caller's continuation records the id first. `unref()` keeps the timer from holding
   * the daemon open.
   */
  private deliverBufferedSpawnEvents(sessionId: string): void {
    const { dataFrames, exit } = this.preSpawnBuffer.takePreSpawnEvents(sessionId);
    if (dataFrames === undefined && exit === undefined) {
      return;
    }
    const handle: NodeJS.Immediate = setImmediate(() => {
      // Re-check at fire time: a close() since scheduling removed the record and must suppress
      // the fan-out.
      if (this.preSpawnBuffer.isClosed(sessionId)) {
        return;
      }
      if (dataFrames !== undefined && this.sessions.has(sessionId)) {
        for (const bytes of dataFrames) {
          this.dataListener(sessionId, bytes);
        }
      }
      if (exit !== undefined) {
        const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
        if (record === undefined || record.hasExited) {
          // The record is gone (same-tick teardown) or the exit already fired; deliver at most
          // once.
          return;
        }
        record.hasExited = true;
        this.fireExit(sessionId, exit.exit_code, exit.signal_code ?? undefined);
      }
    });
    handle.unref();
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
      const child: SidecarChildProcess | null = this.childProcess.currentChild;
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

  /**
   * On sidecar death, fires a synthetic `onExit(-1)` (outside real exit codes, distinct from the
   * forced-kill `1`) for each session not yet exited, then deletes every record. A throwing
   * listener is caught so it cannot strand the remaining sessions or the rest of teardown.
   */
  private fireCrashTimeOnExit(): void {
    const sessionIds: string[] = Array.from(this.sessions.keys());
    // Each session gets one terminal onExit: its real exit, the forced-kill exit from
    // drainSingleSession, or the -1 below; `hasExited` is the dedupe.
    for (const sessionId of sessionIds) {
      const record: PtySessionRecord | undefined = this.sessions.get(sessionId);
      if (record === undefined) {
        continue;
      }
      if (!record.hasExited) {
        record.hasExited = true;
        try {
          this.fireExit(sessionId, -1, undefined);
        } catch (err: unknown) {
          const message: string = err instanceof Error ? err.message : String(err);
          console.warn(
            `RustSidecarPtyHost: crash-time onExit listener threw for session ${sessionId}: ` +
              `${message}; continuing teardown.`,
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
    // Ignore events for a replaced child: teardown would clear the new child and reject its
    // pending requests with the old child's failure.
    if (!this.childProcess.releaseExitedChild(child)) {
      return;
    }
    this.preSpawnBuffer.clearPreSpawnState();
    this.fireCrashTimeOnExit();
    const stashed: Error | null = this.childProcess.consumePendingTeardownCause();
    this.rejectAllOutstanding(
      stashed ??
        new Error(
          `RustSidecarPtyHost: sidecar exited ` +
            `(code=${code ?? "null"}, signal=${signal ?? "null"}) ` +
            "before response was received",
        ),
    );
    this.childProcess.recordCrashOncePerChild(child, this.shuttingDown);
    // Wakes drainSidecarHost's wait for the sidecar's exit (a no-op outside shutdown).
    this.childProcess.notifyHostExitWaiter();
  }

  /** Same teardown as `handleChildExit`, for an async `error` event. */
  private handleChildError(child: SidecarChildProcess, err: Error): void {
    // Stale event for a replaced child; see handleChildExit.
    if (!this.childProcess.releaseExitedChild(child)) {
      return;
    }
    this.preSpawnBuffer.clearPreSpawnState();
    this.fireCrashTimeOnExit();
    const stashed: Error | null = this.childProcess.consumePendingTeardownCause();
    this.rejectAllOutstanding(
      stashed ??
        new Error(
          `RustSidecarPtyHost: sidecar emitted 'error' event (${err.message}); ` +
            "rejecting outstanding requests",
        ),
    );
    this.childProcess.recordCrashOncePerChild(child, this.shuttingDown);
    this.childProcess.notifyHostExitWaiter();
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
 *
 * @consumedBy the terminal selector's Windows default, once the sidecar package is a dependency
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
