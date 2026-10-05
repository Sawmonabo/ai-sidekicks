// Shared fakes for the Codex driver tests: a scripted app-server behind a fake `PtyHost`, a
// manual scheduler, and the driver and manager harnesses built on them.

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type RunId,
} from "@ai-sidekicks/contracts/provider/driver/driver";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import {
  DriverDiagnosticsEmitter,
  type DriverDiagnosticRecord,
} from "../../../driver-diagnostics.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import {
  makeManualScheduler,
  type ManualScheduler,
} from "../../../__fixtures__/manual-scheduler.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import type { SubagentLifecycleEmission } from "../../../thread-frame-router.js";
import type { RunOutputSpeedSettledListener } from "../../../declared-output-speed.js";
import type { CumulativeAxisReadings, MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import { hostEnvNameMatchForPlatform } from "../../../spawn-env.js";
import {
  CodexDriver,
  CodexLifecycleManager,
  CODEX_APP_SERVER_READY_SENTINEL,
  type CodexSessionServerRequestResponder,
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexCredentialEnvPolicyResolver,
  type CodexSessionConfig,
  type CodexTransportDiagnostic,
  type CodexModelCatalogExchange,
} from "../index.js";
import type { PtySignal, SpawnRequest, SpawnResponse } from "../../../../pty/pty-host-protocol.js";
import type { PtyHost, DrainResult } from "../../../../pty/pty-host.js";

export interface JsonRpcAnswer {
  result?: unknown;
  // `data` is optional on the wire; it carries the provider's structured refusal detail.
  error?: { code: number; message: string; data?: unknown };
  /**
   * Frames emitted in the same read chunk as this answer, after it. One `onData` call carrying a
   * response and a later notification makes the driver's response continuation (a microtask) run
   * after the notification was processed; separate emissions would hide that interleave.
   */
  trailingFrames?: Array<Record<string, unknown>>;
}

type MethodHandler = (params: unknown) => JsonRpcAnswer;

/**
 * A `PtyHost` whose "child process" is a scripted Codex `app-server`.
 *
 * Emits the prelude's readiness sentinel on subscribe (as the real prelude does before `exec`),
 * records every written line verbatim, and answers registered methods on a microtask so promise
 * ordering stays deterministic without timers.
 */
export class FakeCodexAppServer implements PtyHost {
  readonly spawnRequests: SpawnRequest[] = [];
  readonly writtenLines: string[] = [];
  readonly closedSessions: string[] = [];
  readonly killedSessions: Array<{ sessionId: string; signal: PtySignal }> = [];

  spawnResponse: SpawnResponse = { kind: "spawn_response", session_id: "pty-session-1" };
  /**
   * Gives every spawn its own pty session id. Needed whenever more than one connection is live:
   * the listener registry is keyed by pty session id, so shared ids let a later subscribe
   * displace an earlier connection's reader and make "which process was closed" unanswerable.
   */
  uniqueSpawnSessionIds = false;
  emitSentinelOnSubscribe = true;
  /**
   * Kills the child during the next write, then fails that write. The exit rejects the request's
   * inner promise while its caller is suspended, and the failed write makes `request()` rethrow
   * without ever returning that promise, so nothing can attach to it. The two steps run on
   * separate macrotasks so a full microtask drain (when Node decides a rejection is unhandled)
   * happens between the rejection and any possible handler.
   */
  failWriteAfterChildExit = false;
  /** Parks the next write on a macrotask, leaving its caller suspended. */
  parkNextWrite = false;
  /**
   * Rejects the next write without killing the child. Unlike `failWriteAfterChildExit` there is
   * no exit to record it, so this covers a write failure on a connection nothing else reports on.
   */
  rejectNextWriteWith: Error | undefined = undefined;

  readonly #listeners = new Map<string, CodexPtySessionListeners>();
  readonly #handlers = new Map<string, MethodHandler>();
  readonly #heldMethods = new Set<string>();
  readonly #heldEmissions = new Map<string, () => void>();
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
   * Suspends one method's answer until the returned release is called.
   *
   * The handler still runs at write time, so the frame is recorded and handler side effects
   * happen when they otherwise would; only the emission is held. That leaves a request in flight
   * across another lifecycle transition, which `parkNextWrite` cannot (it never records the
   * frame) and a handler cannot (it runs synchronously inside `write`).
   *
   * The release emits in its own tick, not on a microtask, so a test can place a response inside
   * a synchronous block of driver code reached through a sink the driver calls from within it.
   */
  holdAnswers(method: string): () => void {
    this.#heldMethods.add(method);
    return () => {
      this.#heldMethods.delete(method);
      const emit = this.#heldEmissions.get(method);
      this.#heldEmissions.delete(method);
      emit?.();
    };
  }

  /**
   * Suspends every spawn until the returned release is called, so a test can hold two
   * establishments inside their first suspension, the only window where a slot race shows.
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
    if (this.rejectNextWriteWith !== undefined) {
      const rejection = this.rejectNextWriteWith;
      this.rejectNextWriteWith = undefined;
      return Promise.reject(rejection);
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
   * Suspends every `close` until the returned release is called, after the session id is
   * recorded. A test can then see that teardown reached the host and hold it there, the only
   * window in which a slot freed mid-teardown is observable. Gating the `thread/unsubscribe`
   * answer instead would prove nothing, because the driver suspends there either way.
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
    const emit = (): void => {
      const frames: Array<Record<string, unknown>> = [
        {
          jsonrpc: "2.0",
          id,
          ...(answer.error === undefined ? { result: answer.result } : { error: answer.error }),
        },
        ...(answer.trailingFrames ?? []),
      ];
      // One chunk for the whole batch; see `JsonRpcAnswer.trailingFrames`.
      const payload = frames.map((frame) => `${JSON.stringify(frame)}\r\n`).join("");
      // Routed to the session that wrote the request, not broadcast: with several live
      // connections a broadcast could reach a peer whose id counter has the same value.
      this.#listeners.get(sessionId)?.onData(this.#encoder.encode(payload));
    };
    if (this.#heldMethods.has(method)) {
      this.#heldEmissions.set(method, emit);
      return;
    }
    queueMicrotask(emit);
  }
}

function makeCapabilities(steer: boolean): DriverCapabilities {
  const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, true])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  flags.steer = steer;
  return { flags, contractVersion: "1.0.0" };
}

/** The test session's model. */
export const TEST_MODEL = "gpt-5.5";
/** A live `model/list` read that answers an empty catalog, for tests that never list models. */
const STUB_MODEL_CATALOG_READ: CodexModelCatalogExchange = () =>
  Promise.resolve({ data: [], nextCursor: null });
export const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;
export const RUN_ID = "22222222-2222-4222-8222-222222222222" as RunId;
export const SECOND_RUN_ID = "33333333-3333-4333-8333-333333333333" as RunId;
export const THREAD_ID = "01a04202-0148-7ae2-8560-622babf33ed0";
export const TURN_ID = "turn-01";
// The second run's turn. Two runs holding live turns is a state the sole-active-run fallback
// cannot answer in and turn-keyed attribution resolves exactly.
export const SECOND_TURN_ID = "turn-02";
export const EXECUTABLE_PATH = "/opt/codex/bin/codex";

export const SESSION_CWD = "/work/session";

// Typed as the contract types it, an opaque bag, so the tests exercise the same untyped boundary
// the daemon hands the driver.
export const SESSION_CONFIG: Record<string, unknown> = {
  cwd: SESSION_CWD,
  env: [
    ["HOME", "/home/agent"],
    ["PATH", "/usr/bin"],
  ],
};

export const RESUME_SPAWN_CONFIG: CodexSessionConfig = {
  cwd: "/work/resume",
  env: [["HOME", "/home/agent"]],
};

/**
 * The daemon's stand-in policy resolver: a well-formed policy denying nothing. It is a real
 * policy, not `undefined`, because a sandboxed posture requires a resolution and the driver
 * refuses `undefined` as a wiring fault. Its `envNameMatch` is the host's because the shared
 * builder refuses a policy that declares a different one.
 */
const resolveNoDeniedCredentialNames: CodexCredentialEnvPolicyResolver = () =>
  Promise.resolve({
    denyEnvVars: [],
    envNameMatch: hostEnvNameMatchForPlatform(process.platform),
  });

export interface Harness {
  server: FakeCodexAppServer;
  driver: CodexDriver;
  diagnostics: CodexTransportDiagnostic[];
  driverDiagnostics: DriverDiagnosticsEmitter;
  textNeutralizationFailures: RecordedTextNeutralizationFailure[];
  scheduler: ManualScheduler;
}

/**
 * One run terminal a text-neutralization trip produced. The callback is a required dependency so
 * every harness binds it: the trip raises no JSON-RPC error, and an unbound sink would let a
 * swallowed turn end leave no record.
 */
interface RecordedTextNeutralizationFailure {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly providerFailureDetail: string;
}

export function createHarness(
  options: {
    steer?: boolean;
    subscribeToPtySession?: CodexPtySessionSubscriber;
    resumeSpawnConfig?: CodexSessionConfig;
    resolveCredentialEnvPolicy?: CodexCredentialEnvPolicyResolver;
    modelCatalogExchange?: CodexModelCatalogExchange;
    onRunOutputSpeedSettled?: RunOutputSpeedSettledListener | undefined;
  } = {},
): Harness {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  // Answered by default so the resume-failure auth classification resolves: these tests run on a
  // manual scheduler where its deadline never fires, and a logged-in provider is the realistic
  // baseline. Cases that need the logged-out reading re-register this method.
  server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driverDiagnostics = makeSilentDriverDiagnostics();
  const textNeutralizationFailures: RecordedTextNeutralizationFailure[] = [];
  const scheduler = makeManualScheduler();
  const driver = new CodexDriver({
    ptyHost: server,
    modelCatalogExchange: options.modelCatalogExchange ?? STUB_MODEL_CATALOG_READ,
    onTextNeutralizationFailure: (sessionId, runId, failure) => {
      textNeutralizationFailures.push({
        sessionId,
        runId,
        providerFailureDetail: failure.providerFailureDetail,
      });
    },
    diagnostics: driverDiagnostics,
    subscribeToPtySession:
      options.subscribeToPtySession ??
      ((ptySessionId, listeners) => server.subscribe(ptySessionId, listeners)),
    reportDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: options.resumeSpawnConfig ?? RESUME_SPAWN_CONFIG,
    resolveCredentialEnvPolicy:
      options.resolveCredentialEnvPolicy ?? resolveNoDeniedCredentialNames,
    newBindingId: () => "binding-abc",
    readCapabilities: () => makeCapabilities(options.steer ?? true),
    onRunOutputSpeedSettled: options.onRunOutputSpeedSettled,
  });
  return { server, driver, diagnostics, driverDiagnostics, textNeutralizationFailures, scheduler };
}

export function threadStartResult(turnCount = 0): JsonRpcAnswer {
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

export async function createdSession(harness: Harness): Promise<void> {
  harness.server.on("thread/start", () => threadStartResult());
  await harness.driver.createSession({
    model: TEST_MODEL,
    sessionId: SESSION_ID,
    config: SESSION_CONFIG,
  });
}

export interface ManagerHarness {
  server: FakeCodexAppServer;
  manager: CodexLifecycleManager;
  diagnostics: CodexTransportDiagnostic[];
  driverDiagnostics: DriverDiagnosticsEmitter;
  textNeutralizationFailures: RecordedTextNeutralizationFailure[];
  notifications: Array<{ method: string; params: unknown }>;
  meteredUsage: Array<{ sessionId: SessionId; delta: MeteredUsageDelta }>;
  subagentLifecycle: Array<{ sessionId: SessionId; emission: SubagentLifecycleEmission }>;
  scheduler: ManualScheduler;
}

export interface ManagerHarnessOptions {
  onServerNotification?: boolean;
  /**
   * Wraps the real disposer in one that throws after disposing, so the failure is only the
   * caller-supplied code misbehaving, not a listener left registered.
   */
  throwingSubscriptionDisposer?: boolean;
  /** Overrides the binding-id minter, so a hostile mint can be driven. */
  newBindingId?: () => string;
  /**
   * Called synchronously with every transport diagnostic, after it is recorded. A probe, not a
   * recorder: several driver blocks report a diagnostic partway through otherwise atomic work,
   * and this is the only seam from which a test can act inside one.
   */
  onTransportDiagnostic?: (diagnostic: CodexTransportDiagnostic) => void;
  /**
   * Throws from the first diagnostic and records every later one. Throwing from all of them
   * would make "the drain survived" unobservable through the sink; the next diagnostic is the
   * evidence.
   */
  throwOnFirstDiagnostic?: boolean;
  /**
   * Throws from the first notification delivered to the consumer, then behaves. As with the sink
   * flag, the next notification is what proves the drain survived.
   */
  throwOnFirstNotification?: boolean;
  /** Overrides the spawn context every manager-owned spawn is composed from. */
  resumeSpawnConfig?: CodexSessionConfig;
  /** Overrides the daemon's per-resume credential-policy resolution. */
  resolveCredentialEnvPolicy?: CodexCredentialEnvPolicyResolver;
  /** Supplies the daemon's prior-emitted cumulative sums for a resume base. */
  readPriorEmittedUsage?: (
    sessionId: SessionId,
    threadId: string,
  ) => CumulativeAxisReadings | undefined;
  /** Binds the session-scoped ask responder, so a routed ask can be observed. */
  answerServerRequest?: CodexSessionServerRequestResponder;
  /** Overrides the untyped spawn config, so an account-bearing spawn can be built. */
  config?: Record<string, unknown>;
}

/**
 * A harness over the manager rather than the driver facade. `hasActiveTurn` and the route
 * bookkeeping live on `CodexLifecycleManager`; the driver's `Pick<ProviderDriver, ...>` does not
 * surface them, so route-lifetime assertions have to be made here.
 */
export function createManagerHarness(options: ManagerHarnessOptions = {}): ManagerHarness {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  server.on("thread/start", () => threadStartResult());
  // Answered because the manager's teardown awaits it and the manual scheduler never fires the
  // courtesy deadline.
  server.on("thread/unsubscribe", () => ({ result: {} }));
  // Answered by default so the resume-failure auth classification resolves: these tests run on a
  // manual scheduler where its deadline never fires, and a logged-in provider is the realistic
  // baseline. Cases that need the logged-out reading re-register this method.
  server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driverDiagnostics = makeSilentDriverDiagnostics();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const meteredUsage: Array<{ sessionId: SessionId; delta: MeteredUsageDelta }> = [];
  const subagentLifecycle: Array<{ sessionId: SessionId; emission: SubagentLifecycleEmission }> =
    [];
  const textNeutralizationFailures: RecordedTextNeutralizationFailure[] = [];
  const scheduler = makeManualScheduler();
  let firstDiagnosticThrown = false;
  let firstNotificationThrown = false;
  const manager = new CodexLifecycleManager({
    ptyHost: server,
    modelCatalogExchange: STUB_MODEL_CATALOG_READ,
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
      options.onTransportDiagnostic?.(diagnostic);
    },
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: options.resumeSpawnConfig ?? RESUME_SPAWN_CONFIG,
    resolveCredentialEnvPolicy:
      options.resolveCredentialEnvPolicy ?? resolveNoDeniedCredentialNames,
    newBindingId: options.newBindingId ?? ((): string => "binding-abc"),
    onMeteredUsage: (sessionId, delta) => meteredUsage.push({ sessionId, delta }),
    onSubagentLifecycle: (sessionId, emission) => subagentLifecycle.push({ sessionId, emission }),
    onTextNeutralizationFailure: (sessionId, runId, failure) => {
      textNeutralizationFailures.push({
        sessionId,
        runId,
        providerFailureDetail: failure.providerFailureDetail,
      });
    },
    ...(options.readPriorEmittedUsage === undefined
      ? {}
      : { readPriorEmittedUsage: options.readPriorEmittedUsage }),
    ...(options.answerServerRequest === undefined
      ? {}
      : { answerServerRequest: options.answerServerRequest }),
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
    textNeutralizationFailures,
    scheduler,
  };
}

/**
 * A `turn/completed` frame at the pinned shape (`params.turn.{id,status}`) carrying one
 * model-output item. A `completed` turn with an empty item list is what the zero-turn check
 * catches, so a fixture without one would trip every test that only needs a turn to end and
 * dispose the session it goes on to use.
 */
export function turnCompletedFrame(turnId: string, status: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: turnId, status, items: [{ type: "agentMessage", id: "item-1" }] },
    },
  };
}

