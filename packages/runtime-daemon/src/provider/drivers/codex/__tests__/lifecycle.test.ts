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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveMainChannelId,
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverResumeResult,
  type PtyHost,
  type PtySignal,
  type RunId,
  type SessionId,
  type SpawnRequest,
  type SpawnResponse,
  type ApplyInterventionParams,
  type DrainResult,
  type ExecutionPosture,
} from "@ai-sidekicks/contracts";

import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import type { SubagentLifecycleEmission } from "../../../thread-frame-router.js";
import type { CumulativeAxisReadings, MeteredUsageDelta } from "../../../usage-delta-accountant.js";
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
  CODEX_APP_SERVER_SHELL_ARGV0,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  CODEX_MAX_LINE_LENGTH,
  CODEX_ROUTED_SERVER_REQUEST_METHODS,
  CodexDriverConfigError,
  composeCodexTransportArgv,
  type CodexServerRequestDecision,
  type CodexWebsocketBearerCredential,
  type CodexSessionServerRequestResponder,
  describeCodexPostureDivergence,
  normalizeProviderFailureDetail,
  parseCodexRunConfig,
  parseCodexSessionConfig,
  resolveCodexTransportSelection,
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexScheduleTimeout,
  type CodexSessionConfig,
  type CodexTransportDiagnostic,
  type CodexTransportSelection,
  CODEX_INTERVENTION_FALLBACK_ACTION,
} from "../index.js";
import { CODEX_NEGOTIATION_GATED_METHODS } from "../event-normalizer.js";

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
  driverDiagnostics: DriverDiagnosticsEmitter;
  scheduler: ReturnType<typeof makeManualScheduler>;
}

/**
 * The T3.11 diagnostic band, silenced. The default log sink writes to the
 * console, which would make every policy diagnostic a line of test output; the
 * emitter still retains the records, which is what the assertions read.
 */
function makeSilentDriverDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({
    logSink: { record: () => undefined },
    counterSink: { increment: () => undefined },
  });
}

function createHarness(
  options: { steer?: boolean; subscribeToPtySession?: CodexPtySessionSubscriber } = {},
): Harness {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  // Answered by default so the P3-3 resume-failure auth classification resolves:
  // these tests run on a manual scheduler where its deadline would never fire,
  // and a logged-in provider is the realistic baseline. Cases that care about
  // the logged-out reading re-register this method.
  server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driverDiagnostics = makeSilentDriverDiagnostics();
  const scheduler = makeManualScheduler();
  const driver = new CodexDriver({
    ptyHost: server,
    diagnostics: driverDiagnostics,
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
  return { server, driver, diagnostics, driverDiagnostics, scheduler };
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
  driverDiagnostics: DriverDiagnosticsEmitter;
  notifications: Array<{ method: string; params: unknown }>;
  meteredUsage: Array<{ sessionId: SessionId; delta: MeteredUsageDelta }>;
  subagentLifecycle: Array<{ sessionId: SessionId; emission: SubagentLifecycleEmission }>;
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
  /**
   * Throws from the FIRST diagnostic and records every one after it.
   *
   * Throwing from all of them would make "the drain survived" unobservable
   * through the sink itself; throwing once leaves the next diagnostic as the
   * evidence.
   */
  throwOnFirstDiagnostic?: boolean;
  /**
   * Throws from the FIRST notification delivered to the consumer, then behaves.
   *
   * Same reason as the sink flag: the next notification is what proves the drain
   * survived, so throwing from every one would make the property unobservable.
   */
  throwOnFirstNotification?: boolean;
  /** Supplies the daemon's prior-emitted cumulative sums for a resume base. */
  readPriorEmittedUsage?: (
    sessionId: SessionId,
    threadId: string,
  ) => CumulativeAxisReadings | undefined;
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
  // Answered by default so the P3-3 resume-failure auth classification resolves:
  // these tests run on a manual scheduler where its deadline would never fire,
  // and a logged-in provider is the realistic baseline. Cases that care about
  // the logged-out reading re-register this method.
  server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driverDiagnostics = makeSilentDriverDiagnostics();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const meteredUsage: Array<{ sessionId: SessionId; delta: MeteredUsageDelta }> = [];
  const subagentLifecycle: Array<{ sessionId: SessionId; emission: SubagentLifecycleEmission }> =
    [];
  const scheduler = makeManualScheduler();
  let firstDiagnosticThrown = false;
  let firstNotificationThrown = false;
  const manager = new CodexLifecycleManager({
    ptyHost: server,
    diagnostics: driverDiagnostics,
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
      if (options.throwOnFirstDiagnostic === true && !firstDiagnosticThrown) {
        firstDiagnosticThrown = true;
        throw new Error("diagnostic sink failed");
      }
      diagnostics.push(diagnostic);
    },
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: RESUME_SPAWN_CONFIG,
    newBindingId: options.newBindingId ?? ((): string => "binding-abc"),
    onMeteredUsage: (sessionId, delta) => meteredUsage.push({ sessionId, delta }),
    onSubagentLifecycle: (sessionId, emission) => subagentLifecycle.push({ sessionId, emission }),
    ...(options.readPriorEmittedUsage === undefined
      ? {}
      : { readPriorEmittedUsage: options.readPriorEmittedUsage }),
    ...(options.onServerNotification === true
      ? {
          onServerNotification: (method: string, params: unknown): void => {
            if (options.throwOnFirstNotification === true && !firstNotificationThrown) {
              firstNotificationThrown = true;
              throw new Error("normalizer consumer failed");
            }
            notifications.push({ method, params });
          },
        }
      : {}),
  });
  return {
    server,
    manager,
    diagnostics,
    driverDiagnostics,
    notifications,
    meteredUsage,
    subagentLifecycle,
    scheduler,
  };
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
    // The stdio default: the prelude script, its `$0` label, and the single
    // positional word naming the subcommand. `"$@"` carries the transport argv
    // (T3.15 leg 6) as positional parameters the shell never re-parses.
    expect(spawnRequest?.args).toEqual([
      "-c",
      CODEX_APP_SERVER_SHELL_PRELUDE,
      CODEX_APP_SERVER_SHELL_ARGV0,
      "app-server",
    ]);
    expect(spawnRequest?.cwd).toBe(SESSION_CWD);
  });

  it("pins the prelude string that the measured PTY behaviour requires", () => {
    // Canonical mode caps one input line at 1024 bytes on Darwin and silently
    // discards anything longer, so `-icanon` is what makes this protocol
    // deliverable at all; `-echo` stops the reader seeing its own frames; `&&`
    // makes a failed `stty` abort the launch instead of degrading into silent
    // truncation; `exec` leaves no shell between PtyHost and the provider.
    // `"$@"` rather than a literal `app-server`: the subcommand and every
    // transport flag reach the provider as POSITIONAL parameters, so a
    // daemon-configured socket path or credential-file path cannot be
    // re-parsed by the shell (T3.15 leg 6).
    expect(CODEX_APP_SERVER_SHELL_PRELUDE).toBe(
      `stty -icanon -echo && printf '%s\\n' ${CODEX_APP_SERVER_READY_SENTINEL} && exec "$${CODEX_APP_SERVER_BIN_ENV_VAR}" "$@"`,
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
    // The typed refusal above admits the P3-3 classification, which asks this
    // connection one question before the release under test happens.
    server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
    const scheduler = makeManualScheduler();
    const driver = new CodexDriver({
      ptyHost: server,
      diagnostics: makeSilentDriverDiagnostics(),
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

    // `attestation/generate` rather than an approval method: the approval and
    // callback-tool asks are ROUTED since T3.15 leg 3 and answer with their own
    // refusal shapes. This one is censused and deliberately unrouted — the
    // driver declines attestation at negotiation — so it still witnesses the
    // fail-closed default arm on a method the pinned census knows.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      id: 77,
      method: "attestation/generate",
      params: {},
    });
    await Promise.resolve();

    const replies = harness.server.writtenFrames().filter((frame) => frame["id"] === 77);
    expect(replies).toHaveLength(1);
    // An error reply can never be mistaken for approval, and it stops the
    // provider from hanging on an unanswered request.
    expect(replies[0]?.["error"]).toMatchObject({ code: -32601 });
    expect(harness.diagnostics).toContainEqual({
      kind: "unhandled-server-request",
      method: "attestation/generate",
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
      method: "attestation/generate",
      params: {},
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

    // A CENSUSED, thread-scoped method carrying the session's own thread id, so
    // it routes to `project` and reaches the hand-off — the seam this asserts.
    // A frame the router refused would never get there, and would be recorded
    // as a quarantine instead (asserted separately below).
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: THREAD_ID },
    });
    await Promise.resolve();

    expect(harness.diagnostics).toContainEqual({
      kind: "unconsumed-server-notification",
      method: "thread/queue/changed",
    });
  });

  it("quarantines a method the routing census does not classify instead of projecting it", async () => {
    const harness = createHarness();
    await createdSession(harness);

    // The census fixture states its own completeness limit: 35 named methods
    // out of a wider generated union. An unlisted method therefore reaches the
    // classifier's `unknown` arm, and the fail-closed rule refuses it rather
    // than presuming it belongs to the session's own thread.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/itemAdded",
      params: { threadId: THREAD_ID },
    });
    await Promise.resolve();

    // Refused, not delivered: no hand-off happened, so no unconsumed record.
    expect(harness.diagnostics).not.toContainEqual({
      kind: "unconsumed-server-notification",
      method: "thread/itemAdded",
    });
    // And never a silent drop — the refusal is on the driver diagnostic band.
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("thread_frame_quarantined").map((record) => ({
        kind: record.kind,
        rawWireType: record.rawWireType,
      })),
    ).toContainEqual({ kind: "thread_frame_quarantined", rawWireType: "thread/itemAdded" });
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
      diagnostics: makeSilentDriverDiagnostics(),
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
// Zero-turn auth probe (P0-5) — `getAuthStatus` over a dedicated connection
// --------------------------------------------------------------------------

