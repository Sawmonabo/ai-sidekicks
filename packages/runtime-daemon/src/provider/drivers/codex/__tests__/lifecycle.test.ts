// Codex driver — lifecycle + transport tests (Plan-005 Phase 3, T3.1).
//
// Coverage map (the cites are the authoritative contract, not just the ACs):
//
//   `Spec-005 §Required Behavior` — the normalized driver contract's lifecycle
//     surface: `createSession`, `resumeSession`, `startRun`, `interruptRun`,
//     `closeSession` each reach the pinned Codex `app-server` method with the
//     pinned parameter shape.
//   `Spec-005 §Fallback Behavior` (AC3) — a resume whose handle fails surfaces a
//     recovery-needed condition rather than a replacement session.
//   I-005-5 — asserted THREE ways, because the invariant has three distinct ways
//     to be violated:
//       (a) the returned value is the typed `failed` result (shape enforced by
//           `DriverResumeResultSchema`, not by hand-written matchers);
//       (b) `driver.createSession` is never called (the spy the plan names);
//       (c) no `thread/start` frame is ever written (the WIRE assertion — a
//           driver that created a thread through a private helper would pass
//           (b) and still have replaced the session).
//
// The fake is a fake PROVIDER, not a fake driver: it implements `PtyHost` and
// speaks JSON-RPC back over the same byte channel, so every test drives the real
// framing, correlation, deadline, and teardown code. Nothing in the module under
// test is stubbed.

import { describe, expect, it, vi } from "vitest";

import {
  deriveMainChannelId,
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type PtyHost,
  type PtySignal,
  type RunId,
  type SessionId,
  type SpawnRequest,
  type SpawnResponse,
  type DrainResult,
} from "@ai-sidekicks/contracts";

import {
  CodexAppServerConnection,
  CodexDriver,
  CodexLifecycleManager,
  CodexLineTooLongError,
  CodexSessionAlreadyLiveError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexTransportError,
  CODEX_APP_SERVER_BIN_ENV_VAR,
  CODEX_APP_SERVER_READY_SENTINEL,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  CODEX_MAX_LINE_LENGTH,
  normalizeProviderFailureDetail,
  parseCodexRunConfig,
  parseCodexSessionConfig,
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexScheduleTimeout,
  type CodexSessionConfig,
  type CodexTransportDiagnostic,
} from "../index.js";

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

interface JsonRpcAnswer {
  result?: unknown;
  // `data` is optional on the wire and carries the pinned provider's structured
  // refusal detail. Modelled here so the fake can emit a realistic refusal.
  error?: { code: number; message: string; data?: unknown };
  /**
   * Frames emitted in the SAME read chunk as this answer, after it.
   *
   * The point is the chunk boundary, not the ordering: one `onData` call
   * carrying both the response and a later notification is what makes the
   * driver's response continuation (a microtask) run AFTER the notification has
   * already been processed synchronously. Splitting them across two emissions
   * would let the microtask drain in between and hide the interleave entirely.
   */
  trailingFrames?: Array<Record<string, unknown>>;
}

type MethodHandler = (params: unknown) => JsonRpcAnswer;

/**
 * A `PtyHost` whose "child process" is a scripted Codex `app-server`.
 *
 * Emits the prelude's readiness sentinel on subscribe (as the real prelude does
 * before `exec`), records every written line verbatim, and answers registered
 * methods on a microtask so promise ordering stays deterministic without timers.
 */
class FakeCodexAppServer implements PtyHost {
  readonly spawnRequests: SpawnRequest[] = [];
  readonly writtenLines: string[] = [];
  readonly closedSessions: string[] = [];
  readonly killedSessions: Array<{ sessionId: string; signal: PtySignal }> = [];

  spawnResponse: SpawnResponse = { kind: "spawn_response", session_id: "pty-session-1" };
  /**
   * Hands every spawn its own pty session id.
   *
   * Required whenever more than one connection is live at once: the listener
   * registry is keyed by pty session id, so shared ids make a later subscribe
   * silently displace an earlier connection's reader and make "which process was
   * closed" unanswerable.
   */
  uniqueSpawnSessionIds = false;
  emitSentinelOnSubscribe = true;
  /**
   * Kills the child during the next write and then fails that write.
   *
   * Both halves matter. The exit rejects the request's inner promise while its
   * caller is still suspended, and the write's own failure means `request()`
   * rethrows from its catch and NEVER returns that promise -- so nothing
   * downstream can ever attach to it. Sequenced across macrotasks so a full
   * microtask drain (which is when Node decides a rejection is unhandled)
   * happens between the rejection and any possible handler.
   */
  failWriteAfterChildExit = false;
  /** Parks the next write on a macrotask, leaving its caller suspended. */
  parkNextWrite = false;

  readonly #listeners = new Map<string, CodexPtySessionListeners>();
  readonly #handlers = new Map<string, MethodHandler>();
  readonly #encoder = new TextEncoder();
  #spawnSequence = 0;
  #spawnGate: Promise<void> | null = null;
  #closeGate: Promise<void> | null = null;

  on(method: string, handler: MethodHandler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  subscribe(ptySessionId: string, listeners: CodexPtySessionListeners): () => void {
    this.#listeners.set(ptySessionId, listeners);
    if (this.emitSentinelOnSubscribe) {
      queueMicrotask(() => {
        this.emitLine(CODEX_APP_SERVER_READY_SENTINEL);
      });
    }
    return () => {
      this.#listeners.delete(ptySessionId);
    };
  }

  /** Server output is CRLF-terminated: output post-processing stays on. */
  emitLine(line: string): void {
    this.emitRaw(this.#encoder.encode(`${line}\r\n`));
  }

  emitFrame(frame: Record<string, unknown>): void {
    this.emitLine(JSON.stringify(frame));
  }

  emitRaw(bytes: Uint8Array): void {
    for (const listeners of this.#listeners.values()) {
      listeners.onData(bytes);
    }
  }

  emitExit(exitCode: number, signalCode?: number): void {
    for (const listeners of [...this.#listeners.values()]) {
      listeners.onExit(exitCode, signalCode);
    }
  }

  writtenFrames(): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const line of this.writtenLines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null) {
          frames.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* not a frame */
      }
    }
    return frames;
  }

  framesForMethod(method: string): Array<Record<string, unknown>> {
    return this.writtenFrames().filter((frame) => frame["method"] === method);
  }