/**
 * A `completed` turn that produced nothing: the shape a provider answers with when its input
 * surface consumed the user's words as a client-side command.
 */
export function zeroTurnCompletedFrame(turnId: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: { id: turnId, status: "completed", items: [] } },
  };
}

/** An in-flight `item/completed` naming one model message on a turn. */
export function modelOutputItemFrame(turnId: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId, item: { type: "agentMessage", id: "item-1" } },
  };
}

interface RoutedAskHarness {
  readonly harness: Harness;
  readonly askProvider: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  /**
   * The records the manager emitted, distinct from `harness.diagnostics` (the
   * transport-local sink). Both are captured because a turn-attribution refusal must reach
   * both sinks.
   */
  readonly driverDiagnosticRecords: DriverDiagnosticRecord[];
}

export async function routedAskHarness(
  responder: CodexSessionServerRequestResponder | undefined,
): Promise<RoutedAskHarness> {
  const server = new FakeCodexAppServer();
  server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
  server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
  server.on("thread/start", () => threadStartResult());
  const scheduler = makeManualScheduler();
  const driverDiagnosticRecords: DriverDiagnosticRecord[] = [];
  const driverDiagnostics = new DriverDiagnosticsEmitter({
    logSink: { record: (record) => driverDiagnosticRecords.push(record) },
    counterSink: { increment: () => undefined },
  });
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driver = new CodexDriver({
    ptyHost: server,
    modelCatalogExchange: STUB_MODEL_CATALOG_READ,
    diagnostics: driverDiagnostics,
    subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onTextNeutralizationFailure: () => undefined,
    scheduleTimeout: scheduler.schedule,
    executablePath: EXECUTABLE_PATH,
    resumeSpawnConfig: RESUME_SPAWN_CONFIG,
    resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
    newBindingId: () => "binding-abc",
    readCapabilities: () => makeCapabilities(true),
    ...(responder === undefined ? {} : { answerServerRequest: responder }),
  });
  await driver.createSession({ model: TEST_MODEL, sessionId: SESSION_ID, config: SESSION_CONFIG });
  const harness: Harness = {
    server,
    driver,
    diagnostics,
    driverDiagnostics,
    textNeutralizationFailures: [],
    scheduler,
  };

  let nextRequestId = 9000;
  const askProvider = async (
    method: string,
    params: unknown = {},
  ): Promise<Record<string, unknown>> => {
    const requestId = (nextRequestId += 1);
    const before = server.writtenLines.length;
    server.onData(
      "pty-session-1",
      new TextEncoder().encode(
        `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\r\n`,
      ),
    );
    await drainMicrotasks();
    for (const line of server.writtenLines.slice(before)) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame["id"] === requestId) {
        return frame;
      }
    }
    throw new Error(`the driver never answered the ${method} ask`);
  };
  return { harness, askProvider, driverDiagnosticRecords };
}