describe("CodexLifecycleManager probeAuth (T3.14 P0-5)", () => {
  function probingHarness(answer: JsonRpcAnswer | undefined): ManagerHarness {
    const harness = createManagerHarness();
    if (answer !== undefined) {
      harness.server.on("getAuthStatus", () => answer);
    }
    return harness;
  }

  it("never asks the provider to refresh, and never asks for the token", async () => {
    const harness = probingHarness({ result: { authMethod: "chatgpt", authToken: null } });

    await harness.manager.probeAuth();

    // `refreshToken: false` is the load-bearing half: the pinned providers rotate
    // refresh tokens single-use with no grace window, so a probe that refreshed
    // would END the login it was checking rather than observe it. Both members
    // are asserted PRESENT, not merely falsy — `GetAuthStatusParams` types them
    // required-but-nullable, so omitting either leaves the behaviour to the
    // provider's default.
    expect(harness.server.framesForMethod("getAuthStatus")[0]?.["params"]).toEqual({
      includeToken: false,
      refreshToken: false,
    });
  });

  it("reports authenticated and names the auth method, never the token", async () => {
    const harness = probingHarness({
      result: {
        authMethod: "chatgpt",
        authToken: "sk-should-never-be-read",
        requiresOpenaiAuth: true,
      },
    });

    const result = await harness.manager.probeAuth();

    expect(result.status).toBe("authenticated");
    expect(result.detail).toContain("chatgpt");
    // `authMethod` is a closed mechanism enum and safe as diagnostics; the token
    // is credential material this driver must never echo, anywhere.
    expect(JSON.stringify(result)).not.toContain("sk-should-never-be-read");
  });

  it("reports unauthenticated when no auth method is resolved", async () => {
    const harness = probingHarness({
      result: { authMethod: null, authToken: null, requiresOpenaiAuth: true },
    });

    await expect(harness.manager.probeAuth()).resolves.toMatchObject({
      status: "unauthenticated",
    });
  });

  it("still refuses, but says so differently, when the provider needs no OpenAI sign-in", async () => {
    const harness = probingHarness({
      result: { authMethod: null, authToken: null, requiresOpenaiAuth: false },
    });

    const result = await harness.manager.probeAuth();

    // Conservative on the admission axis, precise on the diagnostic one: "no
    // OpenAI credential is needed" is not evidence the credential this
    // configuration DOES need is present.
    expect(result.status).toBe("unauthenticated");
    expect(result.detail).toContain("requires no OpenAI sign-in");
  });

  it("reports indeterminate — not unauthenticated — when the probe surface refuses", async () => {
    const harness = probingHarness({
      error: { code: -32601, message: "Method not found" },
    });

    const result = await harness.manager.probeAuth();

    // Probe health and credential state are different facts with different
    // operator actions. Claiming `unauthenticated` here would send an operator to
    // re-authenticate a credential that was never in question.
    expect(result.status).toBe("indeterminate");
  });

  it("reports indeterminate when the answer is unreadable", async () => {
    const harness = probingHarness({ result: { authMethod: 17 } });

    await expect(harness.manager.probeAuth()).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("returns indeterminate rather than throwing when the spawn itself fails", async () => {
    const harness = probingHarness(undefined);
    harness.server.spawnResponse = {
      kind: "spawn_response",
      session_id: "",
      error: "no such file",
    };

    // Total by contract: a throw would hand the admission leg a third channel it
    // has no rule for, and would collapse "the probe is unhealthy" into "the
    // transport is down".
    await expect(harness.manager.probeAuth()).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("spawns from the constructed resume environment and tears the child down", async () => {
    const harness = probingHarness({ result: { authMethod: "apikey" } });

    await harness.manager.probeAuth();

    // The probe is a spawn like any other on this manager: its environment is
    // CONSTRUCTED from `resumeSpawnConfig`, never inherited from the daemon.
    const spawn = harness.server.spawnRequests[0];
    expect(spawn?.cwd).toBe(RESUME_SPAWN_CONFIG.cwd);
    expect(spawn?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("claims no session slot, so a create for any session still succeeds after it", async () => {
    const harness = probingHarness({ result: { authMethod: "chatgpt" } });
    harness.server.uniqueSpawnSessionIds = true;

    await harness.manager.probeAuth();

    // A probe that installed a record or held a transition would have made the
    // cheap admission check the most expensive thing in the lifecycle.
    await expect(
      harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG }),
    ).resolves.toMatchObject({ resumeHandle: THREAD_ID });
  });

  it("starts no thread — the probe is zero-turn, not a discardable session", async () => {
    const harness = probingHarness({ result: { authMethod: "chatgpt" } });

    await harness.manager.probeAuth();

    expect(harness.server.framesForMethod("thread/start")).toEqual([]);
    expect(harness.server.framesForMethod("turn/start")).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Steer on the wire — P0-3's key ride-through and P3-1's acknowledgement grade
// --------------------------------------------------------------------------

describe("CodexDriver spawn-environment hygiene (T3.14 P0-4)", () => {
  // A variable that exists in the DAEMON's environment and in no supplied
  // config. Any appearance of it in a child environment means some path spread
  // `process.env`, which is the whole failure P0-4 forbids: the child
  // environment is CONSTRUCTED, never inherited. It is also the shape a deny
  // list depends on — a policy can only strip what the constructor put there, so
  // a driver that adds entries of its own would defeat the strip no matter how
  // the list is resolved.
  const DAEMON_CANARY_ENV_VAR = "AI_SIDEKICKS_T314_ENV_CANARY";

  beforeEach(() => {
    process.env[DAEMON_CANARY_ENV_VAR] = "must-not-reach-a-provider-child";
  });

  afterEach(() => {
    delete process.env[DAEMON_CANARY_ENV_VAR];
  });

  function spawnedEnvNames(request: SpawnRequest | undefined): string[] {
    return (request?.env ?? []).map(([name]) => name);
  }

  it("keeps the daemon's own environment out of a created session's child", async () => {
    const harness = createHarness();
    await createdSession(harness);

    expect(spawnedEnvNames(harness.server.spawnRequests[0])).not.toContain(DAEMON_CANARY_ENV_VAR);
  });

  it("keeps it out of a resume relaunch, which is a fresh spawn like any other", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    // Called out separately because a resume takes a DIFFERENT config object
    // (`resumeSpawnConfig`) down a different code path, so the create-path
    // assertion above does not cover it.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("keeps it out of the auth probe's child, which is the third spawn path", async () => {
    const harness = createManagerHarness();

    await harness.manager.probeAuth();

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });
});

describe("CodexDriver resume-failure taxonomy (T3.14 P3-3)", () => {
  const REFUSED_RESUME: JsonRpcAnswer = {
    error: { code: -32600, message: "thread not found" },
  };

  function refusingHarness(authAnswer: JsonRpcAnswer): Harness {
    const harness = createHarness();
    harness.server.on("thread/resume", () => REFUSED_RESUME);
    harness.server.on("getAuthStatus", () => authAnswer);
    return harness;
  }

  async function resume(harness: Harness): Promise<DriverResumeResult> {
    return await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
  }

  it("reports reauth-required when the refusing provider resolves no auth method", async () => {
    const harness = refusingHarness({ result: { authMethod: null, requiresOpenaiAuth: true } });

    // The two conditions name two DIFFERENT operator actions, so this is the
    // whole point of the leg: an expired credential must not be reported as
    // "reconcile this by hand".
    await expect(resume(harness)).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "reauth-required",
    });
  });

  it("reports recovery-needed when the refusing provider is still authenticated", async () => {
    const harness = refusingHarness({ result: { authMethod: "chatgpt", authToken: null } });

    await expect(resume(harness)).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
  });

  it("never spends a credential rotation to classify a failure", async () => {
    const harness = refusingHarness({ result: { authMethod: null } });

    await resume(harness);

    // Same pin as the admission probe, and load-bearing for the same reason:
    // the pinned providers rotate refresh tokens single-use with no grace
    // window, so classifying a failure by refreshing would END the login it was
    // asking about.
    expect(harness.server.framesForMethod("getAuthStatus")[0]?.["params"]).toEqual({
      includeToken: false,
      refreshToken: false,
    });
  });

  it("asks nothing when the failure was not a typed provider refusal", async () => {
    const harness = createHarness();
    // A well-formed reply carrying no turn history: the connection is alive and
    // WOULD answer, but the cause is a transport-level defect rather than a
    // refusal the provider issued, so it carries no proof the child is healthy.
    harness.server.on("thread/resume", () => ({
      result: { thread: { id: THREAD_ID, sessionId: "session-tree-1" } },
    }));
    harness.server.on("getAuthStatus", () => ({ result: { authMethod: null } }));

    const result = await resume(harness);

    // The negative control that makes the gate real: this auth answer would
    // classify `reauth-required` if it were consulted at all.
    expect(harness.server.framesForMethod("getAuthStatus")).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
  });

  it("does not upgrade an unreadable auth answer into reauth-required", async () => {
    const harness = refusingHarness({ result: { authMethod: 17 } });

    // An unhealthy probe is evidence about the PROBE, never about the
    // credential, so `indeterminate` takes the conservative arm.
    await expect(resume(harness)).resolves.toMatchObject({
      recoveryCondition: "recovery-needed",
    });
  });

  it("keeps the classification from displacing the typed failure it rides on", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => REFUSED_RESUME);
    harness.server.on("getAuthStatus", () => ({
      error: { code: -32601, message: "no such method" },
    }));

    const result = await resume(harness);

    // A build that does not answer the question must still produce I-005-5's
    // typed result — with the resume's OWN cause on the detail, not the probe's.
    expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
    expect(result).not.toHaveProperty("bindingId");
    expect((result as { providerFailureDetail: string }).providerFailureDetail).toContain(
      "thread not found",
    );
  });

  it("classifies before releasing the connection, and still releases it", async () => {
    const harness = refusingHarness({ result: { authMethod: null } });

    await resume(harness);

    // Ordering, asserted by consequence: the question reached a live child, and
    // that child is not left running afterwards.
    expect(harness.server.framesForMethod("getAuthStatus")).toHaveLength(1);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

describe("CodexLifecycleManager steer wire shape (T3.14 P0-3, P3-1)", () => {
  const STEER_KEY = "9a1d8f30-0000-4000-8000-0000000000aa";

  /** A harness with one live session and one live turn, ready to be steered. */
  async function steerableHarness(steerAnswer: JsonRpcAnswer): Promise<Harness> {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => steerAnswer);
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });
    return harness;
  }

  function steerIntervention(expectedTurnId?: string): ApplyInterventionParams {
    return {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: STEER_KEY,
      payload: {
        content: "focus on the failing test",
        ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      },
    };
  }

  it("carries the requester's idempotency key on the wire as clientUserMessageId", async () => {
    const harness = await steerableHarness({ result: { turnId: TURN_ID } });

    await harness.driver.applyIntervention(steerIntervention(TURN_ID));

    // Verbatim, on the pinned `TurnSteerParams` member — the same carrier
    // `turn/start` uses. A key re-minted at the driver boundary would hand the
    // provider a fresh value on every retry and defeat the dedupe it exists for.
    expect(harness.server.framesForMethod("turn/steer")[0]?.["params"]).toMatchObject({
      threadId: THREAD_ID,
      expectedTurnId: TURN_ID,
      clientUserMessageId: STEER_KEY,
    });
  });

  it("pins the steer to the live turn when the caller named none", async () => {
    const harness = await steerableHarness({ result: { turnId: TURN_ID } });

    const result = await harness.driver.applyIntervention(steerIntervention());

    // The provider REQUIRES the precondition, so an absent caller expectation
    // becomes the live turn on the wire — and the acknowledgement is graded
    // against THAT, not against the caller's absent hint.
    expect(harness.server.framesForMethod("turn/steer")[0]?.["params"]).toMatchObject({
      expectedTurnId: TURN_ID,
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("reads the flat turnId acknowledgement, not turn/start's nested turn object", async () => {
    // `TurnSteerResponse` is `{ turnId }`; `TurnStartResponse` is `{ turn: { id } }`.
    // Reading the wrong one would return null for every successful steer and
    // degrade the entire happy path.
    const harness = await steerableHarness({ result: { turnId: TURN_ID } });

    await expect(harness.driver.applyIntervention(steerIntervention(TURN_ID))).resolves.toEqual({
      status: "applied",
    });
  });

  it("degrades when the provider acknowledges a different turn", async () => {
    const harness = await steerableHarness({ result: { turnId: "turn-99" } });

    await expect(harness.driver.applyIntervention(steerIntervention(TURN_ID))).resolves.toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
  });

  it("degrades rather than throwing when the acknowledgement names no turn", async () => {
    const harness = await steerableHarness({ result: {} });

    // The request WAS answered, so this is an acknowledgement carrying no
    // evidence — not an outage. Throwing would tell the orchestration layer a
    // live provider is unreachable.
    await expect(harness.driver.applyIntervention(steerIntervention(TURN_ID))).resolves.toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
  });

  it("sends no client-supplied identifier on the interrupt path", async () => {
    const harness = await steerableHarness({ result: { turnId: TURN_ID } });
    harness.server.on("turn/interrupt", () => ({ result: {} }));

    await harness.driver.applyIntervention({
      type: "interrupt",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: STEER_KEY,
      payload: {},
    });

    // `TurnInterruptParams` is `{ threadId, turnId }` at the pin. An invented
    // carrier here would be an unregistered wire field.
    const params = harness.server.framesForMethod("turn/interrupt")[0]?.["params"];
    expect(Object.keys(params as Record<string, unknown>).sort()).toEqual(["threadId", "turnId"]);
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
// Process exit — cleanup runs even when caller-supplied code throws
// --------------------------------------------------------------------------

describe("CodexAppServerConnection event-callback containment", () => {
  it("rejects every pending request even when the subscription disposer throws", async () => {
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: {} }));
    const scheduler = makeManualScheduler();
    const diagnostics: CodexTransportDiagnostic[] = [];
    const connection = new CodexAppServerConnection({
      ptyHost: server,
      subscribeToPtySession: (ptySessionId, listeners) => {
        const dispose = server.subscribe(ptySessionId, listeners);
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
    });
    await connection.open(RESUME_SPAWN_CONFIG);

    // Never answered: only the exit can settle it.
    const pending = connection.request("thread/start", {});
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    // The exit callback belongs to the HOST, so a fault in it escapes into the
    // host's emit loop rather than reaching any caller. Captured here so the
    // assertions describe the damage (callers left hanging) rather than just the
    // symptom -- and so an implementation that lets it escape fails on the very
    // next line instead of hanging to the 5000ms timeout.
    let escaped: unknown;
    try {
      server.emitExit(7);
    } catch (error) {
      escaped = error;
    }

    expect(escaped).toBeUndefined();
    expect(await settled).toBeInstanceOf(CodexTransportError);
    // Not swallowed: a disposer that failed may have left a listener registered
    // against a dead session, and the sink is the only surface that can say so.
    expect(diagnostics).toContainEqual({
      kind: "subscription-dispose-failed",
      detail: "subscription disposer failed",
    });
    // Ordered after the cleanup, so the exit record still lands first.
    expect(diagnostics[0]).toMatchObject({ kind: "process-exited", exitCode: 7 });
  });

  it("keeps draining a read chunk when the diagnostic sink throws", async () => {
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: {} }));
    const scheduler = makeManualScheduler();
    let sinkCalls = 0;
    const connection = new CodexAppServerConnection({
      ptyHost: server,
      subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
      reportDiagnostic: () => {
        sinkCalls += 1;
        throw new Error("diagnostic sink failed");
      },
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
    });
    await connection.open(RESUME_SPAWN_CONFIG);

    // Never auto-answered: no handler is registered for it, so the response
    // below is the only thing that can settle it.
    const pending = connection.request("thread/start", {});
    const settled = pending.then(
      (result) => result,
      (error: unknown) => error,
    );
    await drainMicrotasks();
    const requestId = server.framesForMethod("thread/start")[0]?.["id"];
    expect(requestId).toBeDefined();

    // ONE chunk, and the ORDER is the test: an unparsable line whose diagnostic
    // throws, then the response the caller is waiting on -- behind the throw, in
    // the same drain.
    const responseFrame = JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { ok: true } });
    let escaped: unknown;
    try {
      server.emitRaw(new TextEncoder().encode(`not-json\r\n${responseFrame}\r\n`));
    } catch (error) {
      escaped = error;
    }

    // Asserted FIRST, so an implementation that lets the fault unwind the drain
    // fails here rather than hanging on the settlement below.
    expect(escaped).toBeUndefined();
    expect(sinkCalls).toBe(1);
    expect(await settled).toEqual({ ok: true });
  });

  it("keeps draining a chunk when the sink throws on an unconsumed notification", async () => {
    const harness = createManagerHarness({ throwOnFirstDiagnostic: true });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    // No delegate is wired, so each notification produces a diagnostic through
    // the MANAGER's interposition -- which is called from inside the transport's
    // ingest loop, so a throw there unwinds the same drain.
    let escaped: unknown;
    try {
      harness.server.emitRaw(
        new TextEncoder().encode(
          `{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"${THREAD_ID}"}}\r\n` +
            `{"jsonrpc":"2.0","method":"turn/plan/updated","params":{"threadId":"${THREAD_ID}"}}\r\n`,
        ),
      );
    } catch (error) {
      escaped = error;
    }

    expect(escaped).toBeUndefined();
    // The first threw before it could be recorded, so the second IS the evidence
    // that the drain survived it.
    expect(harness.diagnostics).toEqual([
      { kind: "unconsumed-server-notification", method: "turn/plan/updated" },
    ]);
  });

  it("settles a response that arrives behind a notification whose consumer threw", async () => {
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: {} }));
    const scheduler = makeManualScheduler();
    const diagnostics: CodexTransportDiagnostic[] = [];
    const connection = new CodexAppServerConnection({
      ptyHost: server,
      subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
      reportDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      // Wired straight to the connection, with no manager interposed -- this
      // class is exported and driven standalone, so the containment has to hold
      // for that composition too.
      onServerNotification: () => {
        throw new Error("consumer exploded");
      },
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
    });
    await connection.open(RESUME_SPAWN_CONFIG);

    const pending = connection.request("thread/start", {});
    const settled = pending.then(
      (result) => result,
      (error: unknown) => error,
    );
    await drainMicrotasks();
    const requestId = server.framesForMethod("thread/start")[0]?.["id"];
    expect(requestId).toBeDefined();

    // The response sits BEHIND the notification in one chunk, so a consumer that
    // unwinds the drain takes the caller down with it.
    const responseFrame = JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { ok: true } });
    let escaped: unknown;
    try {
      server.emitRaw(
        new TextEncoder().encode(
          `{"jsonrpc":"2.0","method":"turn/started","params":{}}\r\n${responseFrame}\r\n`,
        ),
      );
    } catch (error) {
      escaped = error;
    }

    expect(escaped).toBeUndefined();
    expect(await settled).toEqual({ ok: true });
    // Dropped, not fatal -- and recorded, which is the whole difference between
    // this ruling and silence.
    expect(diagnostics).toEqual([
      {
        kind: "notification-consumer-failed",
        method: "turn/started",
        detail: "consumer exploded",
      },
    ]);
  });

  it("drops a notification whose consumer throws and keeps delivering the rest", async () => {
    const harness = createManagerHarness({
      onServerNotification: true,
      throwOnFirstNotification: true,
    });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    let escaped: unknown;
    try {
      harness.server.emitRaw(
        new TextEncoder().encode(
          `{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"${THREAD_ID}"}}\r\n` +
            `{"jsonrpc":"2.0","method":"turn/plan/updated","params":{"threadId":"${THREAD_ID}"}}\r\n`,
        ),
      );
    } catch (error) {
      escaped = error;
    }

    expect(escaped).toBeUndefined();
    // The loss is bounded to the ONE notification whose consumer threw: the next
    // frame in the same chunk still reaches the consumer.
    expect(harness.notifications.map((entry) => entry.method)).toEqual(["turn/plan/updated"]);
    // Attributed at the manager's own delegate call, so the record names the
    // consumer rather than the interposition that wraps it.
    expect(harness.diagnostics).toEqual([
      {
        kind: "notification-consumer-failed",
        method: "turn/started",
        detail: "normalizer consumer failed",
      },
    ]);
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
// Session slot across RE-ESTABLISHMENT — the other half of the entrance guard
// --------------------------------------------------------------------------

describe("CodexLifecycleManager session slot across re-establishment", () => {
  it("refuses a startRun while a resume holds the slot", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/resume", () => threadStartResult(1));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    // A resume publishes its claim SYNCHRONOUSLY while the predecessor record is
    // still installed, so the two calls in one tick are the whole window. A guard
    // that rejected only `closing` handed that predecessor straight out.
    const resuming = harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
    const starting = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const outcome = await starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await resuming;

    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("being re-established");
    // Nothing reached the wire. The point is not to refuse a turn after accepting
    // it, but never to start one on a connection about to be released.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("kills the connection when a turn is accepted after the session loses its slot", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    // The resume FAILS, which is the one displacing transition that does not
    // dispose the predecessor: its catch path releases only its own new
    // connection and leaves the old record installed and its process LIVE. That
    // is why the post-await branch disposes rather than resting on the argument
    // that whoever took the slot will kill the process anyway.
    harness.server.on("thread/resume", () => ({
      error: { code: -32000, message: "no such thread" },
    }));
    let resuming: Promise<unknown> | undefined;
    let releaseSpawns: (() => void) | undefined;
    harness.server.on("turn/start", () => {
      // Issued from INSIDE the write, so the slot is lost while `startRun` is
      // still suspended on this very answer -- after its entrance guard passed,
      // which is the only way to reach the post-await branch at all.
      releaseSpawns = harness.server.holdSpawns();
      resuming = harness.manager.resumeSession({
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      });
      return { result: { turn: { id: TURN_ID } } };
    });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    // Parks the resume inside its spawn so the answer lands while the transition
    // is still in flight; otherwise the resume could settle first and the slot
    // would read as live again, hiding the branch under test.
    await drainMicrotasks();
    releaseSpawns?.();
    const outcome = await starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    const resumeResult = await resuming;

    expect(resumeResult).toMatchObject({ status: "failed" });
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("stopped holding its slot");
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    // The turn was ACCEPTED and nothing else was going to stop it, so it would
    // have kept executing tools on a session the daemon would happily reuse.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
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

  // Totality, on the values that actually break coercion. Each of these was
  // confirmed to throw against the runtime before being pinned here -- they are
  // not hypotheses. The stake is I-005-5: this function is what `resumeSession`'s
  // catch path calls to BUILD the typed failure, so a throw here converts the
  // typed `recovery-needed` result back into an exception, on the path that is
  // already handling a failure and therefore least likely to hold a well-formed
  // cause.
  it("stays total for a null-prototype object, which cannot be stringified", () => {
    // `String(value)` throws TypeError: no `toString` or `valueOf` on the chain.
    expect(normalizeProviderFailureDetail(Object.create(null) as unknown)).toMatch(
      /no diagnostic message/,
    );
  });

  it("stays total for an Error whose message getter throws", () => {
    const hostile = new Error("unused");
    Object.defineProperty(hostile, "message", {
      get(): string {
        throw new TypeError("message getter exploded");
      },
    });

    expect(normalizeProviderFailureDetail(hostile)).toMatch(/no diagnostic message/);
  });

  it("falls back to the Error class when its message is not a string", () => {
    // Reading it succeeds; it is `replaceAll` that does not exist on a number.
    // So checking the TYPE is load-bearing, not just guarding the read.
    const numericMessage = Object.assign(new Error("unused"), { message: 42 });

    // `name` rather than the unspecified constant: an Error with no usable
    // message still has a class, and naming the class beats naming our own
    // inability to describe it. Reading two known strings off a known shape is
    // also a different act from serializing an unknown value -- see below.
    expect(normalizeProviderFailureDetail(numericMessage)).toBe("Error");
  });

  it("never serializes an arbitrary rejection value into the persisted detail", () => {
    // `providerFailureDetail` reaches a durable, operator-visible row, and
    // `String()` runs whatever `toString` the value carries -- which is how
    // spawn configuration, credential material included, would get there. The
    // constant is the DESIGNED output here, not merely the safe one.
    const hostile = {
      toString(): string {
        return "ANTHROPIC_API_KEY=sk-secret-value";
      },
    };

    const detail = normalizeProviderFailureDetail(hostile);

    expect(detail).not.toContain("sk-secret-value");
    expect(detail).toMatch(/no diagnostic message/);
  });
});

// --------------------------------------------------------------------------
// T3.15 — the R8 parity driver legs, Codex arm.
// --------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-005 §Interfaces And Contracts` — `rollbackTo` / `setSessionGoal` /
//     `clearSessionGoal` reach the pinned methods and answer the typed results;
//     a `rollbackTo` that applies reports the `bindingId` the daemon rebinds on.
//   `Spec-005 §Parity Capability Mechanism Grades` — the Codex cells this leg
//     realizes NATIVELY (`thread/fork`, `thread/goal/*`) versus the ones it
//     withholds (the callback-tool registry, subagent definitions).
//   `Spec-016 §Provider-Native Subagents` — the two caps the provider enforces
//     are supplied at every thread establishment; the definitions are withheld
//     and recorded rather than silently dropped.
//   CP-005-1 — a resumed or forked thread re-realizes every spawn-bound leg.

/** The params of the first frame the provider received for a method. */
function firstParamsFor(harness: Harness, method: string): Record<string, unknown> {
  return (harness.server.framesForMethod(method)[0]?.["params"] ?? {}) as Record<string, unknown>;
}

function readConfigOverrides(params: unknown): Record<string, unknown> {
  const config = (params as Record<string, unknown>)["config"];
  return (config ?? {}) as Record<string, unknown>;
}

const WORKSPACE_POSTURE_WITH_NETWORK: ExecutionPosture = {
  mode: "workspace-sandboxed",
  credentialPolicyRef: "policy://default",
  networkAccess: "full",
  writableRoots: ["/work/session"],
};

/**
 * A live session whose turn ledger is already populated.
 *
 * Seeded through `resumeSession` rather than by running turns: a resumed thread
 * carries its own history, which is the same axis a rewind indexes, and it gets
 * there without making these rollback assertions depend on the turn-dispatch
 * band.
 */
async function resumedSessionWithTurns(
  harness: Harness,
  turnCount: number,
  params: Partial<Parameters<CodexDriver["resumeSession"]>[0]> = {},
): Promise<void> {
  harness.server.on("thread/resume", () => threadStartResult(turnCount));
  await harness.driver.resumeSession({
    sessionId: SESSION_ID,
    resumeHandle: THREAD_ID,
    ...params,
  });
}

describe("CodexDriver rollbackTo (T3.15 leg 1, native `thread/fork`)", () => {
  it("reports the rebinding `bindingId` on the applied arm", async () => {
    const harness = createHarness();
    await resumedSessionWithTurns(harness, 2);
    harness.server.on("thread/fork", () => ({
      result: {
        thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
      },
    }));

    // The INPUT binding is deliberately NOT the minted one. Passing the same
    // string for both would let a driver that echoed the caller's `bindingId`
    // straight back — reporting the OLD binding for a rollback that just
    // repointed onto a new thread — pass this assertion.
    const result = await harness.driver.rollbackTo({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });

    // The daemon rebinds the run onto a NEW provider thread, so an applied
    // rollback reporting the predecessor's binding would leave the caller
    // pointing at a thread the fork replaced.
    expect(result).toStrictEqual({
      status: "applied",
      sessionPosition: 1,
      bindingId: "binding-abc",
    });
  });

  it("re-realizes posture and subagent caps on the fork (CP-005-1)", async () => {
    const harness = createHarness();
    await resumedSessionWithTurns(harness, 2, {
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
      subagentPolicy: { enabled: true, maxConcurrent: 3, maxDepth: 1, definitions: [] },
    });
    harness.server.on("thread/fork", () => ({
      result: {
        thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
        sandbox: { networkAccess: true },
      },
    }));

    await harness.driver.rollbackTo({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      position: 1,
    });

    const forkParams = firstParamsFor(harness, "thread/fork");
    expect(forkParams["sandbox"]).toBe("workspace-write");
    // A fork mints a NEW thread; omitting the overrides would leave the rewound
    // session governed by whatever that thread inherited.
    expect(readConfigOverrides(forkParams)).toStrictEqual({
      "sandbox_workspace_write.network_access": true,
      "agents.max_concurrent_threads_per_session": 3,
      "agents.max_depth": 1,
    });
  });

  it("refuses a position that names no recorded boundary rather than forking the whole thread", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const result = await harness.driver.rollbackTo({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      position: 0,
    });

    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-target-not-a-recorded-boundary",
    });
    // The refusal is LOCAL: a fork that omitted the boundary would rewind the
    // whole thread, which is the one outcome a rollback must never report.
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);
  });
});

describe("CodexDriver resumeSession re-realization (T3.15 legs 4-5, CP-005-1)", () => {
  it("re-sends posture and subagent caps on `thread/resume`", async () => {
    // A resume is a FRESH SPAWN. Omitting the overrides would leave the resumed
    // thread running under the provider's persisted config rather than the one
    // its caller declared.
    const harness = createHarness();
    await resumedSessionWithTurns(harness, 1, {
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
      subagentPolicy: { enabled: true, maxConcurrent: 2, maxDepth: 1, definitions: [] },
    });

    const resumeParams = firstParamsFor(harness, "thread/resume");
    expect(resumeParams["sandbox"]).toBe("workspace-write");
    expect(readConfigOverrides(resumeParams)).toStrictEqual({
      "sandbox_workspace_write.network_access": true,
      "agents.max_concurrent_threads_per_session": 2,
      "agents.max_depth": 1,
    });
  });
});

describe("CodexDriver session goals (T3.15 leg 2, native)", () => {
  it("sends only the daemon-owned objective on `thread/goal/set`", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/goal/set", () => ({ result: {} }));

    const result = await harness.driver.setSessionGoal({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      runId: RUN_ID,
      goalText: "land the parity legs",
    });

    expect(result).toStrictEqual({ status: "applied" });
    // `status` and `tokenBudget` are provider-side goal state this daemon does
    // not own; sending either would make the driver a second author of them.
    expect(firstParamsFor(harness, "thread/goal/set")).toStrictEqual({
      threadId: THREAD_ID,
      objective: "land the parity legs",
    });
  });

  it("answers `applied` for a clear on a thread that carried no goal", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/goal/clear", () => ({ result: { cleared: false } }));

    expect(
      await harness.driver.clearSessionGoal({
        sessionId: SESSION_ID,
        bindingId: "binding-abc",
        runId: RUN_ID,
      }),
    ).toStrictEqual({
      status: "applied",
    });
  });
});