  /**
   * Suspends every spawn until the returned release is called.
   *
   * Lets a test hold two establishments concurrently INSIDE their first
   * suspension, which is the only window in which a slot race is observable.
   */
  holdSpawns(): () => void {
    let release = (): void => {};
    this.#spawnGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.#spawnGate = null;
      release();
    };
  }

  async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    this.spawnRequests.push(spec);
    const gate = this.#spawnGate;
    if (gate !== null) {
      await gate;
    }
    if (!this.uniqueSpawnSessionIds) {
      return this.spawnResponse;
    }
    this.#spawnSequence += 1;
    return { kind: "spawn_response", session_id: `pty-session-${String(this.#spawnSequence)}` };
  }

  resize(): Promise<void> {
    return Promise.resolve();
  }

  write(sessionId: string, bytes: Uint8Array): Promise<void> {
    if (this.parkNextWrite) {
      this.parkNextWrite = false;
      return new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    if (this.failWriteAfterChildExit) {
      this.failWriteAfterChildExit = false;
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          this.emitExit(1);
          setTimeout(() => {
            reject(new Error("pty write failed: broken pipe"));
          }, 0);
        }, 0);
      });
    }
    const text = new TextDecoder().decode(bytes);
    for (const line of text.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      this.writtenLines.push(line);
      this.#maybeAnswer(sessionId, line);
    }
    return Promise.resolve();
  }

  kill(sessionId: string, signal: PtySignal): Promise<void> {
    this.killedSessions.push({ sessionId, signal });
    return Promise.resolve();
  }

  /**
   * Suspends every `close` until the returned release is called, AFTER the
   * session id has been recorded.
   *
   * Recording first is what makes the gate usable as a probe rather than just a
   * delay: a test can see that teardown reached the host and still hold it there,
   * which is the only window in which a slot freed mid-teardown is observable.
   * Gating the `thread/unsubscribe` answer instead would prove nothing — the
   * FIXED code suspends there too, so both arms would look identical and the
   * control would fail by timeout rather than by assertion.
   */
  holdCloses(): () => void {
    let release = (): void => {};
    this.#closeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.#closeGate = null;
      release();
    };
  }

  async close(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId);
    const gate = this.#closeGate;
    if (gate !== null) {
      await gate;
    }
  }

  shutdown(): Promise<DrainResult> {
    return Promise.resolve({
      sessionsDrained: 0,
      sessionsForcedKilled: 0,
      sidecarExitedCleanly: true,
      taskkillEscalated: false,
    });
  }

  onData(sessionId: string, chunk: Uint8Array): void {
    this.#listeners.get(sessionId)?.onData(chunk);
  }

  onExit(sessionId: string, exitCode: number, signalCode?: number): void {
    this.#listeners.get(sessionId)?.onExit(exitCode, signalCode);
  }

  #maybeAnswer(sessionId: string, line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) {
      return;
    }
    const record = frame as Record<string, unknown>;
    const method = record["method"];
    const id = record["id"];
    if (typeof method !== "string" || id === undefined) {
      return;
    }
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      return;
    }
    const answer = handler(record["params"]);
    queueMicrotask(() => {
      const frames: Array<Record<string, unknown>> = [
        {
          jsonrpc: "2.0",
          id,
          ...(answer.error === undefined ? { result: answer.result } : { error: answer.error }),
        },
        ...(answer.trailingFrames ?? []),
      ];
      // ONE chunk for the whole batch -- see `JsonRpcAnswer.trailingFrames`.
      const payload = frames.map((frame) => `${JSON.stringify(frame)}\r\n`).join("");
      // Routed to the session that WROTE the request, not broadcast: with more
      // than one live connection, broadcasting would deliver a response to a
      // peer whose independent id counter happens to have the same value.
      this.#listeners.get(sessionId)?.onData(this.#encoder.encode(payload));
    });
  }
}

interface ScheduledTimeout {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function makeManualScheduler(): {
  schedule: CodexScheduleTimeout;
  fireAll: () => void;
  pendingCount: () => number;
} {
  const scheduled: ScheduledTimeout[] = [];
  const schedule: CodexScheduleTimeout = (callback, delayMs) => {
    const entry: ScheduledTimeout = { callback, delayMs, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    fireAll: () => {
      for (const entry of scheduled) {
        if (!entry.cancelled) {
          entry.cancelled = true;
          entry.callback();
        }
      }
    },
    pendingCount: () => scheduled.filter((entry) => !entry.cancelled).length,
  };
}

/**
 * Drains the microtask queue by yielding to the macrotask queue once.
 *
 * A counted `await Promise.resolve()` is not equivalent and is why this exists:
 * it pins the test to an exact number of microtask hops, so any change to how the
 * driver sequences its own continuations silently turns a real assertion into a
 * hang. Yielding to a macrotask lets every pending microtask run, whatever their
 * number.
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function makeCapabilities(steer: boolean): DriverCapabilities {
  const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, true])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  flags.steer = steer;
  return { flags, contractVersion: "1.0.0" };
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;
const RUN_ID = "22222222-2222-4222-8222-222222222222" as RunId;
const SECOND_RUN_ID = "33333333-3333-4333-8333-333333333333" as RunId;
// Derived rather than cast: a real branded value, and the id the daemon would
// actually carry for a session's main channel.
const CHANNEL_ID = deriveMainChannelId(SESSION_ID);
const THREAD_ID = "01a04202-0148-7ae2-8560-622babf33ed0";
const TURN_ID = "turn-01";
const EXECUTABLE_PATH = "/opt/codex/bin/codex";

const SESSION_CWD = "/work/session";

// Typed as the contract types it — an opaque bag — so the tests exercise the
// same untyped boundary the daemon hands the driver, not a pre-narrowed shape.
const SESSION_CONFIG: Record<string, unknown> = {
  cwd: SESSION_CWD,
  env: [
    ["HOME", "/home/agent"],
    ["PATH", "/usr/bin"],
  ],
};

const RESUME_SPAWN_CONFIG: CodexSessionConfig = {
  cwd: "/work/resume",
  env: [["HOME", "/home/agent"]],
};

interface Harness {
  server: FakeCodexAppServer;
  driver: CodexDriver;
  diagnostics: CodexTransportDiagnostic[];
  scheduler: ReturnType<typeof makeManualScheduler>;
}

function createHarness(
  options: { steer?: boolean; subscribeToPtySession?: CodexPtySessionSubscriber } = {},
): Harness {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  const diagnostics: CodexTransportDiagnostic[] = [];
  const scheduler = makeManualScheduler();
  const driver = new CodexDriver({
    ptyHost: server,
    subscribeToPtySession:
      options.subscribeToPtySession ??
      ((ptySessionId, listeners) => server.subscribe(ptySessionId, listeners)),
    reportDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: RESUME_SPAWN_CONFIG,
    newBindingId: () => "binding-abc",
    readCapabilities: () => makeCapabilities(options.steer ?? true),
  });
  return { server, driver, diagnostics, scheduler };
}

function threadStartResult(turnCount = 0): JsonRpcAnswer {
  return {
    result: {
      thread: {
        id: THREAD_ID,
        sessionId: "session-tree-1",
        turns: Array.from({ length: turnCount }, (_unused, index) => ({ id: `turn-${index}` })),
      },
    },
  };
}

async function createdSession(harness: Harness): Promise<void> {
  harness.server.on("thread/start", () => threadStartResult());
  await harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
}

interface ManagerHarness {
  server: FakeCodexAppServer;
  manager: CodexLifecycleManager;
  diagnostics: CodexTransportDiagnostic[];
  notifications: Array<{ method: string; params: unknown }>;
  scheduler: ReturnType<typeof makeManualScheduler>;
}

interface ManagerHarnessOptions {
  onServerNotification?: boolean;
  /**
   * Wraps the real disposer in one that throws AFTER disposing.
   *
   * Disposing for real first isolates what is under test: the failure is purely
   * the caller-supplied code misbehaving, not a listener left registered.
   */
  throwingSubscriptionDisposer?: boolean;
  /** Overrides the binding-id minter, so a hostile mint can be driven. */
  newBindingId?: () => string;
}

/**
 * A harness over the MANAGER rather than the driver facade.
 *
 * `hasActiveTurn` and the route bookkeeping live on `CodexLifecycleManager`; the
 * driver's `Pick<ProviderDriver, ...>` deliberately does not surface them, so
 * route-lifetime assertions have to be made here.
 */
function createManagerHarness(options: ManagerHarnessOptions = {}): ManagerHarness {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  server.on("thread/start", () => threadStartResult());
  // Answered, because the manager's teardown awaits it and these tests run on a
  // manual scheduler where the courtesy deadline would never fire.
  server.on("thread/unsubscribe", () => ({ result: {} }));
  const diagnostics: CodexTransportDiagnostic[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const scheduler = makeManualScheduler();
  const manager = new CodexLifecycleManager({
    ptyHost: server,
    subscribeToPtySession: (ptySessionId, listeners) => {
      const dispose = server.subscribe(ptySessionId, listeners);
      if (options.throwingSubscriptionDisposer !== true) {
        return dispose;
      }
      return () => {
        dispose();
        throw new Error("subscription disposer failed");
      };
    },
    reportDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: RESUME_SPAWN_CONFIG,
    newBindingId: options.newBindingId ?? ((): string => "binding-abc"),
    ...(options.onServerNotification === true
      ? {
          onServerNotification: (method: string, params: unknown): void => {
            notifications.push({ method, params });
          },
        }
      : {}),
  });
  return { server, manager, diagnostics, notifications, scheduler };
}

/** A `turn/completed` frame at the pinned shape (`params.turn.{id,status}`). */
function turnCompletedFrame(turnId: string, status: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: { id: turnId, status, items: [] } },
  };
}