describe("CodexDriver subagent caps (T3.15 leg 4)", () => {
  it("disables subagents on the DEPTH axis, never with a zero concurrency cap", async () => {
    // Verified against the pinned build: `agents.max_concurrent_threads_per_session: 0`
    // is refused `-32600`, so a zero cap would fail every session that tried to
    // disable subagents rather than disabling them.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      subagentPolicy: { enabled: false },
    });

    expect(readConfigOverrides(firstParamsFor(harness, "thread/start"))).toStrictEqual({
      "agents.max_concurrent_threads_per_session": 1,
      "agents.max_depth": 0,
    });
  });

  it("routes an enabled policy below the provider floor to the same disabled encoding", async () => {
    // Fail-closed rather than clamped UP: clamping would grant a subagent slot
    // to a caller who asked for none.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      subagentPolicy: { enabled: true, maxConcurrent: 0, maxDepth: 3, definitions: [] },
    });

    expect(readConfigOverrides(firstParamsFor(harness, "thread/start"))).toStrictEqual({
      "agents.max_concurrent_threads_per_session": 1,
      "agents.max_depth": 0,
    });
  });

  it("records every withheld subagent definition rather than dropping it", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      subagentPolicy: {
        enabled: true,
        maxConcurrent: 2,
        maxDepth: 1,
        definitions: [
          { name: "reviewer", description: "reviews the diff" },
          { name: "researcher", description: "researches the API" },
        ],
      },
    });

    const withheld = harness.driverDiagnostics.recentRecordsOfKind("subagent_definition_disabled");
    expect(withheld).toHaveLength(2);
    expect(withheld.map((record) => record.details["definitionName"])).toStrictEqual([
      "reviewer",
      "researcher",
    ]);
  });
});

describe("CodexDriver posture realization (T3.15 leg 5)", () => {
  it("records a divergence when the provider's readback narrows the requested axis", async () => {
    // The config table FAILS OPEN — an unrecognized key is accepted and ignored
    // — so a leg that silently stopped applying looks exactly like one that
    // applied a denial. The readback is the only place that is checkable.
    const harness = createHarness();
    harness.server.on("thread/start", () => ({
      result: {
        thread: { id: THREAD_ID, sessionId: "session-tree-1", turns: [] },
        sandbox: { networkAccess: false },
      },
    }));

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
    });

    const diverged = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "posture-realization-diverged",
    );
    expect(diverged).toHaveLength(1);
    expect(diverged[0]).toMatchObject({
      requestedNetworkAccess: true,
      realizedNetworkAccess: false,
    });
  });

  it("stays silent when the readback matches the request", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => ({
      result: {
        thread: { id: THREAD_ID, sessionId: "session-tree-1", turns: [] },
        sandbox: { networkAccess: true },
      },
    }));

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
    });

    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "posture-realization-diverged",
      ),
    ).toHaveLength(0);
  });

  it("reports no divergence on the arm that cannot express the axis at thread scope", () => {
    // `read-only` realizes network-denied whatever the request, so reporting it
    // would be reporting the design. The turn-level `sandboxPolicy` is that
    // arm's expression of the axis, and every run supplies it.
    expect(
      describeCodexPostureDivergence(
        {
          mode: "readonly-sandboxed",
          credentialPolicyRef: "policy://default",
          networkAccess: "full",
          writableRoots: [],
        },
        { networkAccess: false },
      ),
    ).toBeNull();
  });

  it("reports a realization WIDER than the request as well as a narrower one", () => {
    expect(
      describeCodexPostureDivergence(
        {
          mode: "workspace-sandboxed",
          credentialPolicyRef: "policy://default",
          networkAccess: "none",
          writableRoots: [],
        },
        { networkAccess: true },
      ),
    ).toStrictEqual({ requestedNetworkAccess: false, realizedNetworkAccess: true });
  });
});