// --------------------------------------------------------------------------
// Spawn + handshake (`Spec-005 §Required Behavior`)
// --------------------------------------------------------------------------

describe("CodexDriver spawn and handshake", () => {
  it("spawns the provider behind the termios prelude with the binary in the env", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const spawnRequest = harness.server.spawnRequests[0];
    expect(spawnRequest).toBeDefined();
    expect(spawnRequest?.command).toBe("/bin/sh");
    expect(spawnRequest?.args).toEqual(["-c", CODEX_APP_SERVER_SHELL_PRELUDE]);
    expect(spawnRequest?.cwd).toBe(SESSION_CWD);
  });

  it("pins the prelude string that the measured PTY behaviour requires", () => {
    // Canonical mode caps one input line at 1024 bytes on Darwin and silently
    // discards anything longer, so `-icanon` is what makes this protocol
    // deliverable at all; `-echo` stops the reader seeing its own frames; `&&`
    // makes a failed `stty` abort the launch instead of degrading into silent
    // truncation; `exec` leaves no shell between PtyHost and the provider.
    expect(CODEX_APP_SERVER_SHELL_PRELUDE).toBe(
      `stty -icanon -echo && printf '%s\\n' ${CODEX_APP_SERVER_READY_SENTINEL} && exec "$${CODEX_APP_SERVER_BIN_ENV_VAR}" app-server`,
    );
  });

  it("passes exactly the supplied environment plus the binary path, never process.env", async () => {
    const harness = createHarness();
    await createdSession(harness);

    // Byte-exact equality is the assertion: a leaked `process.env` would add
    // entries, and this driver must never consult it.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      ["PATH", "/usr/bin"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("waits for the prelude sentinel before writing anything", async () => {
    const harness = createHarness();
    harness.server.emitSentinelOnSubscribe = false;
    harness.server.on("thread/start", () => threadStartResult());

    const pending = harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.server.writtenLines).toHaveLength(0);

    harness.server.emitLine(CODEX_APP_SERVER_READY_SENTINEL);
    await pending;
    expect(harness.server.framesForMethod("initialize")).toHaveLength(1);
  });

  it("declines experimental surfaces and attestation during initialize", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const initialize = harness.server.framesForMethod("initialize")[0];
    expect(initialize?.["params"]).toMatchObject({
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    expect(harness.server.framesForMethod("initialized")).toHaveLength(1);
  });

  it("fails with driver.unavailable when the spawn is refused", async () => {
    const harness = createHarness();
    harness.server.spawnResponse = {
      kind: "spawn_response",
      session_id: "",
      error: "fork failed",
    };

    await expect(
      harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).rejects.toMatchObject({ code: "driver.unavailable" });
  });

  it("tears the process down when the handshake fails, leaving no orphan", async () => {
    const harness = createHarness();
    harness.server.on("initialize", () => ({
      error: { code: -32600, message: "unsupported client" },
    }));

    await expect(
      harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).rejects.toThrow(/unsupported client/);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

// --------------------------------------------------------------------------
// createSession / startRun / interruptRun / closeSession
// --------------------------------------------------------------------------

describe("CodexDriver lifecycle operations", () => {
  it("starts a thread and returns the provider handle split", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    const handle = await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    // `thread.id` is the resume key; `thread.sessionId` groups a thread tree
    // (forks and subagents share it), so the two are not interchangeable.
    expect(handle).toEqual({ providerSessionId: "session-tree-1", resumeHandle: THREAD_ID });
    expect(harness.server.framesForMethod("thread/start")[0]?.["params"]).toEqual({
      cwd: SESSION_CWD,
      approvalsReviewer: "user",
    });
  });

  it("starts a turn with the pinned UserInput shape", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    expect(harness.server.framesForMethod("turn/start")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
      // `text_elements` is REQUIRED on the pinned `UserInput` text arm.
      input: [{ type: "text", text: "review the diff", text_elements: [] }],
      approvalsReviewer: "user",
    });
  });

  it("carries a per-turn output schema when the caller supplies one", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "summarize" },
      outputSchema: { type: "object" },
    });

    expect(harness.server.framesForMethod("turn/start")[0]?.["params"]).toMatchObject({
      outputSchema: { type: "object" },
    });
  });

  it("interrupts the turn bound to the run", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));

    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await harness.driver.interruptRun({ runId: RUN_ID });

    expect(harness.server.framesForMethod("turn/interrupt")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
  });

  it("refuses to interrupt a run with no active turn", async () => {
    const harness = createHarness();
    await createdSession(harness);

    await expect(harness.driver.interruptRun({ runId: RUN_ID })).rejects.toBeInstanceOf(
      CodexTransportError,
    );
  });

  it("unsubscribes from the thread and closes the process", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));

    await harness.driver.closeSession({ sessionId: SESSION_ID });

    expect(harness.server.framesForMethod("thread/unsubscribe")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
    });
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("closes idempotently and tolerates an unknown session", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));

    await harness.driver.closeSession({ sessionId: SESSION_ID });
    await expect(harness.driver.closeSession({ sessionId: SESSION_ID })).resolves.toBeUndefined();
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("still tears the process down when the unsubscribe is refused", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(harness.driver.closeSession({ sessionId: SESSION_ID })).resolves.toBeUndefined();
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

// --------------------------------------------------------------------------
// I-005-5 — resume failure never becomes a new session
// --------------------------------------------------------------------------

describe("CodexDriver resumeSession (I-005-5, Spec-005 §Fallback Behavior)", () => {
  it("returns the typed resumed result carrying the provider's turn count", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => threadStartResult(3));

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toEqual({ status: "resumed", bindingId: "binding-abc", sessionPosition: 3 });
  });

  it("round-trips the resume handle byte-identically into thread/resume", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());
    const handle = await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: handle.resumeHandle,
    });

    expect(harness.server.framesForMethod("thread/resume")[0]?.["params"]).toEqual({
      threadId: handle.resumeHandle,
      approvalsReviewer: "user",
    });
  });

  it("refuses a resume answered by a DIFFERENT thread, even with a well-formed history", async () => {
    const harness = createHarness();
    const createSessionSpy = vi.spyOn(harness.driver, "createSession");
    const replacementThreadId = "01a04202-0148-7ae2-8560-000000000999";
    // `turns: []` is a perfectly well-formed history, so the position check
    // cannot tell this from a genuine zero-turn resume. Only the id can -- which
    // is why the identity gate runs first.
    harness.server.on("thread/resume", () => ({
      result: { thread: { id: replacementThreadId, sessionId: "session-tree-9", turns: [] } },
    }));

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "unclassifiable",
    });
    // Both ids named, so an operator can see WHICH thread answered.
    const detail = (result as { providerFailureDetail: string }).providerFailureDetail;
    expect(detail).toContain(THREAD_ID);
    expect(detail).toContain(replacementThreadId);
    // I-005-5, all three ways: typed result, no createSession call, no
    // `thread/start` frame on the wire.
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
    // The refused leg's process is released rather than left running.
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("does not install a session record for a resume answered by a different thread", async () => {
    const harness = createManagerHarness();
    harness.server.on("thread/resume", () => ({
      result: { thread: { id: "01a04202-0148-7ae2-8560-000000000999", sessionId: "s", turns: [] } },
    }));

    const result = await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
    expect(result.status).toBe("failed");

    // Nothing installed: a subsequent create must be admitted, which it could not
    // be if the refused resume had taken the slot.
    harness.server.on("thread/start", () => threadStartResult());
    await expect(
      harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).resolves.toMatchObject({ resumeHandle: THREAD_ID });
  });

  it("surfaces recovery-needed and creates NO replacement session when resume is refused", async () => {
    const harness = createHarness();
    // The verbatim refusal the pinned binary returns for an unknown or
    // never-persisted thread (probed against codex-cli 0.149.1).
    harness.server.on("thread/resume", () => ({
      error: { code: -32600, message: `no rollout found for thread id ${THREAD_ID}` },
    }));
    const createSessionSpy = vi.spyOn(harness.driver, "createSession");

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    // (a) the typed failure shape
    expect(result).toEqual({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "unclassifiable",
      providerFailureDetail: expect.stringContaining("no rollout found"),
    });
    // (b) the spy the plan names
    expect(createSessionSpy).not.toHaveBeenCalled();
    // (c) the wire assertion — no thread was started by any path, public or not
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
    // and the failed attempt's process is not left running
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("still returns the typed failure when the provider error carries no message", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => ({ error: { code: -32600, message: "" } }));

    // `providerFailureDetail` is validated by `wireFreeFormString`, which rejects
    // empty strings — without normalization this path would THROW instead of
    // returning the typed condition, losing exactly what I-005-5 protects.
    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
    expect((result as { providerFailureDetail: string }).providerFailureDetail.trim()).not.toBe("");
  });

  it("still returns the typed failure when the provider error is enormous", async () => {
    const harness = createHarness();
    const huge = "e".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN * 2);
    harness.server.on("thread/resume", () => ({ error: { code: -32600, message: huge } }));

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
    expect(
      (result as { providerFailureDetail: string }).providerFailureDetail.length,
    ).toBeLessThanOrEqual(DRIVER_FAILURE_DETAIL_MAX_LEN);
  });

  it("refuses rather than fabricating a position when the reply carries no turn history", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => ({
      result: { thread: { id: THREAD_ID, sessionId: "session-tree-1" } },
    }));

    // Reporting position 0 would make a silently-fresh thread indistinguishable
    // from a resumed one, which is the confusion I-005-5 exists to prevent.
    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
  });

  it("returns the typed failure when the process dies before answering", async () => {
    const harness = createHarness();
    harness.server.emitSentinelOnSubscribe = false;

    const pending = harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
    // Drained rather than counted: the slot claim defers the establishment body
    // by a microtask, so a fixed hop count would leave the connection unsubscribed
    // and the exit would reach nobody.
    await drainMicrotasks();
    harness.server.emitExit(126);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
  });

  it("spawns the resume process with the caller-supplied resume context", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    // A resume is a FRESH spawn and `ResumeSessionParams` carries no spawn
    // context, so an empty environment here would look like a bad handle.
    expect(harness.server.spawnRequests[0]?.cwd).toBe(RESUME_SPAWN_CONFIG.cwd);
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("releases the superseded leg's process once the resume has succeeded", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(3));

    await expect(
      harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID }),
    ).resolves.toMatchObject({ status: "resumed" });

    // A resume is a fresh spawn, so the prior leg's child would be orphaned by a
    // driver that only overwrote its own session record.
    expect(harness.server.spawnRequests).toHaveLength(2);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("leaves the prior leg untouched when the resume fails", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(
      harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID }),
    ).resolves.toMatchObject({ recoveryCondition: "recovery-needed" });

    // Only the leg that just failed is torn down. Killing the live one would make
    // a refused resume destructive, which is the other half of I-005-5's promise:
    // the daemon decides what happens next, and it still has a session to decide
    // about.
    expect(harness.server.closedSessions).toEqual(["pty-session-2"]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await expect(
      harness.driver.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("still returns the typed failure when tearing the failed leg down throws", async () => {
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
    server.on("thread/resume", () => ({
      error: { code: -32600, message: "thread not found" },
    }));
    const scheduler = makeManualScheduler();
    const driver = new CodexDriver({
      ptyHost: server,
      // The disposer is caller-supplied code, so it is a real throw source on a
      // path whose whole obligation is to RETURN rather than throw.
      subscribeToPtySession: (ptySessionId, listeners) => {
        const dispose = server.subscribe(ptySessionId, listeners);
        return () => {
          dispose();
          throw new Error("subscription registry refused the release");
        };
      },
      reportDiagnostic: () => {},
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      newBindingId: () => "binding-abc",
      readCapabilities: () => makeCapabilities(true),
    });

    await expect(
      driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID }),
    ).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
  });
});