describe("CodexDriver callback-tool withholding (T3.15 leg 3, Codex arm)", () => {
  it("withholds the registry and records it on BOTH diagnostic sinks", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      callbackTools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
    });

    // `dynamicTools` is experimental-generation-only at the pin and this driver
    // negotiates `experimentalApi: false`, so the registration is unreachable.
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "callback-tools-withheld"),
    ).toHaveLength(1);
    const censused = harness.driverDiagnostics.recentRecordsOfKind(
      "callback_tool_registry_withheld",
    );
    expect(censused).toHaveLength(1);
    expect(censused[0]?.details["reason"]).toBe("provider-registration-unavailable");
    // A counter row naming no session cannot answer "why did MY tools stop
    // appearing" on a daemon running more than one.
    expect(censused[0]?.details["sessionId"]).toBe(SESSION_ID);
  });
});

describe("Codex server-request routing census (T3.15 `driver_ask` reachability)", () => {
  it("routes the seven reachable ask methods and no others", () => {
    expect([...CODEX_ROUTED_SERVER_REQUEST_METHODS].sort()).toStrictEqual([
      "applyPatchApproval",
      "execCommandApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/call",
      "mcpServer/elicitation/request",
    ]);
  });

  it("leaves `item/tool/requestUserInput` unrouted and asserted gated instead", () => {
    // Asserted unreachable off the normalizer's own negotiation census rather
    // than given a handler that could never run at `experimentalApi: false`.
    expect(CODEX_ROUTED_SERVER_REQUEST_METHODS).not.toContain("item/tool/requestUserInput");
    expect(CODEX_NEGOTIATION_GATED_METHODS).toContain("item/tool/requestUserInput");
  });
});

describe("CodexDriver realtime suppression (T3.15 leg 7)", () => {
  it("opts out of every censused realtime method in the `initialize` frame it actually sends", async () => {
    // Read off the frame the provider RECEIVED, not off the exported constant:
    // asserting the constant against itself would pass with the negotiation leg
    // deleted.
    const harness = createHarness();
    await createdSession(harness);

    const capabilities = firstParamsFor(harness, "initialize")["capabilities"];
    const optOut = (capabilities as Record<string, unknown>)["optOutNotificationMethods"];
    expect(optOut).toStrictEqual([
      "thread/realtime/started",
      "thread/realtime/closed",
      "thread/realtime/error",
      "thread/realtime/itemAdded",
      "thread/realtime/sdp",
      "thread/realtime/outputAudio/delta",
      "thread/realtime/transcript/delta",
      "thread/realtime/transcript/done",
    ]);
  });
});

describe("CodexDriver transport construction (T3.15 leg 6)", () => {
  const websocketTransportConfig = {
    transport: "websocket" as const,
    endpoint: "wss://codex.internal/app-server",
    bearerTokenRef: "keyring://codex/app-server",
  };

  function buildDriverOptions(): ConstructorParameters<typeof CodexDriver>[0] {
    return {
      ptyHost: new FakeCodexAppServer(),
      diagnostics: makeSilentDriverDiagnostics(),
      subscribeToPtySession: () => () => undefined,
      reportDiagnostic: () => undefined,
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      newBindingId: () => "binding-abc",
      readCapabilities: () => makeCapabilities(true),
    };
  }

  it("refuses construction when a websocket transport has no bearer resolver", () => {
    // The refusal is at CONSTRUCTION, not at the first session: a registry that
    // accepted this would report a healthy driver for the whole interval before
    // a participant started a run.
    expect(
      () => new CodexDriver({ ...buildDriverOptions(), transportConfig: websocketTransportConfig }),
    ).toThrow(CodexDriverConfigError);
  });

  it("refuses construction when a websocket transport has no connector", () => {
    expect(
      () =>
        new CodexDriver({
          ...buildDriverOptions(),
          transportConfig: websocketTransportConfig,
          resolveBearerCredential: async (): Promise<CodexWebsocketBearerCredential> =>
            await Promise.resolve({
              mode: "capability-token",
              tokenFilePath: "/run/codex/ws.token",
            }),
        }),
    ).toThrow(CodexDriverConfigError);
  });

  it("defaults to stdio when no transport is configured", () => {
    const driver = new CodexDriver(buildDriverOptions());
    expect(driver.transportSelection.transport).toBe("stdio");
  });

  it("resolves the bearer ref at connection time, once per connection, never at construction", async () => {
    // REF-NOT-VALUE, and the half of it construction-refusal tests cannot
    // reach: the ref is carried as a locator and exchanged for a credential
    // when a connection is actually opened. A resolver called at construction
    // — or called once and cached — would pin one credential for the driver's
    // whole lifetime, so a rotation would be picked up by nothing and every
    // later connection would present a secret the issuer has already retired.
    const resolvedRefs: string[] = [];
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
    server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
    server.on("thread/start", () => threadStartResult());
    const connectedEndpoints: string[] = [];
    const driver = new CodexDriver({
      ...buildDriverOptions(),
      ptyHost: server,
      subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
      transportConfig: websocketTransportConfig,
      resolveBearerCredential: async (bearerTokenRef): Promise<CodexWebsocketBearerCredential> => {
        resolvedRefs.push(bearerTokenRef);
        return await Promise.resolve({
          mode: "capability-token",
          tokenFilePath: "/run/codex/ws.token",
        });
      },
      websocketConnector: {
        connect: async (request): Promise<void> => {
          connectedEndpoints.push(request.endpoint);
          await Promise.resolve();
        },
      },
    });

    // Constructed, not yet connected: nothing has asked the keyring anything.
    expect(resolvedRefs).toStrictEqual([]);

    await driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    expect(resolvedRefs).toStrictEqual([websocketTransportConfig.bearerTokenRef]);

    // A SECOND connection re-resolves rather than reusing the first answer.
    await driver.createSession({
      sessionId: "22222222-2222-4222-8222-222222222222" as SessionId,
      config: SESSION_CONFIG,
    });
    expect(resolvedRefs).toStrictEqual([
      websocketTransportConfig.bearerTokenRef,
      websocketTransportConfig.bearerTokenRef,
    ]);
    expect(connectedEndpoints).toStrictEqual([
      websocketTransportConfig.endpoint,
      websocketTransportConfig.endpoint,
    ]);
  });
});

// --------------------------------------------------------------------------
// T3.15 R3 — routed server requests reach the daemon, and every path answers.
// --------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-012 §Required Behavior` — every tool invocation and approval ask is
//     adjudicated. A responder that is absent, refuses, or throws all answer
//     the method's own REFUSAL shape: never `-32601` (a protocol error where a
//     decision was asked for), never an allow, and never silence.
//   `Spec-005 §Required Behavior` — an unrouted method+id frame still answers,
//     so no provider turn hangs on a method this pin never saw.

interface RoutedAskHarness {
  readonly harness: Harness;
  readonly askProvider: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
}