// --------------------------------------------------------------------------
// Transport behaviour
// --------------------------------------------------------------------------

describe("CodexAppServerConnection transport", () => {
  it("writes each frame as exactly one newline-terminated line", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    // Comfortably past the 1024-byte canonical-mode ceiling the prelude removes.
    const longInput = "z".repeat(8000);
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: longInput },
    });

    const line = harness.server.writtenLines.find((candidate) => candidate.includes("turn/start"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(JSON.parse(line ?? "{}")).toMatchObject({ method: "turn/start" });
  });

  it("reassembles frames split across chunk boundaries, including multi-byte characters", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await pending;

    // A response frame whose payload is split mid-character must still parse.
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 99, result: { note: "café" } })}\r\n`;
    const bytes = new TextEncoder().encode(frame);
    const splitAt = bytes.indexOf(0xc3);
    expect(splitAt).toBeGreaterThan(0);
    harness.server.emitRaw(bytes.slice(0, splitAt + 1));
    harness.server.emitRaw(bytes.slice(splitAt + 1));

    // Nothing correlates to id 99, so the reassembled frame surfaces as an
    // unknown response rather than as an unparsable line.
    expect(harness.diagnostics).toContainEqual({ kind: "unknown-response-id", responseId: "99" });
  });

  it("answers an unhandled server request exactly once, fail-closed", async () => {
    const harness = createHarness();
    await createdSession(harness);

    harness.server.emitFrame({
      jsonrpc: "2.0",
      id: 77,
      method: "execCommandApproval",
      params: { command: "rm -rf /" },
    });
    await Promise.resolve();

    const replies = harness.server.writtenFrames().filter((frame) => frame["id"] === 77);
    expect(replies).toHaveLength(1);
    // An error reply can never be mistaken for approval, and it stops the
    // provider from hanging on an unanswered request.
    expect(replies[0]?.["error"]).toMatchObject({ code: -32601 });
    expect(harness.diagnostics).toContainEqual({
      kind: "unhandled-server-request",
      method: "execCommandApproval",
      // A method the pin's `ServerRequest` census knows. Recorded on the
      // diagnostic rather than gating the answer -- see the uncensused case.
      censused: true,
    });
  });

  it("answers an UNCENSUSED method+id frame instead of dismissing it as an echo", async () => {
    const harness = createHarness();
    await createdSession(harness);

    // A request method a NEWER admitted build speaks and this pin never saw. It
    // correlates to nothing this connection sent, so it is a server request --
    // and leaving it unanswered would hang that turn for the provider's
    // lifetime, which is exactly what a census-gated router would do.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      id: 4242,
      method: "item/somethingNewer/requestApproval",
      params: {},
    });
    await Promise.resolve();

    const replies = harness.server.writtenFrames().filter((frame) => frame["id"] === 4242);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.["error"]).toMatchObject({ code: -32601 });
    expect(harness.diagnostics).toContainEqual({
      kind: "unhandled-server-request",
      method: "item/somethingNewer/requestApproval",
      censused: false,
    });
  });

  it("never answers an echoed client frame, identified by correlation", async () => {
    const harness = createHarness();
    await createdSession(harness);
    // Deliberately unanswered by the fake, so the request stays PENDING: an echo
    // is by definition a frame we sent and are still awaiting a reply to, and
    // correlation is the only honest test of that.
    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await Promise.resolve();
    const sent = harness.server.writtenFrames().find((frame) => frame["method"] === "turn/start");
    expect(sent).toBeDefined();
    const framesBefore = harness.server.writtenFrames().length;

    // What an ECHO-enabled tty reflects: our own request, method and id intact.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      id: sent?.["id"],
      method: "turn/start",
      params: {},
    });
    await Promise.resolve();

    // Never answered: a response to it would corrupt the server's correlation.
    expect(harness.server.writtenFrames()).toHaveLength(framesBefore);
    expect(harness.diagnostics).toContainEqual({
      kind: "echoed-client-frame",
      method: "turn/start",
    });

    // And the echo did not consume the pending entry -- the real reply still
    // lands, so the caller is not stranded until its deadline.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      id: sent?.["id"],
      result: { turn: { id: TURN_ID } },
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it("treats a frame matching a pending id but a DIFFERENT method as a server request", async () => {
    const harness = createHarness();
    await createdSession(harness);
    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await Promise.resolve();
    const sentId = harness.server
      .writtenFrames()
      .find((frame) => frame["method"] === "turn/start")?.["id"];

    // The two directions mint request ids in INDEPENDENT namespaces, so a
    // genuine server request may reuse an id we also used. Matching on the id
    // alone would silence it; matching on id AND method does not.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      id: sentId,
      method: "execCommandApproval",
      params: { command: "rm -rf /" },
    });
    await Promise.resolve();

    expect(
      harness.server
        .writtenFrames()
        .filter((frame) => frame["id"] === sentId && frame["error"] !== undefined),
    ).toHaveLength(1);

    harness.server.emitFrame({ jsonrpc: "2.0", id: sentId, result: { turn: { id: TURN_ID } } });
    await expect(pending).resolves.toBeUndefined();
  });

  it("reports server notifications that no consumer has claimed", async () => {
    const harness = createHarness();
    await createdSession(harness);

    harness.server.emitFrame({ jsonrpc: "2.0", method: "thread/itemAdded", params: {} });
    await Promise.resolve();

    expect(harness.diagnostics).toContainEqual({
      kind: "unconsumed-server-notification",
      method: "thread/itemAdded",
    });
  });

  it("reports unparsable output instead of dropping it", async () => {
    const harness = createHarness();
    await createdSession(harness);

    harness.server.emitLine("/bin/sh: codex: command not found");
    await Promise.resolve();

    expect(harness.diagnostics).toContainEqual({
      kind: "unparsable-line",
      line: "/bin/sh: codex: command not found",
    });
  });

  it("fails a request that outlives its deadline with driver.timeout", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await Promise.resolve();
    harness.scheduler.fireAll();

    await expect(pending).rejects.toBeInstanceOf(CodexRequestTimeoutError);
    await expect(pending).rejects.toMatchObject({ code: "driver.timeout" });
  });

  it("cancels the deadline once a response arrives", async () => {
    const harness = createHarness();
    await createdSession(harness);

    // Nothing may remain armed after the handshake and thread/start settle.
    expect(harness.scheduler.pendingCount()).toBe(0);
  });

  it("rejects in-flight requests and refuses further writes when the process exits", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await Promise.resolve();
    harness.server.emitExit(1, 9);

    await expect(pending).rejects.toMatchObject({ code: "driver.unavailable" });
    expect(harness.diagnostics).toContainEqual({
      kind: "process-exited",
      exitCode: 1,
      signalCode: 9,
    });
    // A write to an exited pty raises an asynchronous EIO no caller can catch,
    // so the connection must refuse before writing.
    await expect(
      harness.driver.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "again" },
      }),
    ).rejects.toMatchObject({ code: "driver.unavailable" });
  });
});

// --------------------------------------------------------------------------
// Config parsing + detail normalization
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Session identity and process ownership
// --------------------------------------------------------------------------

describe("CodexDriver session ownership (Spec-005 §Required Behavior)", () => {
  it("refuses a second createSession for a live session, spawning nothing", async () => {
    const harness = createHarness();
    await createdSession(harness);

    await expect(
      harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).rejects.toBeInstanceOf(CodexSessionAlreadyLiveError);
    // The refusal is the point only if it costs nothing: a replace would have
    // left the first child running with nothing routing to it.
    expect(harness.server.spawnRequests).toHaveLength(1);
    expect(harness.server.closedSessions).toEqual([]);
  });

  it("still creates a session once the previous one has been closed", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));
    await harness.driver.closeSession({ sessionId: SESSION_ID });

    await expect(
      harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).resolves.toMatchObject({ resumeHandle: THREAD_ID });
  });

  it("releases the spawned child when the subscriber throws", async () => {
    const harness = createHarness({
      subscribeToPtySession: () => {
        throw new Error("subscription registry refused the attach");
      },
    });

    await expect(
      harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).rejects.toThrow(/subscription registry refused the attach/);
    expect(harness.server.spawnRequests).toHaveLength(1);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  // Driven at the CONNECTION, because `createSession` has a guard of its own
  // that would release the child anyway and so cannot tell the two designs
  // apart. `open()` states on its own that it never leaves a child behind, and
  // that claim has to hold for every caller, not just the one with a net.
  it("open() itself releases the child when the subscriber throws", async () => {
    const server = new FakeCodexAppServer();
    const scheduler = makeManualScheduler();
    const connection = new CodexAppServerConnection({
      ptyHost: server,
      subscribeToPtySession: () => {
        throw new Error("subscription registry refused the attach");
      },
      reportDiagnostic: () => {},
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
    });

    await expect(connection.open(RESUME_SPAWN_CONFIG)).rejects.toThrow(/refused the attach/);
    expect(server.spawnRequests).toHaveLength(1);
    expect(server.closedSessions).toEqual(["pty-session-1"]);
  });

  // Pins the ROUTING consequence of a resume: a run from the superseded leg is
  // no longer active, because the replacement record knows nothing of it.
  //
  // Honest limit: this does not discriminate the route sweep itself. A stale
  // entry and a swept one both dead-end (the stale one resolves to a record with
  // no such turn), so the sweep has no behavioural observable on this class's
  // surface -- it bounds map growth across repeated resumes, and the only way to
  // assert that directly would be a test-only accessor on a production class.
  it("reports no active turn for a run that predates a resume", async () => {
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
    server.on("thread/start", () => threadStartResult());
    server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    const scheduler = makeManualScheduler();
    const manager = new CodexLifecycleManager({
      ptyHost: server,
      subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
      reportDiagnostic: () => {},
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      newBindingId: () => "binding-abc",
    });

    await manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(manager.hasActiveTurn(RUN_ID)).toBe(true);

    server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    server.on("thread/resume", () => threadStartResult(2));
    await manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    // The replacement record knows no runs, so `closeSession` could never sweep
    // this route afterwards: unswept here, it would outlive the daemon.
    expect(manager.hasActiveTurn(RUN_ID)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Approval-reviewer pinning (`Spec-005 §Required Behavior`)
// --------------------------------------------------------------------------

describe("CodexDriver approval reviewer pinning", () => {
  // The security property: every approval request the provider raises must reach
  // the daemon's own approval pipeline, so no config or profile override may
  // select `auto_review`. `approvalsReviewer` is present on ThreadStartParams,
  // ThreadResumeParams AND TurnStartParams at `codex-cli 0.149.1` (verified
  // 2026-08-27 against the binary's own generated schema), and the per-turn field
  // is documented as overriding routing for "this turn and subsequent turns" --
  // so a thread-level pin alone is defeated by any per-turn override.
  it("pins the reviewer on the thread AND on every turn, not just at thread start", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });
    await harness.driver.startRun({
      runId: SECOND_RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "two" },
    });

    expect(harness.server.framesForMethod("thread/start")[0]?.["params"]).toMatchObject({
      approvalsReviewer: "user",
    });
    const turnFrames = harness.server.framesForMethod("turn/start");
    expect(turnFrames).toHaveLength(2);
    // EVERY turn, not merely the first: the pin is idempotent, and skipping it on
    // later turns is exactly the gap a per-turn override would walk through.
    for (const frame of turnFrames) {
      expect(frame["params"]).toMatchObject({ approvalsReviewer: "user" });
    }
  });
});

// --------------------------------------------------------------------------
// Establishment slot — two overlapping establishments must not both spawn
// --------------------------------------------------------------------------

describe("CodexLifecycleManager establishment slot", () => {
  it("refuses a create that overlaps an establishment still in flight, spawning once", async () => {
    const harness = createManagerHarness();
    const release = harness.server.holdSpawns();

    // Both calls are issued in ONE tick, so the second runs its guard while the
    // first is suspended inside its spawn. A guard that read only the LIVE map
    // would see it empty here and spawn a second process whose handle the later
    // install would then orphan.
    const first = harness.manager.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    const second = harness.manager.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    // Released BEFORE the outcome is read, so a guard that failed to refuse
    // completes its spawn and this reads as a clean assertion failure rather
    // than as a timeout.
    release();
    const refusal = await second.then(
      () => undefined,
      (error: unknown) => error,
    );
    await first;

    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("establishing");
    // The whole point: the refused create cost no process.
    expect(harness.server.spawnRequests).toHaveLength(1);
  });

  it("serializes a BURST of resumes issued in one tick, releasing every superseded process", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/resume", () => threadStartResult(1));

    // THREE, not two, and the third is what makes this discriminating. Resume
    // supersedes rather than refuses, so the correctness condition is that each
    // resume observes its predecessor's installed record and releases that
    // connection. A slot that WAITS for absence and then claims serializes the
    // second caller correctly and still loses the third: two waiters released by
    // the same settlement both find the slot free, both establish concurrently,
    // and the later install orphans the earlier process with nothing left holding
    // a reference to close it.
    const results = await Promise.all([
      harness.manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID }),
      harness.manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID }),
      harness.manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["resumed", "resumed", "resumed"]);
    expect(harness.server.spawnRequests).toHaveLength(3);
    // Every process but the survivor is released, in the order they were
    // superseded. Exactly one is left live, and it is the last one spawned.
    expect(harness.server.closedSessions).toEqual(["pty-session-1", "pty-session-2"]);
  });

  it("makes closeSession wait for an in-flight establishment instead of no-opping", async () => {
    const harness = createManagerHarness();
    const release = harness.server.holdSpawns();

    const creating = harness.manager.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    // Issued while the create is suspended: a close that read the live map here
    // would find it empty, return, and leave the create's process running under
    // a session the daemon believes it closed.
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    release();
    await creating;
    await closing;

    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

// --------------------------------------------------------------------------
// Session slot state machine — a held slot spans every async step, both ways
// --------------------------------------------------------------------------

describe("CodexLifecycleManager session slot across teardown", () => {
  it("holds the slot for the whole of teardown and releases it once teardown settles", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    // Gated on the HOST close, which is the last step of teardown: the record is
    // already out of the live map under any implementation by the time we get
    // here, so what this window tests is the CLAIM and nothing else.
    const releaseCloses = harness.server.holdCloses();
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    await drainMicrotasks();
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);

    const refusal = await harness.manager
      .createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Read BEFORE the gate is released, so an implementation that frees the slot
    // during teardown completes its spawn and fails here as a clean assertion
    // rather than as a 5000ms timeout.
    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("closing");
    // The refused create cost no process — which is the point. A second child
    // admitted here would outlive the one still exiting beside it.
    expect(harness.server.spawnRequests).toHaveLength(1);

    releaseCloses();
    await closing;

    // And the slot is genuinely released, not merely held: the same create that
    // was refused a moment ago is now admitted.
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    expect(harness.server.spawnRequests).toHaveLength(2);
  });

  it("releases the process even when the subscription disposer throws during teardown", async () => {
    const harness = createManagerHarness({ throwingSubscriptionDisposer: true });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const outcome = await harness.manager.closeSession({ sessionId: SESSION_ID }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The fault still reaches the caller — it is not swallowed — but it no longer
    // DECIDES whether the child dies. Before the ordering fix it threw ahead of
    // the host release, so the process outlived a session reported closed.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("subscription disposer failed");
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
    // A session whose teardown threw must still be creatable: the record is
    // dropped in a `finally`, so a misbehaving disposer cannot wedge the slot.
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
  });

  it("reports the establishment failure rather than a teardown fault when both occur", async () => {
    const harness = createManagerHarness({ throwingSubscriptionDisposer: true });
    harness.server.on("thread/start", () => ({
      error: { code: -32001, message: "thread refused" },
    }));

    const outcome = await harness.manager
      .createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The provider's refusal is the actionable signal. A disposer that throws on
    // the way out must not displace it — the failing create is cleaning up AFTER
    // a failure, and its cleanup does not get to decide what the failure was.
    expect(outcome).toBeInstanceOf(CodexProviderRequestError);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);

    // And the slot is free: a failed establishment holds nothing.
    harness.server.on("thread/start", () => threadStartResult());
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
  });

  it("refuses a startRun for a session that is being torn down", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const releaseCloses = harness.server.holdCloses();
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    await drainMicrotasks();

    // The record stays installed for the length of teardown — that is what holds
    // the slot — so "installed" no longer implies "usable" and the guard has to
    // read the slot rather than the map.
    const starting = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    // Released BEFORE the outcome is read. The refusal under test is synchronous
    // at the call above, so releasing here cannot mask it — while an
    // implementation WITHOUT the guard falls through to the transport, triggers
    // the ambiguity disposal, and chains that disposal behind the very teardown
    // this gate is holding. Reading first would turn that into a 5000ms timeout,
    // which proves nothing about the guard.
    releaseCloses();
    const outcome = await starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await closing;

    // Pinned to THIS refusal, not merely to a transport error: an implementation
    // that deleted the record up front also refuses, but with "no live session" —
    // and only by accident of a slot it had already dropped.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("is being torn down");
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
  });

  it("refuses a turn/start whose session stopped holding its slot while it was in flight", async () => {
    const harness = createManagerHarness();
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    let closing: Promise<void> | undefined;
    harness.server.on("turn/start", () => {
      // Issued from INSIDE the write, so the teardown claims the slot and runs
      // while `startRun` is still suspended waiting for this very answer. The
      // provider accepts the turn; the session it belongs to is gone by the time
      // the answer lands.
      closing = harness.manager.closeSession({ sessionId: SESSION_ID });
      return { result: { turn: { id: TURN_ID } } };
    });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await closing;

    // Reporting success here would be a lie about a run whose process is dead,
    // and would strand a `#sessionIdByRunId` entry that no sweep can reach: every
    // sweep keys on a record that no longer exists.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("stopped holding its slot");
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