async function routedAskHarness(
  responder: CodexSessionServerRequestResponder | undefined,
): Promise<RoutedAskHarness> {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
  server.on("thread/start", () => threadStartResult());
  const scheduler = makeManualScheduler();
  const driverDiagnostics = makeSilentDriverDiagnostics();
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driver = new CodexDriver({
    ptyHost: server,
    diagnostics: driverDiagnostics,
    subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: RESUME_SPAWN_CONFIG,
    newBindingId: () => "binding-abc",
    readCapabilities: () => makeCapabilities(true),
    ...(responder === undefined ? {} : { answerServerRequest: responder }),
  });
  await driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
  const harness: Harness = { server, driver, diagnostics, driverDiagnostics, scheduler };

  let nextAskId = 9000;
  const askProvider = async (
    method: string,
    params: unknown = {},
  ): Promise<Record<string, unknown>> => {
    const askId = (nextAskId += 1);
    const before = server.writtenLines.length;
    server.onData(
      "pty-session-1",
      new TextEncoder().encode(
        `${JSON.stringify({ jsonrpc: "2.0", id: askId, method, params })}\r\n`,
      ),
    );
    await drainMicrotasks();
    for (const line of server.writtenLines.slice(before)) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame["id"] === askId) {
        return frame;
      }
    }
    throw new Error(`the driver never answered the ${method} ask`);
  };
  return { harness, askProvider };
}

describe("CodexAppServerConnection routed server requests (T3.15 R3)", () => {
  it("answers an allowed `item/tool/call` with the provider's own success shape", async () => {
    const { askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({
          decision: "allow",
          payload: { contentItems: [{ type: "inputText", text: "ok" }] },
        }),
    });

    const answer = await askProvider("item/tool/call", { toolName: "search", arguments: {} });

    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
  });

  it("answers a refused ask with the method's REFUSAL shape, never `-32601`", async () => {
    const { askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "refuse", reason: "policy denied" }),
    });

    const answer = await askProvider("item/commandExecution/requestApproval");

    // A `-32601` for an approval would be a protocol error where a DECISION was
    // asked for; the provider must read a refusal it understands, in that
    // method's OWN vocabulary.
    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({ decision: "decline" });
  });

  it("refuses each approval spelling in that method's own vocabulary", async () => {
    // The refusal shapes are read from the pinned generation's response types,
    // and they genuinely differ: a single shape reused across methods would be
    // a protocol violation on whichever ones it did not fit.
    const { askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "refuse", reason: "policy denied" }),
    });

    expect((await askProvider("execCommandApproval"))["result"]).toStrictEqual({
      decision: { denied: { rejection: "policy denied" } },
    });
    expect((await askProvider("item/permissions/requestApproval"))["result"]).toStrictEqual({
      permissions: {},
      scope: "turn",
    });
    expect((await askProvider("mcpServer/elicitation/request"))["result"]).toStrictEqual({
      action: "decline",
    });
  });

  it("refuses when NO responder is registered rather than leaving the ask unanswered", async () => {
    const { harness, askProvider } = await routedAskHarness(undefined);

    const answer = await askProvider("item/tool/call");

    expect((answer["result"] as Record<string, unknown>)["success"]).toBe(false);
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "unrouted-server-request-refused",
      ),
    ).toHaveLength(1);
  });

  it("treats a THROWING responder as undecided, which is a refusal", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> => {
        await Promise.resolve();
        throw new Error("the approval pipeline is down");
      },
    });

    const answer = await askProvider("item/fileChange/requestApproval");

    // Never an allow, and never an unanswered frame.
    expect(answer["result"]).toStrictEqual({ decision: "decline" });
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "server-request-responder-failed",
      ),
    ).toHaveLength(1);
  });

  it("answers the legacy approval spelling the same way as the modern one", async () => {
    // Routing the modern trio while leaving the legacy pair on `-32601` would
    // make the daemon's answer depend on which spelling the provider chose for
    // the same question.
    const { askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "allow" }),
    });

    const legacy = await askProvider("execCommandApproval");
    const modern = await askProvider("item/commandExecution/requestApproval");

    expect(legacy["error"]).toBeUndefined();
    expect(modern["error"]).toBeUndefined();
  });

  it("still answers `-32601` for a method the routing table does not name", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "allow" }),
    });

    const answer = await askProvider("attestation/generate");

    // Declined at negotiation, so `-32601` is the honest answer rather than a
    // gap — and it is still an ANSWER, so the turn does not hang.
    expect((answer["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "unhandled-server-request"),
    ).toHaveLength(1);
  });
});

describe("composeCodexTransportArgv (T3.15 leg 6, the authenticated listener)", () => {
  it("starts a websocket listener WITH bearer auth on every credential mode", () => {
    const selection: CodexTransportSelection = {
      transport: "websocket",
      endpoint: "ws://127.0.0.1:8451",
      // A REF to the credential, never the credential. It is resolved at
      // connection time, so nothing here holds a secret value.
      bearerTokenRef: "keyring://codex/ws",
    };

    expect(
      composeCodexTransportArgv(selection, {
        mode: "capability-token",
        tokenFilePath: "/run/codex/ws.token",
      }),
    ).toStrictEqual([
      "app-server",
      "--listen",
      "ws://127.0.0.1:8451",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/run/codex/ws.token",
    ]);
    expect(
      composeCodexTransportArgv(selection, {
        mode: "capability-token-digest",
        tokenSha256: "a".repeat(64),
      }),
    ).toStrictEqual([
      "app-server",
      "--listen",
      "ws://127.0.0.1:8451",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      "a".repeat(64),
    ]);
  });

  it("refuses to compose an UNAUTHENTICATED websocket listener", () => {
    // The whole point of the leg: a listener started without auth is reachable
    // by anything that can open a socket to it.
    expect(() =>
      composeCodexTransportArgv(
        {
          transport: "websocket",
          endpoint: "ws://127.0.0.1:8451",
          bearerTokenRef: "keyring://codex/ws",
        },
        null,
      ),
    ).toThrow(CodexDriverConfigError);
  });

  it("bridges the unix arm through the provider's own proxy, needing no credential", () => {
    expect(
      composeCodexTransportArgv(
        { transport: "unix-socket", socketPath: "/run/codex/app-server.sock" },
        null,
      ),
    ).toStrictEqual(["app-server", "proxy", "--sock", "/run/codex/app-server.sock"]);
  });

  it("leaves the stdio default implicit rather than naming a flag spelling", () => {
    expect(composeCodexTransportArgv({ transport: "stdio" }, null)).toStrictEqual(["app-server"]);
  });
});

describe("resolveCodexTransportSelection (T3.15 leg 6)", () => {
  it("normalizes a `unix://` endpoint off the scheme the provider prints", () => {
    expect(
      resolveCodexTransportSelection({
        transport: "unix-socket",
        endpoint: "unix:///run/codex/app-server.sock",
      }),
    ).toStrictEqual({ transport: "unix-socket", socketPath: "/run/codex/app-server.sock" });
  });

  it("carries a websocket endpoint VERBATIM rather than rewriting it", () => {
    // Its host and port are the provider's to parse; a driver that rewrote them
    // could reach an address the operator did not name.
    expect(
      resolveCodexTransportSelection({
        transport: "websocket",
        endpoint: "ws://127.0.0.1:8451/app",
        bearerTokenRef: "keyring://codex/ws",
      }),
    ).toStrictEqual({
      transport: "websocket",
      endpoint: "ws://127.0.0.1:8451/app",
      // Carried as a REF, never resolved here: the credential is read at
      // connection time so a rotated one is picked up by the next connection
      // rather than pinned for the driver's lifetime.
      bearerTokenRef: "keyring://codex/ws",
    });
  });

  it("defaults an absent config to stdio", () => {
    expect(resolveCodexTransportSelection(undefined)).toStrictEqual({ transport: "stdio" });
  });
});

// ---------------------------------------------------------------------------
// T3.11 — the routing / metering band, driven through the REAL ingest path.
// ---------------------------------------------------------------------------
//
// These drive raw JSON-RPC notifications into the fake provider's byte channel
// and assert on what came out the other end of the manager. Nothing here calls
// the router or the accountant directly: their unit suites already do that, and
// what is unproven without this file is that the driver actually CONSULTS them.

describe("CodexLifecycleManager thread routing and usage metering (T3.11, I-005-11, I-005-12)", () => {
  const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000001";

  async function managerWithSession(
    options: ManagerHarnessOptions = { onServerNotification: true },
  ): Promise<ManagerHarness> {
    const harness = createManagerHarness(options);
    // A fresh harness carries a fresh accountant whose base registers start at
    // zero, so the fixture's own running totals must restart with it — a ledger
    // carried across tests would derive a `last` from the PREVIOUS test's
    // cumulative and make this fixture order-dependent.
    emittedCumulativeByThreadId.clear();
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    return harness;
  }

  // Per-thread running totals, so the fixture's `last` is the arithmetic
  // per-turn figure a real provider would send rather than an invented one that
  // would trip the accountant's cross-check on every frame.
  const emittedCumulativeByThreadId = new Map<string, number>();

  /**
   * Emit one token-usage notification at the FULL pinned payload shape.
   *
   * Every member of the generated `TokenUsageBreakdown` is populated, on both
   * the required `total` and the required `last`. A fixture that populates only
   * the one axis the reader happens to spell correctly cannot distinguish a
   * correct axis map from a broken one — which is exactly how an invented
   * container member survived four green metering tests.
   */
  function emitUsage(
    harness: ManagerHarness,
    threadId: string,
    totalInputTokens: number,
    turnId = TURN_ID,
  ): void {
    const priorCumulative = emittedCumulativeByThreadId.get(threadId) ?? 0;
    emittedCumulativeByThreadId.set(threadId, totalInputTokens);
    const perTurn = totalInputTokens - priorCumulative;
    const breakdown = (value: number): Record<string, number> => ({
      totalTokens: value,
      inputTokens: value,
      cachedInputTokens: value,
      cacheWriteInputTokens: value,
      outputTokens: value,
      reasoningOutputTokens: value,
    });
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        // The container member is `tokenUsage`, per the generated
        // `ThreadTokenUsageUpdatedNotification` the spec's References entry
        // records. Spelled the pinned way on purpose: a fixture that invents a
        // member name tests the reader against a wire that does not exist.
        tokenUsage: { total: breakdown(totalInputTokens), last: breakdown(perTurn) },
      },
    });
  }

  function announceChild(harness: ManagerHarness, threadSourceKind: string): void {
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: {
          id: CHILD_THREAD_ID,
          parentThreadId: THREAD_ID,
          threadSourceKind,
        },
      },
    });
  }

  it("(a) a frame naming a FOREIGN thread never reaches the normalize band", async () => {
    const harness = await managerWithSession();

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: "some-other-session-thread" },
    });
    await Promise.resolve();

    // Held, not projected: an unannounced identity could still be a child
    // racing its announcement, so it waits rather than being guessed into the
    // parent's timeline — but either way it does NOT project.
    expect(harness.notifications).toStrictEqual([]);
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(1);
  });

  it("(b) a usage frame meters a per-turn DELTA, and the cumulative counter never reaches the band as one", async () => {
    const harness = await managerWithSession();

    emitUsage(harness, THREAD_ID, 100);
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();

    // The wire reported 100 then 150 — a running total. What the daemon must
    // meter is 100 then 50; forwarding 150 as a turn figure is exactly the
    // double-charge I-005-11 exists to forbid.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
    expect(harness.meteredUsage.map((entry) => entry.sessionId)).toEqual([SESSION_ID, SESSION_ID]);
    expect(harness.meteredUsage[0]?.delta.attributedTurnId).toBe(TURN_ID);

    // EVERY axis of the pinned breakdown meters, not just the one an earlier
    // fixture happened to populate. Asserted by name: the accountant filters
    // readings against a closed axis union before any register write, so an
    // axis the reader spells differently from that union is silently scoped out
    // of the delta rather than rejected loudly at the wire.
    expect(Object.keys(harness.meteredUsage[1]?.delta.axisDeltas ?? {}).sort()).toEqual([
      "cacheWriteInput",
      "cachedInput",
      "input",
      "output",
      "reasoningOutput",
      "total",
    ]);
    // And the wire's own declared per-turn figure agrees with the derived
    // interval on every one of them, so the cross-check stays silent.
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toEqual([]);
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_axis_reading_rejected")).toEqual(
      [],
    );
  });

  it("records a usage frame it cannot read rather than dropping the spend silently", async () => {
    const harness = await managerWithSession();

    // The reserved usage method, arriving with a breakdown the pinned container
    // member does not hold. Unmetered spend that says nothing is
    // indistinguishable from a session that cost nothing, so the ONLY
    // acceptable outcome is a recorded rejection.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        usage: { total: { inputTokens: 100 } },
      },
    });
    await Promise.resolve();

    expect(harness.meteredUsage).toHaveLength(0);
    const rejections = harness.driverDiagnostics.recentRecordsOfKind("usage_axis_reading_rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.rawWireType).toBe("thread/tokenUsage/updated");
  });

  it("(c) a child announcement then a child frame routes to the carve-outs, never to the parent's transcript", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    await Promise.resolve();
    // The announcement itself is the session's own `thread/started`? No — it
    // names the CHILD's identity, so it routes as the child's first frame and
    // is suppressed. What survives is the lifecycle pair.
    expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
      "subagent.started",
    ]);

    // The child's CONTENT is suppressed...
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: CHILD_THREAD_ID },
    });
    // ...while the child's SPEND still carves through, under the child's own
    // attribution rather than the parent's.
    emitUsage(harness, CHILD_THREAD_ID, 40);
    await Promise.resolve();

    expect(harness.notifications).toStrictEqual([]);
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.threadId).toBe(CHILD_THREAD_ID);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(40);
  });

  it("a provider-INTERNAL child (compaction) carves its spend to the parent run rather than to a subagent", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "compaction");
    emitUsage(harness, CHILD_THREAD_ID, 25);
    await Promise.resolve();

    // No subagent pair: nothing user-facing spawned, so nothing user-facing
    // should appear on the timeline. The spend is still charged.
    expect(harness.subagentLifecycle).toStrictEqual([]);
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(25);
  });

  it("(d) the session's OWN terminal projects through to the normalize band", async () => {
    const harness = await managerWithSession();

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", items: [] } },
    });
    await Promise.resolve();

    expect(harness.notifications.map((entry) => entry.method)).toEqual(["turn/completed"]);
  });

  it("the eleventh I-005-12 case: a fully suppressed child still leaves its started/completed pair", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgentReview");
    // Every content frame the child produces is suppressed...
    for (const childFrameMethod of ["thread/queue/changed", "thread/goal/updated"]) {
      harness.server.emitFrame({
        jsonrpc: "2.0",
        method: childFrameMethod,
        params: { threadId: CHILD_THREAD_ID },
      });
    }
    // ...including its own terminal.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: CHILD_THREAD_ID, turn: { id: "child-turn", status: "completed" } },
    });
    await Promise.resolve();

    // Nothing of the child's content reached the parent's timeline...
    expect(harness.notifications).toStrictEqual([]);
    // ...and yet the child is not invisible: the pair is its whole presence,
    // which is what makes the suppression a scoping rule rather than a loss.
    expect(
      harness.subagentLifecycle.map((entry) => ({
        eventType: entry.emission.eventType,
        subagentId: entry.emission.subagentId,
      })),
    ).toEqual([
      { eventType: "subagent.started", subagentId: CHILD_THREAD_ID },
      { eventType: "subagent.completed", subagentId: CHILD_THREAD_ID },
    ]);
    // The child's registers are released with it: a post-terminal frame is no
    // longer a registered child's frame.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(CHILD_THREAD_ID)).toBe(false);
  });

  it("an IN-PROGRESS turn for a child is not its terminal — the pair stays open", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: CHILD_THREAD_ID, turn: { id: "child-turn", status: "inProgress" } },
    });
    await Promise.resolve();

    expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
      "subagent.started",
    ]);
  });

  it("a resume with no prior-emitted sum records the overstatement rather than hiding it", async () => {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/resume", () => threadStartResult(1));
    await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    // The driver cannot rebuild the sum — it lives in the canonical event
    // record. Silently basing at zero would re-meter the whole pre-resume
    // total onto the first post-resume turn with nothing to say it happened.
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable"),
    ).toHaveLength(1);
  });

  it("a resume WITH a prior-emitted sum meters only the excess over it", async () => {
    const harness = createManagerHarness({
      onServerNotification: true,
      readPriorEmittedUsage: () => ({ input: 500 }),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));
    await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    emitUsage(harness, THREAD_ID, 520);
    await Promise.resolve();

    expect(
      harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable"),
    ).toHaveLength(0);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
  });

  it("closing a session releases its router and accountant rather than leaking them per session", async () => {
    const harness = await managerWithSession();
    emitUsage(harness, THREAD_ID, 10);
    await Promise.resolve();
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(true);

    await harness.manager.closeSession({ sessionId: SESSION_ID });

    // Get-or-create, so the accessor answers with a FRESH pair; the assertion
    // is that the old one did not survive, which the empty thread proves.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(false);
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
  });
});