// --------------------------------------------------------------------------
// Ambiguous turn/start is connection-fatal (ADR-029: replay, never reconcile)
// --------------------------------------------------------------------------

describe("CodexLifecycleManager turn/start ambiguity", () => {
  it("kills the child and frees the slot when turn/start misses its deadline", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    // No `turn/start` handler is registered, so the request is never answered and
    // its deadline is the only way it can settle — which is exactly the case the
    // provider may nonetheless have ACCEPTED.
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const failure = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    harness.scheduler.fireAll();

    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);
    // Killed, not merely closed: an accepted turn keeps executing tools, and
    // `PtyHost` names no signal for `close`.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    // The retry is a CLEAN establishment. Leaving the session reusable is what
    // made a retry double the work against a turn nobody could see.
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    expect(harness.server.spawnRequests).toHaveLength(2);
  });

  it("treats a turn/start response with an unusable turn id as ambiguous", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: {} } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The provider answered, so this is not a deadline — but an answer with no
    // addressable turn id leaves the same question open, and the class is defined
    // by the question rather than by the failure mode.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
  });

  it("leaves the session live when turn/start is cleanly refused", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({
      error: { code: -32602, message: "input rejected" },
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The single exemption, and it is closed from the other end: a provider that
    // answered "no" is proof it processed the request and started nothing.
    expect(outcome).toBeInstanceOf(CodexProviderRequestError);
    expect(harness.server.killedSessions).toEqual([]);
    expect(harness.server.closedSessions).toEqual([]);

    // Still usable on the same process — a refusal must not cost a re-establish.
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
    expect(harness.server.spawnRequests).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// Resume commits only a VALIDATED result (I-005-5)
// --------------------------------------------------------------------------

describe("CodexLifecycleManager resume result validation", () => {
  it("installs nothing when the minted bindingId fails validation on a fresh resume", async () => {
    // `wireFreeFormString` rejects an empty mint, so the parse throws — the point
    // is WHERE it throws relative to the swap.
    const harness = createManagerHarness({ newBindingId: () => "" });
    harness.server.on("thread/resume", () => threadStartResult(2));

    const result = await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    // I-005-5: still the typed condition, never an exception.
    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
    // Nothing was installed against the connection this method then closed, so
    // the slot is free rather than mapped to a dead transport that only another
    // resume could clear.
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    expect(harness.server.spawnRequests).toHaveLength(2);
  });

  it("leaves the superseded leg live when the minted bindingId fails validation", async () => {
    const harness = createManagerHarness({ newBindingId: () => "" });
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/resume", () => threadStartResult(2));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const result = await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
    // Only the failed resume's OWN process is released. Releasing the predecessor
    // before the result was validated made a failed resume destructive, which is
    // the one thing this path promises never to be.
    expect(harness.server.closedSessions).toEqual(["pty-session-2"]);

    // And the leg that was live before the resume is still usable, on the same
    // process — which is what "a failed resume changes nothing" has to mean.
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
    expect(harness.server.spawnRequests).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------
// Turn route lifetime (`Spec-005 §Required Behavior`)
// --------------------------------------------------------------------------

describe("CodexLifecycleManager turn route lifetime", () => {
  // `turn/completed` is the provider's ONLY terminal-turn notification at the pin
  // (regenerated 2026-08-27); a failure or an interrupt arrives on the same
  // method and is discriminated by `turn.status`.
  it.each(["completed", "interrupted", "failed"])(
    "retires the route when the turn terminates as %s",
    async (status) => {
      const harness = createManagerHarness();
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
      await harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });
      expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);

      harness.server.emitFrame(turnCompletedFrame(TURN_ID, status));
      await Promise.resolve();

      // Without this, only interrupt and close ever clear a route: a turn that
      // simply FINISHES would read as active forever, and a later intervention
      // would target a turn id the provider retired long ago.
      expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    },
  );

  it("keeps the route while the turn is still inProgress", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    // `inProgress` is a member of the generated `TurnStatus` enum. Retiring on it
    // would refuse a mid-flight steer or interrupt as "no active turn".
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "inProgress"));
    await Promise.resolve();

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
  });

  it("retires a turn that terminates in the SAME read chunk as its start response", async () => {
    const harness = createManagerHarness();
    // One chunk carrying both frames. The response resolves `startRun` as a
    // MICROTASK while `#ingest` drains the rest of the chunk synchronously, so
    // the terminal is processed BEFORE the route is installed.
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [turnCompletedFrame(TURN_ID, "completed")],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("does not let a stale terminal retire a NEWER turn for the same run", async () => {
    const harness = createManagerHarness();
    let nextTurnId = TURN_ID;
    harness.server.on("turn/start", () => ({ result: { turn: { id: nextTurnId } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();

    nextTurnId = "turn-02";
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "two" },
    });

    // The sweep is keyed by TURN id, so a late duplicate for the retired turn
    // cannot reach the turn running now.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
  });

  it("passes the notification on to the consumer unchanged after observing it", async () => {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();

    // The manager interposes on this stream; it does not consume it. The event
    // normalizer (T3.5) is the consumer, and it must see the frame verbatim.
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.notifications).toContainEqual({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", items: [] } },
    });
  });
});

// --------------------------------------------------------------------------
// Rejection handling — a rejection nobody is attached to kills the daemon
// --------------------------------------------------------------------------

describe("CodexAppServerConnection rejection handling", () => {
  it("never leaves a request rejection unhandled when the child dies mid-write", async () => {
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", captureUnhandled);
    try {
      const harness = createHarness();
      await createdSession(harness);
      // The window: `request()` is suspended on its write, so `reject` is live
      // in `#pending` while the returned promise still has no handler -- and
      // because the write then fails too, `request()` rethrows and never returns
      // that promise, so no handler can arrive later either.
      harness.server.failWriteAfterChildExit = true;

      const pending = harness.driver.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });

      // The caller still learns the truth: the write's own failure propagates.
      await expect(pending).rejects.toThrow(/broken pipe/);
      // Two macrotasks: Node reports an unhandled rejection only after the
      // microtask queue drains, so a same-tick assertion would always pass.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  });

  it("delivers a deadline that fires while the write is still parked", async () => {
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", captureUnhandled);
    try {
      const harness = createHarness();
      await createdSession(harness);
      harness.server.parkNextWrite = true;

      const pending = harness.driver.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });
      // The deadline is armed inside the executor, so it is live before the
      // write is. Firing it here rejects the inner promise while `request()` is
      // still parked -- the same handlerless window as the exit case, reached
      // through the other rejector.
      harness.scheduler.fireAll();

      await expect(pending).rejects.toBeInstanceOf(CodexRequestTimeoutError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  });
});

// --------------------------------------------------------------------------
// Framing bounds — the read buffer is fed from provider-controlled input
// --------------------------------------------------------------------------

describe("CodexAppServerConnection framing bounds (Spec-005 §Pitfalls To Avoid)", () => {
  // A well-formed frame PREFIX. If the tail were ever truncated and handed on,
  // this would surface as a diagnostic for a frame the provider never sent.
  const FRAME_PREFIX = '{"jsonrpc":"2.0","method":"item/started","params":{"text":"';
  const OVERLONG_RETAINED_LENGTH = FRAME_PREFIX.length + CODEX_MAX_LINE_LENGTH;

  /** The prefix padded past the ceiling, with no line terminator anywhere. */
  function overlongFramePrefix(): Uint8Array {
    return new TextEncoder().encode(FRAME_PREFIX + "x".repeat(CODEX_MAX_LINE_LENGTH));
  }

  function diagnosticKinds(harness: Harness): string[] {
    return harness.diagnostics.map((diagnostic) => diagnostic.kind);
  }

  it("fails in-flight callers with the typed error and releases the process", async () => {
    const harness = createHarness();
    await createdSession(harness);
    // No `turn/start` handler is registered, so the request stays in flight and
    // the typed error has a caller to reach.
    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    harness.server.emitRaw(overlongFramePrefix());

    await expect(pending).rejects.toBeInstanceOf(CodexLineTooLongError);
    // Still a transport death by `code`, so no unregistered error-contract row
    // is minted and existing transport handling keeps working unchanged.
    await expect(pending).rejects.toBeInstanceOf(CodexTransportError);
    await expect(pending).rejects.toMatchObject({ code: "driver.unavailable" });
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("reports the breach with the limit that produced it", async () => {
    const harness = createHarness();
    await createdSession(harness);

    harness.server.emitRaw(overlongFramePrefix());
    await Promise.resolve();

    expect(harness.diagnostics).toContainEqual({
      kind: "line-too-long",
      retainedLength: OVERLONG_RETAINED_LENGTH,
      limit: CODEX_MAX_LINE_LENGTH,
    });
  });

  it("discards the over-long tail unparsed rather than delivering a partial frame", async () => {
    const harness = createHarness();
    await createdSession(harness);

    harness.server.emitRaw(overlongFramePrefix());
    await Promise.resolve();

    // Truncating would hand a frame prefix to the line handler, which would then
    // report an `unparsable-line` the provider never sent. Its absence is the
    // proof that nothing was truncated-and-parsed.
    expect(diagnosticKinds(harness)).not.toContain("unparsable-line");
  });

  it("tears down on an over-long line that TERMINATES inside the same chunk", async () => {
    const harness = createHarness();
    await createdSession(harness);
    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    // Crosses the ceiling and then terminates, so the retained tail is EMPTY.
    // A ceiling enforced only on the tail would parse and dispatch this frame.
    harness.server.emitRaw(
      new TextEncoder().encode(`${FRAME_PREFIX + "x".repeat(CODEX_MAX_LINE_LENGTH)}"}}\r\n`),
    );

    await expect(pending).rejects.toBeInstanceOf(CodexLineTooLongError);
    expect(diagnosticKinds(harness)).toContain("line-too-long");
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("signals the child rather than trusting release alone to stop it", async () => {
    const harness = createHarness();
    await createdSession(harness);

    harness.server.emitRaw(overlongFramePrefix());
    await Promise.resolve();

    // `PtyHost.close` promises resource release, not child termination, and the
    // peer producing the unbounded line is exactly the one that keeps writing.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
  });

  it("keeps accepting a line that reaches the ceiling without crossing it", async () => {
    const harness = createHarness();
    await createdSession(harness);
    const pending = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await Promise.resolve();
    const written = harness.server.writtenFrames();
    const requestId = written[written.length - 1]?.["id"];

    const skeleton = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: { turn: { id: TURN_ID }, padding: "" },
    });
    // One short of the ceiling, because the server terminates with CRLF and the
    // CR is part of the raw line the buffer holds: the line measured by the
    // driver is therefore exactly `CODEX_MAX_LINE_LENGTH`.
    const atCeiling = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        turn: { id: TURN_ID },
        padding: "x".repeat(CODEX_MAX_LINE_LENGTH - skeleton.length - 1),
      },
    });
    expect(atCeiling).toHaveLength(CODEX_MAX_LINE_LENGTH - 1);
    harness.server.emitLine(atCeiling);

    await expect(pending).resolves.toBeUndefined();
    expect(diagnosticKinds(harness)).not.toContain("line-too-long");
  });

  it("bounds the pre-sentinel window instead of holding open() to the deadline", async () => {
    const harness = createHarness();
    // The window a refused `stty` leaves open: the prelude never reaches its
    // `printf`, and whatever the tty emits has no line terminator to drain it.
    harness.server.emitSentinelOnSubscribe = false;
    const pending = harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await Promise.resolve();
    await Promise.resolve();

    harness.server.emitRaw(overlongFramePrefix());

    await expect(pending).rejects.toBeInstanceOf(CodexLineTooLongError);
    // Failed through the readiness waiter, not by outliving the startup timer:
    // a leftover deadline here would mean the buffer grew for the whole window.
    expect(harness.scheduler.pendingCount()).toBe(0);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

// --------------------------------------------------------------------------
// Provider refusal detail
// --------------------------------------------------------------------------

describe("CodexProviderRequestError (Spec-005 §Required Behavior)", () => {
  it("carries the JSON-RPC error data member verbatim", async () => {
    const harness = createHarness();
    await createdSession(harness);
    // The shape the pinned provider answers a refused steer with. Carried whole
    // and unparsed: classification is a later leg, but the loss would be
    // irreversible, so the transport keeps what it was given.
    const codexErrorInfo = {
      codexErrorInfo: { kind: "turn_not_interruptible", detail: ["no active turn"] },
    };
    harness.server.on("turn/interrupt", () => ({
      error: { code: -32602, message: "cannot interrupt", data: codexErrorInfo },
    }));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    await expect(harness.driver.interruptRun({ runId: RUN_ID })).rejects.toMatchObject({
      providerErrorCode: -32602,
      providerErrorData: codexErrorInfo,
    });
  });

  it("leaves the data member absent when the provider sent none", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({
      error: { code: -32600, message: "thread is busy" },
    }));

    const rejection = await harness.driver
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(CodexProviderRequestError);
    expect((rejection as CodexProviderRequestError).providerErrorData).toBeUndefined();
  });
});

describe("Codex driver config read-shapes", () => {
  it("accepts a well-formed session config", () => {
    expect(parseCodexSessionConfig(SESSION_CONFIG)).toEqual(SESSION_CONFIG);
  });

  it.each([
    ["a non-object", 42],
    ["a missing cwd", { env: [] }],
    ["an empty cwd", { cwd: "", env: [] }],
    ["a missing env", { cwd: "/work" }],
    ["a malformed env pair", { cwd: "/work", env: [["ONLY_A_NAME"]] }],
    ["a non-string env value", { cwd: "/work", env: [["NAME", 7]] }],
  ])("refuses %s", (_label, config) => {
    expect(() => parseCodexSessionConfig(config)).toThrow(/CreateSessionParams\.config/);
  });

  it("accepts a well-formed run config and keeps optional members absent", () => {
    expect(parseCodexRunConfig({ sessionId: SESSION_ID, input: "hello" })).toEqual({
      sessionId: SESSION_ID,
      input: "hello",
    });
  });

  it.each([
    ["a missing session id", { input: "hello" }],
    ["a missing input", { sessionId: SESSION_ID }],
    ["an empty input", { sessionId: SESSION_ID, input: "" }],
    ["an empty optional model", { sessionId: SESSION_ID, input: "hello", model: "" }],
    // The brand is a UUID, so a plausible-looking string must not wear it into
    // the session map, where the mismatch would surface as a puzzling "no live
    // session" far from the input that caused it.
    ["a session id that is not a session id", { sessionId: "session-1", input: "hello" }],
  ])("refuses %s", (_label, agentConfig) => {
    expect(() => parseCodexRunConfig(agentConfig)).toThrow(/StartRunParams\.agentConfig/);
  });

  it("normalizes provider failure detail into something the schema accepts", () => {
    expect(normalizeProviderFailureDetail(new Error("boom"))).toBe("boom");
    expect(normalizeProviderFailureDetail("   ")).toMatch(/no diagnostic message/);
    expect(normalizeProviderFailureDetail(undefined)).toMatch(/no diagnostic message/);
    expect(normalizeProviderFailureDetail("with\0nul")).toBe("withnul");
    expect(
      normalizeProviderFailureDetail("x".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN + 10)),
    ).toHaveLength(DRIVER_FAILURE_DETAIL_MAX_LEN);
  });
});
