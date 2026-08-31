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
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverCompactionResult,
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
  type CallbackToolInvocation,
  type CallbackToolResult,
  type ProviderCommandEntry,
  type SessionCallbackTool,
  DriverTranscriptReplayResultSchema,
} from "@ai-sidekicks/contracts";

import {
  bindCallbackToolsForSpawn,
  CallbackToolHost,
  createCallbackToolAskResponder,
  type CallbackToolSpawnBinding,
} from "../../../callback-tool-host.js";
import {
  DriverDiagnosticsEmitter,
  type DriverDiagnosticRecord,
} from "../../../driver-diagnostics.js";
import {
  OutboundFrameCapacityRefusedError,
  OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
  TEXT_NEUTRALIZATION_REFUSAL_CODE,
  TextNeutralizationRefusedError,
} from "../../outbound-frame.js";
import type { SubagentLifecycleEmission } from "../../../thread-frame-router.js";
import type { CumulativeAxisReadings, MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import { hostEnvNameMatchForPlatform } from "../../../spawn-env.js";
import {
  PermanentStructuralRefusalError,
  type ParticipantTurnReadbackReader,
} from "../../../transcript/failure-mapping.js";
import {
  PostReplayAssertionFailedError,
  ReplayTargetAbandonedError,
  type ReplayTargetReadback,
  type ReplayTargetReadbackReader,
} from "../../../transcript/replay-assertion.js";
import {
  CodexAppServerConnection,
  CodexDriver,
  CodexLifecycleManager,
  CodexLineTooLongError,
  CodexSessionAlreadyLiveError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexRewindBoundaryUnsupportedError,
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
  type CodexCredentialEnvPolicyResolver,
  type CodexScheduleTimeout,
  type CodexSessionConfig,
  type CodexTransportDiagnostic,
  type CodexTransportSelection,
  CODEX_INTERVENTION_FALLBACK_ACTION,
  CODEX_DECLARED_MODEL_CATALOG,
} from "../index.js";
import { CODEX_NEGOTIATION_GATED_METHODS } from "../event-normalizer.js";
// Directly from the module rather than through the driver barrel: these are
// internal enforcement details, and widening the driver's public surface to
// reach them from a test would make them look like part of its contract.
import {
  CALLER_DERIVED_TURN_POSTURE_FIELDS,
  CODEX_ASK_OPTION_SET_MAX,
  CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
  CODEX_COMPACTION_WAIT_MS,
  CODEX_MAX_OUTBOUND_FRAME_BYTES,
  CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON,
  UNREALIZED_TURN_POSTURE_MEMBERS,
  assertRealizedTurnPostureMembers,
  readCodexAskOptionSet,
  type CodexSessionServerRequest,
} from "../lifecycle.js";

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
  /**
   * Rejects the next write WITHOUT killing the child.
   *
   * Distinct from `failWriteAfterChildExit` on purpose: that arm models a dead
   * process, where the exit path is the record. This one models a write that
   * rejects on a connection nothing else reports on, which is exactly the case
   * a swallowed `.catch()` made invisible.
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
   * Suspends ONE method's answer until the returned release is called.
   *
   * The handler still runs at write time, so the frame is recorded and any
   * handler side effect happens exactly when it otherwise would — what is held
   * is the emission. That is the only way to leave a request in flight ACROSS
   * another whole lifecycle transition: `parkNextWrite` never records the frame
   * and so never answers it at all, and a handler cannot suspend itself because
   * it is called synchronously from inside `write`.
   *
   * THE RELEASE EMITS IN ITS OWN TICK, not on a microtask like the ordinary
   * path. That is what lets a test place a response INSIDE a synchronous block
   * of driver code — reached through a sink the driver calls from within one —
   * and a microtask emission could not: it would drain only after that block had
   * run to completion, which for the teardown windows this exists to probe is
   * exactly one instruction too late.
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
    const emit = (): void => {
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
    };
    if (this.#heldMethods.has(method)) {
      this.#heldEmissions.set(method, emit);
      return;
    }
    queueMicrotask(emit);
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
  fireDelay: (delayMs: number) => number;
  pendingDelays: () => readonly number[];
  firedDelays: () => readonly number[];
  pendingCount: () => number;
} {
  const scheduled: ScheduledTimeout[] = [];
  const fired: number[] = [];
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
          fired.push(entry.delayMs);
          entry.callback();
        }
      }
    },
    /**
     * Fires ONLY the timers armed at one declared delay, and answers how many
     * ran (T3.26).
     *
     * `fireAll` cannot serve an expiry assertion on a single deadline: a live
     * session holds the transport's own request deadline too, so firing
     * everything would reject the in-flight request and settle the operation on
     * a transport failure — a test that passes for the wrong reason. Selecting
     * by delay is what keeps "the compaction bound elapsed" the only thing that
     * happened, and it is unambiguous because the compaction bound is
     * deliberately not equal to any other deadline this driver arms.
     */
    fireDelay: (delayMs: number) => {
      let firedHere = 0;
      for (const entry of scheduled) {
        if (!entry.cancelled && entry.delayMs === delayMs) {
          entry.cancelled = true;
          fired.push(entry.delayMs);
          entry.callback();
          firedHere += 1;
        }
      }
      return firedHere;
    },
    pendingDelays: () =>
      scheduled.filter((entry) => !entry.cancelled).map((entry) => entry.delayMs),
    /**
     * The delays that ACTUALLY ran, as distinct from the ones cancelled.
     *
     * The two are indistinguishable through `pendingCount` — a settled wait
     * cancels its own timer, and so does an expired one — so an immediacy
     * assertion ("this settled without any timer firing") needs its own record.
     */
    firedDelays: () => fired,
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
// The turn of the SECOND run. Two distinct runs holding live turns is the state
// the sole-active run heuristic cannot answer in, and the state a turn-keyed
// attribution resolves exactly.
const SECOND_TURN_ID = "turn-02";
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

/**
 * The daemon's stand-in policy resolver: a well-formed policy denying nothing.
 *
 * Deliberately a real policy rather than `undefined`. A sandboxed posture OWES a
 * resolution, and answering `undefined` is the wiring fault the driver refuses —
 * so a harness default of `undefined` would make every posture-bearing resume in
 * this file fail for a reason none of them are about. Its `envNameMatch` is the
 * HOST's, because the shared builder refuses a policy that declares a different
 * one.
 */
const resolveNoDeniedCredentialNames: CodexCredentialEnvPolicyResolver = () =>
  Promise.resolve({
    denyEnvVars: [],
    envNameMatch: hostEnvNameMatchForPlatform(process.platform),
  });

interface Harness {
  server: FakeCodexAppServer;
  driver: CodexDriver;
  diagnostics: CodexTransportDiagnostic[];
  driverDiagnostics: DriverDiagnosticsEmitter;
  textNeutralizationFailures: RecordedTextNeutralizationFailure[];
  scheduler: ReturnType<typeof makeManualScheduler>;
}

/**
 * One run terminal a text-neutralization trip produced (T3.18).
 *
 * The callback is a REQUIRED dependency, so every harness binds it — the trip
 * raises no JSON-RPC error, and an unbound sink would let a swallowed turn end
 * with no record an operator can read.
 */
interface RecordedTextNeutralizationFailure {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly providerFailureDetail: string;
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
  options: {
    steer?: boolean;
    subscribeToPtySession?: CodexPtySessionSubscriber;
    resumeSpawnConfig?: CodexSessionConfig;
    resolveCredentialEnvPolicy?: CodexCredentialEnvPolicyResolver;
  } = {},
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
  const textNeutralizationFailures: RecordedTextNeutralizationFailure[] = [];
  const scheduler = makeManualScheduler();
  const driver = new CodexDriver({
    ptyHost: server,
    modelCatalogExchange: null,
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
  });
  return { server, driver, diagnostics, driverDiagnostics, textNeutralizationFailures, scheduler };
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
  textNeutralizationFailures: RecordedTextNeutralizationFailure[];
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
   * Called SYNCHRONOUSLY with every transport diagnostic, after it is recorded.
   *
   * A probe rather than a recorder: several driver-internal blocks report a
   * diagnostic partway through work that is otherwise atomic, and this is the
   * only seam from which a test can act inside one of those blocks.
   */
  onTransportDiagnostic?: (diagnostic: CodexTransportDiagnostic) => void;
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
  /** Overrides the untyped spawn config, so an account-bearing leg can be built. */
  config?: Record<string, unknown>;
  /** Binds the replay target-readback reader, so the post-replay assertion can run. */
  transcriptReplayReadback?: ReplayTargetReadbackReader;
  /**
   * Binds the participant-turn readback, so T3.22's positional reconcile can run.
   *
   * Left unbound by default, exactly as the production composition leaves it, so
   * every test that does not name it exercises the unreadable settlement — which
   * is the shipped teardown-and-replay behaviour.
   */
  participantTurnReadback?: ParticipantTurnReadbackReader;
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
  const textNeutralizationFailures: RecordedTextNeutralizationFailure[] = [];
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
    ...(options.transcriptReplayReadback === undefined
      ? {}
      : { transcriptReplayReadback: options.transcriptReplayReadback }),
    ...(options.participantTurnReadback === undefined
      ? {}
      : { participantTurnReadback: options.participantTurnReadback }),
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
 * A `turn/completed` frame at the pinned shape (`params.turn.{id,status}`),
 * carrying one model-output item.
 *
 * The item is not decoration. A `completed` turn with an EMPTY item list is
 * exactly the zero-turn reply the T3.18 tripwire exists to catch, so a fixture
 * without one would trip every test that merely needs a turn to end — and would
 * then dispose the session those tests go on to use.
 */
function turnCompletedFrame(turnId: string, status: string): Record<string, unknown> {
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
 * A `completed` turn that produced NOTHING — the shape a provider answers with
 * when its input surface consumed the participant's words as a client-side
 * command (T3.18).
 */
function zeroTurnCompletedFrame(turnId: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: { id: turnId, status: "completed", items: [] } },
  };
}

/** An in-flight `item/completed` naming one model message on a turn (T3.18). */
function modelOutputItemFrame(turnId: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId, item: { type: "agentMessage", id: "item-1" } },
  };
}

/**
 * The opening text one `turn/start` request carries.
 *
 * Lets a handler answer two OVERLAPPING attempts differently by reading the
 * request itself rather than counting calls — which attempt reaches the server
 * first is exactly what an overlap test must not assume.
 */
function readTurnStartInputText(params: unknown): string | undefined {
  const input = (params as { input?: ReadonlyArray<{ text?: string }> }).input;
  return input?.[0]?.text;
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
    // Drained rather than counted. The create path resolves its credential
    // policy before it opens a connection, so how many microtasks separate the
    // call from the subscribe is the driver's business and not this arm's.
    await drainMicrotasks();
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
      modelCatalogExchange: null,
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
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
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
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
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

  it("fails a superseded leg's unsettled frame instead of dropping it", async () => {
    // The guarantee: a participant's text that provably may not have reached the
    // model never silently vanishes. The resume replaces the binding the frame
    // was written on, so no terminal for it can ever arrive — and a dropped
    // frame leaves the run looking exactly like one whose words landed.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    // Started and deliberately never settled: no terminal notification is sent,
    // so the opening frame is still pending when the resume supersedes the leg.
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.runId).toBe(RUN_ID);
  });

  it("states the supersede as its own cause, never as a swallowed turn", async () => {
    // The cause is the other half of the fix. Borrowing the trip's detail would
    // publish a swallow nobody observed, and that detail's registered code has a
    // fixed parseable form a consumer reads — so the wrong cause is not merely
    // imprecise prose, it is a claim another layer will act on.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    const detail = harness.textNeutralizationFailures[0]?.providerFailureDetail ?? "";
    expect(detail).not.toContain(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    expect(detail).toContain("superseded");
    // And the participant's own words are never quoted into the detail — the
    // cause says what happened to them, not what they were.
    expect(detail).not.toContain("rebase");
  });

  it("leaves a superseded run attachable — the fresh binding is where it belongs", async () => {
    // The trip path quarantines both axes because the process is condemned.
    // Nothing is condemned here: the binding is simply gone, replaced by one
    // that works. Quarantining the run would take its interrupt and intervention
    // controls away for the daemon's lifetime, in exchange for nothing.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    // The run has no live turn on the replacement leg, so the refusal is the
    // ordinary one — and specifically NOT the quarantine's, which the resolver
    // consults first and which would answer here if the run had been condemned.
    const refusal = await harness.driver.interruptRun({ runId: RUN_ID, reason: "user" }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(refusal).toBeInstanceOf(CodexTransportError);
    expect(refusal).not.toBeInstanceOf(TextNeutralizationRefusedError);
    expect(String(refusal)).toContain("No active Codex turn");
  });

  it("reports one failure per run, not one per frame", async () => {
    // Two frames on one run — the opening frame and a steer — and one supersede.
    // One supersede is one cause; a report per frame would tell the participant
    // their run failed twice for the same reason.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });
    await harness.driver.applyIntervention({
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: "9a1d8f30-0000-4000-8000-0000000000ab",
      payload: { content: "and squash the fixups", expectedTurnId: TURN_ID },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    const reported = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "superseded-frames-failed",
    );
    expect(reported).toHaveLength(1);
    // The frame count is the operator's only sight of the writes the superseded
    // binding was carrying, so it is NOT collapsed to the report count.
    expect(reported[0]).toMatchObject({ abandonedFrameCount: 2, reportedRunCount: 1 });
  });

  it("reports nothing when the superseded leg was carrying no frames", async () => {
    // The negative control: a resume over an idle leg is the ordinary case, and
    // failing a run there would invent a loss out of a clean recovery.
    const harness = createHarness();
    await createdSession(harness);

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    expect(harness.textNeutralizationFailures).toEqual([]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "superseded-frames-failed"),
    ).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Approval-reviewer pinning (`Spec-005 §Required Behavior`)
// --------------------------------------------------------------------------

describe("CodexDriver approval reviewer pinning", () => {
  // The security property: every approval request the provider raises must reach
  // the daemon's own approval pipeline, so no config or profile override may
  // select `auto_review`. `approvalsReviewer` is present on ThreadStartParams,
  // ThreadResumeParams AND TurnStartParams at `codex-cli 0.150.1` (verified
  // 2026-08-28 against the binary's own generated schema, all three params types
  // byte-identical to the `0.149.1` generation), and the per-turn field
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

// --------------------------------------------------------------------------
// The shared spawn-environment builder, reached through the driver
// --------------------------------------------------------------------------

describe("CodexDriver credential-policy strip at the spawn seam", () => {
  const DENIED_ENV_VAR = "ANTHROPIC_API_KEY";

  // The daemon's RESOLUTION of the posture's `credentialPolicyRef`. The driver
  // is handed the names because it never expands a reference — that is the
  // disclosure the content-addressed ref exists to avoid.
  const DENY_POLICY = { denyEnvVars: [DENIED_ENV_VAR], envNameMatch: "case-sensitive" } as const;

  it("strips a denied name from a created session's child", async () => {
    // Also the NO-POSTURE arm of the create path: this request states no
    // `executionPosture`, so the config bag's own policy is what governs and the
    // resolver is never consulted. The posture-stated arms follow below.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });

    // Byte-exact, so the strip cannot be satisfied by a builder that also
    // dropped or reordered something else.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("strips it on a resume relaunch, which is a fresh spawn from a different config", async () => {
    // The whole point of routing every path through one builder: this config
    // object never passes through `createSession`, so a create-site composition
    // would have shed the strip here.
    const harness = createHarness({
      resumeSpawnConfig: {
        cwd: "/work/resume",
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  // The two postures a spawn can be established under, kept as a PAIR because
  // the property under test is symmetric: a session's posture can change between
  // the create that established it and the resume that relaunches it, and the
  // child has to follow the current one in BOTH directions. Named for neither
  // path, because both paths resolve through the same rule — a create's arms and
  // a resume's arms below drive these same two values.
  const SANDBOXED_POSTURE: ExecutionPosture = {
    mode: "workspace-sandboxed",
    credentialPolicyRef: "policy://resume",
    networkAccess: "none",
    writableRoots: [SESSION_CWD],
  };
  const TRUSTED_POSTURE: ExecutionPosture = {
    mode: "trusted",
    networkAccess: "full",
    writableRoots: [SESSION_CWD],
  };

  it("strips under the CREATED posture's policy though the config bag declared none", async () => {
    // THE ASYMMETRY THIS CLOSES. A sandboxed posture REQUIRES a
    // `credentialPolicyRef`, but the config bag is untyped and can simply omit
    // `credentialEnvPolicy` — and before the two channels were joined that
    // silence read as "deny nothing" and opened the child holding the very
    // credential the posture withheld. The resume path already re-derived; this
    // is the same rule reached from the create composer.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("lets the CREATED posture's policy override a bag that named a different one", async () => {
    // THE PRECEDENCE ARM, and the only one where both channels actually speak.
    // Every other arm has one of the two silent, so a resolution that merely
    // FILLED IN for an absent bag policy would satisfy them all. Here the bag
    // denies one name and the posture resolves to another: the posture's answer
    // must be what governs, whole, rather than being merged with or deferred to
    // what the untyped bag happened to declare beside it.
    const OTHER_DENIED_ENV_VAR = "OPENAI_API_KEY";
    const harness = createHarness({
      resolveCredentialEnvPolicy: () =>
        Promise.resolve({
          denyEnvVars: [OTHER_DENIED_ENV_VAR],
          envNameMatch: "case-sensitive",
        }),
    });
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
          [OTHER_DENIED_ENV_VAR, "sk-other"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
      executionPosture: SANDBOXED_POSTURE,
    });

    // The posture's name is gone and the BAG's name survives. Both halves are
    // load-bearing: the survival is what a fallback-only resolution fails, and
    // the strip is what an ignore-the-posture composition fails.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [DENIED_ENV_VAR, "sk-live"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("strips nothing under a `trusted` created posture though the config bag carried one", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
      executionPosture: TRUSTED_POSTURE,
    });

    // The denied name SURVIVES, which is the DROP arm stated as an assertion.
    // `trusted` types `credentialPolicyRef?: never`, so a policy sitting beside
    // it in the bag is a wiring inconsistency and not a stricter grant the
    // posture made. Honouring it here while the resume path drops it would
    // rebuild the create/resume asymmetry mirror-imaged — one session stripping
    // on create and not on relaunch.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [DENIED_ENV_VAR, "sk-live"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("refuses a CREATED posture that resolves to no policy, before anything is spawned", async () => {
    // The create twin of the resume's refusal arm, and it refuses through a
    // different channel: `resumeSession` owes I-005-5 a typed `failed` result,
    // while `createSession` has no result type to refuse into, so the refusal is
    // the same typed config error its bag parse already raises.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(undefined),
    });
    harness.server.on("thread/start", () => threadStartResult());

    const refused = await harness.driver
      .createSession({
        sessionId: SESSION_ID,
        config: {
          cwd: SESSION_CWD,
          env: [
            ["HOME", "/home/agent"],
            [DENIED_ENV_VAR, "sk-live"],
          ],
        },
        executionPosture: SANDBOXED_POSTURE,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    // The field is the CREATE request's own parameter path. Asserted because the
    // shared helper takes it as an argument: without this, a caller passing the
    // resume label would name a parameter the operator never sent and nothing
    // would fail.
    expect((refused as CodexDriverConfigError).field).toBe(
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    // Nothing was spawned at all: the composition runs before the connection
    // object exists, so no child ever held the environment the policy filters.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("hands the create's RESOLVED policy to a resume that states no posture", async () => {
    // The two fixes meeting. The create's posture resolves a policy the bag never
    // declared, and the record stores that RESOLUTION rather than the bag — so a
    // resume that states nothing inherits the policy the child actually ran
    // under. Inheriting the bag's absence would relaunch unfiltered.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
      executionPosture: SANDBOXED_POSTURE,
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    expect(harness.server.spawnRequests[1]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("strips under the RESUMED posture's policy though the create-time posture had none", async () => {
    // The create leg carries no policy at all, so the session's own recorded
    // spawn config denies nothing. A resume that reused that record would
    // relaunch the child holding the credential the current posture withholds.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: SANDBOXED_POSTURE,
    });

    // The SECOND spawn is the resume's; the first is the create it supersedes.
    // Byte-exact, so a strip that also dropped or reordered the process context
    // it inherited would not pass.
    expect(harness.server.spawnRequests[1]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("strips nothing under a `trusted` resumed posture though the create-time posture had a policy", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: TRUSTED_POSTURE,
    });

    // The denied name SURVIVES, and that direction is the one a "still strips
    // things" assertion cannot catch. `trusted` types `credentialPolicyRef?:
    // never`, so the posture is a positive statement that nothing is denied —
    // carrying the create's policy forward would keep withholding a credential
    // the session is no longer sandboxed against.
    expect(harness.server.spawnRequests[1]?.env).toEqual([
      ["HOME", "/home/agent"],
      [DENIED_ENV_VAR, "sk-live"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("honours the resumed posture on a COLD resume, which has no record to reuse", async () => {
    // The daemon-restart case, and the one the manager-wide config cannot serve:
    // `resumeSpawnConfig` is a single construction-time object, so it can carry
    // at most one policy for every session on the node — here, none at all.
    const harness = createHarness({
      resumeSpawnConfig: {
        cwd: "/work/resume",
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("refuses a posture that resolves to no policy, and refuses it as a RESULT", async () => {
    // Two properties in one arm because they are one guarantee. A posture whose
    // mode is not `trusted` REQUIRES `credentialPolicyRef`, so an unresolved
    // policy is a wiring fault — degrading it to "deny nothing" would launch the
    // child holding exactly the credentials the reference exists to withhold.
    // And I-005-5 requires the refusal to ARRIVE as the typed `failed` result: a
    // rejection escaping `resumeSession` would be a second failure channel the
    // recovery leg has no rule for.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(undefined),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(result.status).toBe("failed");
    // Nothing was spawned at all: the refusal lands before `open()`, so no child
    // ever held the environment the policy was supposed to filter.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("strips it on the auth probe's child, the third spawn path", async () => {
    const harness = createManagerHarness({
      resumeSpawnConfig: {
        cwd: "/work/resume",
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });

    await harness.manager.probeAuth();

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENV_VAR, EXECUTABLE_PATH],
    ]);
  });

  it("keeps the exact-build-path pin even when the policy names it", async () => {
    // This provider documents no auto-update environment opt-out, so the pinned
    // binary path IS its suppression mechanism. A deny list able to strip it
    // would hand the child back to whatever the launcher resolves to.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [["HOME", "/home/agent"]],
        credentialEnvPolicy: {
          denyEnvVars: [CODEX_APP_SERVER_BIN_ENV_VAR],
          envNameMatch: "case-sensitive",
        },
      },
    });

    expect(harness.server.spawnRequests[0]?.env).toContainEqual([
      CODEX_APP_SERVER_BIN_ENV_VAR,
      EXECUTABLE_PATH,
    ]);
  });

  it("refuses a policy it cannot read rather than spawning with nothing stripped", () => {
    // Absent and malformed are different answers, and defaulting the malformed
    // one to "deny nothing" would spawn the child with exactly the variables the
    // policy exists to withhold. `envNameMatch` is refused when missing for the
    // same reason: the mode decides whether `path` slips past a list naming
    // `PATH`, and this side of the wire does not know the host.
    const unreadablePolicies: readonly unknown[] = [
      {},
      { denyEnvVars: [], envNameMatch: "whatever-the-host-does" },
      { denyEnvVars: ["A"] },
      { denyEnvVars: "ANTHROPIC_API_KEY", envNameMatch: "case-sensitive" },
      { denyEnvVars: [""], envNameMatch: "case-sensitive" },
      { denyEnvVars: [1], envNameMatch: "case-sensitive" },
      "case-sensitive",
    ];
    for (const credentialEnvPolicy of unreadablePolicies) {
      expect(() => parseCodexSessionConfig({ ...SESSION_CONFIG, credentialEnvPolicy })).toThrow(
        CodexDriverConfigError,
      );
    }
  });

  it("carries an absent policy as an absent member, which a trusted posture is", () => {
    expect(parseCodexSessionConfig(SESSION_CONFIG)).toEqual({
      cwd: SESSION_CWD,
      env: [
        ["HOME", "/home/agent"],
        ["PATH", "/usr/bin"],
      ],
    });
  });
});

// --------------------------------------------------------------------------
// Provider-account precedence at the spawn seam (T3.17)
// --------------------------------------------------------------------------

describe("CodexDriver provider-account precedence at the spawn seam", () => {
  const ADMITTED_ACCOUNT_ID = "account-admitted";
  const NODE_DEFAULT_ACCOUNT_ID = "account-node-default";

  /**
   * The account the session's spawn config actually carries, read back off the
   * record through the one surface that publishes it.
   *
   * `listProviderCommands` is the observable rather than a reach-in: it composes
   * every entry's routing binding from `record.spawnConfig.providerAccountId`,
   * which is precisely the value the composers under test produce. A private
   * field read would assert the same number without proving it reaches the
   * consumer that routes on it.
   */
  async function boundAccountId(harness: Harness): Promise<string | null> {
    const result = await harness.driver.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    return result.bindings[0]?.binding.providerAccountId ?? null;
  }

  function accountHarness(options: { resumeSpawnConfig?: CodexSessionConfig } = {}): Harness {
    const harness = createHarness(
      options.resumeSpawnConfig === undefined
        ? {}
        : { resumeSpawnConfig: options.resumeSpawnConfig },
    );
    // REQUIRED wherever a resume runs: the resume holds the new connection and
    // the superseded one at once, and the fake's listener registry is keyed by
    // pty session id — shared ids let the predecessor's later unsubscribe delete
    // the live reader. A fixture artifact of the double-spawn, not a behaviour.
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/start", () => threadStartResult());
    harness.server.on("thread/resume", () => threadStartResult(1));
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));
    harness.server.on("skills/list", () => ({
      result: {
        data: [
          {
            cwd: SESSION_CWD,
            skills: [
              { name: "review", description: "Review a diff", scope: "repo", enabled: true },
            ],
            errors: [],
          },
        ],
      },
    }));
    return harness;
  }

  it("binds a create to the TYPED member when the config bag names none", async () => {
    // THE FAIL-OPEN THIS CLOSES. Before T3.17 was wired in, the create seam read
    // only the untyped bag — so a caller following the typed contract spawned
    // against whatever the node resolves as that provider's default, with the
    // receipt's per-paying-account key still claiming the admitted one. Nothing
    // reported the substitution, which is what made it a silent re-bill rather
    // than a visible failure.
    const harness = accountHarness();

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("keeps the legacy config-bag channel working when the typed member is absent", async () => {
    // The account plane is not shipped, so the bag is still how in-tree callers
    // name an account. Making the typed member authoritative must not retire the
    // fallback — an unchanged caller keeps its unchanged behaviour.
    const harness = accountHarness();

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: { ...SESSION_CONFIG, providerAccountId: ADMITTED_ACCOUNT_ID },
    });

    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("binds a create when both channels agree", async () => {
    const harness = accountHarness();

    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: { ...SESSION_CONFIG, providerAccountId: ADMITTED_ACCOUNT_ID },
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a create whose two channels name different accounts, before anything spawns", async () => {
    // Neither resolver may silently win. Picking the typed one would override a
    // caller that explicitly declared an account; picking the bag would
    // re-introduce the very silent re-bill T3.17 closed. A refusal is the only
    // answer that cannot move a run's spend without saying so.
    const harness = accountHarness();

    const refused = await harness.driver
      .createSession({
        sessionId: SESSION_ID,
        config: { ...SESSION_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
        providerAccountId: ADMITTED_ACCOUNT_ID,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    // The field names the TYPED member's own parameter path, so an operator is
    // pointed at the authoritative channel rather than at the legacy one.
    expect((refused as CodexDriverConfigError).field).toBe("CreateSessionParams.providerAccountId");
    // Both account ids are named, because a refusal that reported only that two
    // values disagreed would leave the operator unable to tell which resolver is
    // wrong.
    expect((refused as CodexDriverConfigError).message).toContain(ADMITTED_ACCOUNT_ID);
    expect((refused as CodexDriverConfigError).message).toContain(NODE_DEFAULT_ACCOUNT_ID);
    // Nothing was spawned at all: the composition runs before the connection
    // object exists, so no child ever ran under an unsettled billing identity.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("REFUSES a present-but-empty typed member, exactly as the bag parse does", async () => {
    // An empty string is a daemon that meant to bind an account and bound
    // nothing, which is a different fact from a session that never had one — and
    // only the second may enumerate under a `null` account. Enforced on the typed
    // channel too, because it reaches the composer without passing the bag parse.
    const harness = accountHarness();

    const refused = await harness.driver
      .createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG, providerAccountId: "" })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("binds a COLD resume when the typed member and the node-wide default AGREE", async () => {
    // The cold arm's ONLY admitting case, asserted so the refusals below cannot
    // be satisfied by an arm that simply refuses every typed member.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: ADMITTED_ACCOUNT_ID },
    });

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("resumed");
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a COLD resume that names an account the available environment was not built for", async () => {
    // WHY THIS CANNOT BE HONOURED, which is a stronger reason than a precedence
    // rule. With no record to relaunch from, `cwd` and `env` come from the
    // node-wide `resumeSpawnConfig` — and that `env` is the CONSTRUCTED
    // credential environment the daemon built for the DEFAULT account. This
    // driver never locates credentials, so it cannot build the admitted
    // account's environment; taking the typed member here would move the
    // METADATA only, leaving the routing binding reporting one account while the
    // child authenticated, and billed, as another. That is the round-1 re-bill
    // wearing a correct-looking binding, so this arm refuses instead.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    // I-005-5: the refusal ARRIVES as the typed result, never as a rejection.
    expect(result.status).toBe("failed");
    // Both accounts are named, so an operator can see which side is wrong rather
    // than only that two values differed.
    const detail = result.status === "failed" ? result.providerFailureDetail : "";
    expect(detail).toContain(ADMITTED_ACCOUNT_ID);
    expect(detail).toContain(NODE_DEFAULT_ACCOUNT_ID);
    // Nothing ran: the composition refuses before `open()`, so no child ever
    // authenticated under the wrong credential home.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("REFUSES a COLD resume that names an account while the node-wide default is UNBOUND", async () => {
    // AN AMBIENT ENVIRONMENT IS NOBODY'S IN PARTICULAR. A default carrying no
    // account is not a wildcard that happens to match every request — it is an
    // environment built for no bound account, which is precisely NOT the
    // admitted account's. Treating absence as agreement is the tempting reading
    // and the one that reopens the hole: it would let every cold resume claim
    // any account it liked, on the strength of the default naming no other.
    const harness = accountHarness();

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("failed");
    const detail = result.status === "failed" ? result.providerFailureDetail : "";
    expect(detail).toContain(ADMITTED_ACCOUNT_ID);
    // The unbound side is stated in words, because there is no id to print and a
    // refusal that named only one account would read as a truncation.
    expect(detail).toContain("no bound account");
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("falls back to the node-wide default on a cold resume that names no account", async () => {
    // The unchanged legacy path, asserted so the precedence above cannot be
    // satisfied by a composer that simply stopped reading the fallback.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    expect(await boundAccountId(harness)).toBe(NODE_DEFAULT_ACCOUNT_ID);
  });

  it("re-realizes the live record's account on a resume that names none", async () => {
    // A resume re-realizes the credential home this leg is pinned to for its
    // lifetime, unlike the credential policy beside it: an account that silently
    // moved mid-session would re-key the receipt's per-paying-account axis.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    // The RECORD's account, not the node-wide default sitting beside it.
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a resume whose typed member contradicts the live record, as a RESULT", async () => {
    // The live record is what THIS session's process is actually running under,
    // so a typed member naming a different account is two resolvers disagreeing
    // about one session's billing identity — unlike the node-wide default, which
    // claims nothing about this session. And I-005-5 requires the refusal to
    // ARRIVE as the typed `failed` result: a rejection escaping `resumeSession`
    // would be a second failure channel the recovery leg has no rule for.
    const harness = accountHarness();
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });
    const spawnsAfterCreate = harness.server.spawnRequests.length;

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: NODE_DEFAULT_ACCOUNT_ID,
    });

    expect(result.status).toBe("failed");
    // No second child was spawned: the refusal lands before `open()`.
    expect(harness.server.spawnRequests).toHaveLength(spawnsAfterCreate);
    // And a failed resume changes NOTHING — the predecessor is still live and
    // still bound to the account it was admitted against.
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a WARM resume that names an account while the live record bound NONE", async () => {
    // THE SAME DIVERGENCE CLASS AS THE COLD ARM, reached from the other side. A
    // warm resume relaunches under the LIVE RECORD's environment, and a record
    // whose create bound no account carries an ambient one. Honouring the typed
    // member here would report the admitted account off a binding whose child
    // authenticates as whoever that ambient environment belongs to — metadata
    // and credentials divergent, which is the shape the gate exists to refuse
    // regardless of which arm supplied the environment.
    //
    // AND IT IS A WIRING FAULT, NOT A CALLER MISTAKE, which is why it fails
    // closed rather than degrading: `ResumeSessionParams.providerAccountId` is
    // composed from the durable record and never re-resolved, so a typed member
    // naming an account while the live record names none is two records
    // disagreeing about one session.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    // A create that binds no account through EITHER channel.
    await harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    const spawnsAfterCreate = harness.server.spawnRequests.length;

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("failed");
    const detail = result.status === "failed" ? result.providerFailureDetail : "";
    expect(detail).toContain(ADMITTED_ACCOUNT_ID);
    // The unbound side is stated in words, because there is no id to print.
    expect(detail).toContain("no bound account");
    // WHICH ARM REFUSED IS ASSERTED, not assumed: the message names the live
    // record as the environment's source, and a node-wide default carrying a
    // DIFFERENT account sits beside it precisely so a cold-arm refusal here
    // would name that account instead and fail this pair.
    expect(detail).toContain("live session record");
    expect(detail).not.toContain(NODE_DEFAULT_ACCOUNT_ID);
    // No second child was spawned, and the predecessor is untouched — still
    // live, and still accountless rather than retroactively bound.
    expect(harness.server.spawnRequests).toHaveLength(spawnsAfterCreate);
    expect(await boundAccountId(harness)).toBeNull();
  });

  it("keeps a WARM resume of an accountless session accountless, never adopting the node default", async () => {
    // THE ENVIRONMENT'S ACCOUNT IS THE PROCESS CONTEXT'S OWN, NOT A FALLBACK
    // CHAIN. A warm resume relaunches under the live record's `cwd` and `env`,
    // so the account that environment was constructed for is the RECORD's — and
    // an unbound record's is nothing. Reading it as "the record's, or else the
    // node default's" would report an account whose credentials this child never
    // holds: the same divergence the refusals above close, arrived at through a
    // fallback rather than through a request. Asserted with a node default that
    // DOES carry an account, because that is the only arrangement in which the
    // two readings differ at all.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    await harness.driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result.status).toBe("resumed");
    expect(await boundAccountId(harness)).toBeNull();
  });

  it("binds a WARM resume when the typed member matches the live record's account", async () => {
    // The warm arm's positive control, and the node-wide default carries a
    // DIFFERENT account so an arm that simply reported the default would fail
    // here rather than pass by coincidence.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    const result = await harness.driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("resumed");
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });
});

// --------------------------------------------------------------------------
// The mutually-exclusive posture pair on `turn/start`
// --------------------------------------------------------------------------

describe("CodexDriver turn posture realization", () => {
  // WHAT THESE ARMS ACTUALLY CATCH, stated so the guard is not over-trusted.
  // They assert the OBSERVED WIRE FRAME, driven from
  // `UNREALIZED_TURN_POSTURE_MEMBERS` rather than from a written-out list — so a
  // composer that started emitting `permissions` fails here even if
  // `assertRealizedTurnPostureMembers` were deleted outright. What is NOT
  // asserted is the guard's PLACEMENT: nothing here proves `#requestTurnStart`
  // remains its only construction site, so a second, unguarded `turn/start`
  // composer added later would be caught by these arms only if a test drove it.
  it("realizes the sandboxPolicy member from a stamped posture and never the other", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    const params = firstParamsFor(harness, "turn/start");
    expect(params["sandboxPolicy"]).toBeDefined();
    for (const member of UNREALIZED_TURN_POSTURE_MEMBERS) {
      expect(Object.keys(params)).not.toContain(member);
    }
  });

  it("sends neither member when no posture is stamped, which is not a cardinality breach", async () => {
    // "Exactly one" is the rule for a turn that HAS a posture. A session spawned
    // without one is governed by its spawn posture, and minting a turn-level
    // member here would narrow a session the daemon left ungoverned at the turn
    // boundary. Asserted so a later tightening to a cardinality check cannot
    // pass silently.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    const params = firstParamsFor(harness, "turn/start");
    expect(Object.keys(params)).not.toContain("sandboxPolicy");
    for (const member of UNREALIZED_TURN_POSTURE_MEMBERS) {
      expect(Object.keys(params)).not.toContain(member);
    }
  });

  it("refuses every posture-affecting field a caller declares, the whole class", async () => {
    // Driven from the table rather than from a written-out list, so a field
    // added to the class without a refusal path fails here.
    const harness = createHarness();
    await createdSession(harness);

    for (const field of CALLER_DERIVED_TURN_POSTURE_FIELDS) {
      await expect(
        harness.driver.startRun({
          runId: RUN_ID,
          channelId: CHANNEL_ID,
          agentConfig: {
            sessionId: SESSION_ID,
            input: "review the diff",
            [field]: "anything at all",
          },
        }),
      ).rejects.toBeInstanceOf(CodexDriverConfigError);
    }

    // Refused BEFORE the wire, not filtered on it.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
  });

  it("refuses a declared posture field even when it restates what the daemon derived", () => {
    // The one place this differs from the `frameOrigin` precedent. A posture is
    // a decision, not a fact a caller can only be restating, and tolerating a
    // match would oblige this parse to compare postures structurally.
    expect(() =>
      parseCodexRunConfig({
        sessionId: SESSION_ID,
        input: "review the diff",
        approvalsReviewer: "user",
      }),
    ).toThrow(CodexDriverConfigError);
  });

  it("NEGATIVE CONTROL — the guard fires on the un-realized member alone", () => {
    // Without this, the wire assertions above would pass for a driver that has
    // no guard at all: they only observe that nothing today constructs the
    // member. This observes that constructing it would be caught.
    expect(() =>
      assertRealizedTurnPostureMembers({ threadId: THREAD_ID, permissions: "profile-id" }),
    ).toThrow(CodexDriverConfigError);
  });

  it("NEGATIVE CONTROL — the guard fires on the un-combinable pair sent together", () => {
    // The arm an `experimentalApi` connection accepts WITHOUT refusing, with no
    // documented precedence. It cannot be adjudicated by asking the provider,
    // so it has to be refused here.
    expect(() =>
      assertRealizedTurnPostureMembers({
        threadId: THREAD_ID,
        sandboxPolicy: { mode: "workspace-write" },
        permissions: "profile-id",
      }),
    ).toThrow(CodexDriverConfigError);
  });

  it("NEGATIVE CONTROL — the guard fires on the field that refuses -32602 at the pin", () => {
    expect(() =>
      assertRealizedTurnPostureMembers({ threadId: THREAD_ID, permissionProfile: "profile-id" }),
    ).toThrow(CodexDriverConfigError);
  });

  it("passes a params object carrying only realized members", () => {
    expect(() =>
      assertRealizedTurnPostureMembers({
        threadId: THREAD_ID,
        sandboxPolicy: { mode: "workspace-write" },
      }),
    ).not.toThrow();
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
// T3.22 — permanent-vs-transient refusal classification at the dispatch seam
// --------------------------------------------------------------------------

/** A `turn/start` refusal carrying the pin's typed `CodexErrorInfo` member. */
function typedTurnStartRefusal(codexErrorInfo: string): Record<string, unknown> {
  return {
    error: {
      code: -32600,
      // Prose the classifier must never read. It says "history" on purpose: a
      // classifier that matched text would pass this test for the wrong reason,
      // and the negative control below removes the typed member while leaving
      // this sentence in place.
      message: "Invalid request: the thread history is not acceptable",
      data: { codexErrorInfo },
    },
  };
}

/**
 * What one positional read observed, so the ORDERING can be asserted.
 *
 * The frame count at read time is the load-bearing member: it is how a test
 * proves the reconcile happened before any further send on the thread, which is
 * the property that makes the count trustworthy at all.
 */
interface RecordedParticipantTurnReads {
  readonly targetIds: string[];
  readonly turnStartFramesAtRead: number[];
}

/** Answers a fixed participant-turn count, recording what the wire held when asked. */
function countingParticipantTurnReadback(
  participantOriginatedTurns: number,
  reads: RecordedParticipantTurnReads,
  readHarness: () => ManagerHarness,
): ParticipantTurnReadbackReader {
  return (targetProviderSessionId: string) => {
    reads.targetIds.push(targetProviderSessionId);
    reads.turnStartFramesAtRead.push(readHarness().server.framesForMethod("turn/start").length);
    return Promise.resolve({ kind: "counted" as const, participantOriginatedTurns });
  };
}

describe("CodexLifecycleManager permanent structural refusal", () => {
  it("calls a permanently-refusing provider exactly ONCE and condemns the binding", async () => {
    const harness = createManagerHarness();
    let turnStartCalls = 0;
    harness.server.on("turn/start", () => {
      turnStartCalls += 1;
      return typedTurnStartRefusal("badRequest");
    });
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

    // The assertion is the CALL COUNT, because the defect being prevented is
    // expenditure: a ladder over a history the provider has typed as
    // unacceptable spends one provider request per rung and draws the identical
    // refusal every time.
    expect(turnStartCalls).toBe(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(outcome).toBeInstanceOf(PermanentStructuralRefusalError);
    expect((outcome as PermanentStructuralRefusalError).providerSessionId).toBe(THREAD_ID);
    expect((outcome as PermanentStructuralRefusalError).reconstitutionRequired).toBe(true);
    // Condemned, not merely failed: the binding is gone, so a caller cannot
    // re-dispatch onto the poisoned thread and draw the refusal again.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    const redispatch = await harness.manager
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(redispatch).toBeInstanceOf(Error);
    expect(turnStartCalls).toBe(1);
  });

  it("does NOT condemn a typed refusal that names something other than the history", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => typedTurnStartRefusal("contextWindowExceeded"));
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

    // A ceiling is not a poisoned history. Condemning the binding here would
    // cost a re-establish for a condition the next turn may not even meet.
    expect(outcome).toBeInstanceOf(CodexProviderRequestError);
    expect(outcome).not.toBeInstanceOf(PermanentStructuralRefusalError);
    expect(harness.server.killedSessions).toEqual([]);
  });

  it("reads the TYPED member and not the message — an untyped refusal stays declined", async () => {
    const harness = createManagerHarness();
    // The identical sentence the structural fixture carries, with the typed
    // member removed. Text matching would condemn here; the typed reading does
    // not, which is what makes the prohibition testable rather than asserted.
    harness.server.on("turn/start", () => ({
      error: { code: -32600, message: "Invalid request: the thread history is not acceptable" },
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

    expect(outcome).not.toBeInstanceOf(PermanentStructuralRefusalError);
    expect(harness.server.killedSessions).toEqual([]);
  });
});

describe("CodexLifecycleManager ambiguous turn/start reconciliation", () => {
  it("settles an ambiguous start DELIVERED and re-sends nothing", async () => {
    const reads: RecordedParticipantTurnReads = { targetIds: [], turnStartFramesAtRead: [] };
    // One more turn than the daemon ever acknowledged: the ambiguous start landed
    // at the provider even though its answer never came back. The reader closes
    // over the harness it is bound into, which is only ever CALLED after the
    // constructor returned.
    const built: ManagerHarness = createManagerHarness({
      participantTurnReadback: countingParticipantTurnReadback(1, reads, () => built),
    });
    built.server.uniqueSpawnSessionIds = true;
    // Unanswered on purpose: the deadline is the only way this settles, and it is
    // exactly the case the provider may nonetheless have ACCEPTED.
    await built.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const starting = built.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const failure = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    built.scheduler.fireAll();
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);

    // Read against the thread, once, and BEFORE anything else could reach the
    // wire — the reconcile-before-send ordering the count depends on.
    expect(reads.targetIds).toEqual([THREAD_ID]);
    expect(reads.turnStartFramesAtRead).toEqual([1]);
    // ZERO duplicate turns: the landed turn is unaddressable, so the session is
    // disposed and a re-dispatch cannot put a second copy of it on the wire.
    expect(built.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(built.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    const redispatch = await built.manager
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(redispatch).toBeInstanceOf(Error);
    expect(built.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  it("CLEARS an ambiguous start for retry when the target proves nothing landed", async () => {
    const reads: RecordedParticipantTurnReads = { targetIds: [], turnStartFramesAtRead: [] };
    // The thread holds exactly what the daemon already knows about, so the
    // ambiguous start never landed and a re-dispatch duplicates nothing.
    const harness: ManagerHarness = createManagerHarness({
      participantTurnReadback: countingParticipantTurnReadback(0, reads, () => harness),
    });
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

    expect(reads.turnStartFramesAtRead).toEqual([1]);
    // The transient arm: the session is LEFT LIVE, so the caller's re-dispatch
    // costs no re-establish and reaches the same process.
    expect(harness.server.killedSessions).toEqual([]);
    expect(harness.server.closedSessions).toEqual([]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
    expect(harness.server.spawnRequests).toHaveLength(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
  });

  it("fails visibly and sends NOTHING when the target cannot be read back", async () => {
    let reads = 0;
    const harness = createManagerHarness({
      participantTurnReadback: () => {
        reads += 1;
        return Promise.resolve({ kind: "unreadable" as const, reason: "no turn read on this pin" });
      },
    });
    harness.server.uniqueSpawnSessionIds = true;
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

    // A FAILED settlement, never a silent success — and zero re-sends beside it.
    // Neither silent option is admissible: a re-send risks duplicate spend and an
    // assumed delivery suppresses the participant's request.
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);
    expect(reads).toBe(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("treats a THROWING participant-turn reader as an unreadable target", async () => {
    const harness = createManagerHarness({
      participantTurnReadback: () => Promise.reject(new Error("read failed")),
    });
    harness.server.uniqueSpawnSessionIds = true;
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

    // The caller is owed the settlement it can classify, not the reader's own
    // exception standing in for one.
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
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

  it("refuses a later steer against a binding a text-neutralization trip disposed", async () => {
    // The assertion that separates FAILED THE RUN from QUARANTINED THE PROCESS.
    // A trip retires the route as well as disposing the binding, so without the
    // quarantine check this steer would fail with "no active turn" — a
    // plausible wrong cause that reads as a race and invites a retry into the
    // process that already swallowed the participant's words.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "participant_text",
      },
    });

    // A settled turn carrying no model output and no declared failure: the
    // provider reported success for a turn that never reached a model.
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await Promise.resolve();

    await expect(
      harness.manager.steerRun({
        runId: RUN_ID,
        content: "actually, stop",
        clientIdempotencyKey: "steer-after-trip",
        frameOrigin: "participant_text",
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
    await expect(harness.manager.interruptRun({ runId: RUN_ID })).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("trips when the swallowed turn terminates in the SAME read chunk as its start response", async () => {
    // The interleave that beat the tripwire before the unmatched-turn memory
    // carried evidence. The `turn/start` response resolves `startRun` as a
    // MICROTASK, but `#ingest` drains the rest of the chunk SYNCHRONOUSLY — so
    // the terminal settles a turn no frame is correlated with yet, and the
    // re-key that moves the opening frame onto the turn id runs afterwards,
    // against a settlement that has already gone by. A memory holding only turn
    // ids retires the route and reports the swallowed turn as a completed one.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [zeroTurnCompletedFrame(TURN_ID)],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "participant_text",
      },
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: SESSION_ID,
        runId: RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      },
    ]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(true);
  });

  it("does not trip a REAL turn that terminates in the same read chunk with an unloaded item list", async () => {
    // The negative control for the test above, and the only one that proves the
    // remembered evidence is load-bearing rather than decoration. This provider
    // can settle a turn with an EMPTY item list — `itemsView: "notLoaded"` — so a
    // memory that kept only the terminal would rule this real turn evidence-free
    // and fail it. The in-flight `item/completed` is the evidence, and it arrives
    // in the same chunk, before any frame is correlated with the turn.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [modelOutputItemFrame(TURN_ID), zeroTurnCompletedFrame(TURN_ID)],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
    // Still retired: the turn ended, whatever it produced.
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("refuses a later run on the SESSION a trip disposed, not only the run that was on it", async () => {
    // A run-keyed quarantine cannot reach this: `startRun` resolves a SESSION,
    // so the surviving record would hand the next run straight back to the
    // process that swallowed the participant's words. The refusal names the
    // neutralization rather than a transport fault, so one cause reads as one
    // cause.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await Promise.resolve();

    const writtenLinesAfterTrip = harness.server.writtenLines.length;
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
    // Refused BEFORE the provider was asked anything: a refusal that still sent
    // a `turn/start` would have reached the condemned process.
    expect(harness.server.writtenLines).toHaveLength(writtenLinesAfterTrip);
  });

  it("lets a fresh spawn under the same session id run again after a trip", async () => {
    // The quarantine names a BINDING, not an identifier. The promised recovery
    // is a fresh process, so a refusal that outlived the process it condemned
    // would refuse the recovery itself.
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    // The trip's teardown is DETACHED — it runs inside the read-chunk drain and
    // must not be awaited there — so the slot reads `closing` until it settles.
    // A create in that window is refused as it is for every other disposal, so
    // the recovery this test is about begins once the condemned child is gone.
    await drainMicrotasks();

    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("passes a steer on its acknowledgment when no item follows it", async () => {
    // A turn carries many frames, and each keeps its own correlation state. The
    // provider's typed answer to `turn/steer` is the transport's statement
    // that it TOOK the steer — the only per-frame attribution it produces —
    // so a steer taken near the turn's end, with no item after it, passes
    // rather than tripping a healthy session. Every item-based substitute got
    // a polarity wrong: keying the store by turn let pre-steer output vouch a
    // swallowed steer, and crediting the oldest-unevidenced frame both tripped
    // this delivered steer AND let the opener's delayed item vouch a swallowed
    // one. The coverage boundary is a conjunction stated in the tripwire's
    // attribution rule (an answer proves receipt, not the model reading the
    // text) — the detectable swallow shapes are the UNANSWERED ones (the
    // timeout and dead-connection tests below) and the unrecognized
    // settlement, which outranks any answer.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    // The opening frame's own evidence, observed BEFORE the steer is written.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    // Every item the terminal carries PRECEDES the steer. The acknowledgment
    // alone rules the steer; the items rule the opener.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
  });

  it("follows a steer's frame onto the turn the provider ACKNOWLEDGED, not the one targeted", async () => {
    // The acknowledgement is the provider's own statement about where the bytes
    // went, and its answered request is what the steer is consumed on — so
    // wherever the frame sits, the recorded answer is what rules it. The move itself is
    // correlation hygiene: the frame is consumed by the settlement of the turn
    // that actually took it rather than lingering on one it provably did not
    // enter (the frame-scoped move semantics are pinned at the tripwire unit
    // level). What this test holds is the integration contract: the mismatch
    // is returned to the dispatcher for degraded grading (P3-1), no turn trips
    // over it, and the binding is not condemned.
    const acknowledgedTurnId = "turn-acknowledged";
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: acknowledgedTurnId } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    // The opening frame's own evidence, observed BEFORE the steer is written, so
    // it vouches for that frame and for no other.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const acknowledgement = await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "participant_text",
    });
    expect(acknowledgement).toStrictEqual({
      targetedTurnId: TURN_ID,
      acknowledgedTurnId,
    });

    // The targeted turn ends carrying only the items that preceded the steer.
    // Its opening frame is vouched for, and the steer's frame is not its to rule.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
    expect(harness.textNeutralizationFailures).toStrictEqual([]);

    // The ACKNOWLEDGED turn settles with nothing of its own — and the moved
    // steer, carrying its recorded acknowledgment, passes there rather than
    // tripping a delivery the provider attested. The binding stays usable.
    harness.server.emitFrame(zeroTurnCompletedFrame(acknowledgedTurnId));
    await drainMicrotasks();
    expect(harness.manager.textNeutralizationDecisionForTurn(acknowledgedTurnId).refused).toBe(
      false,
    );
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: "turn-after-steer" } } }));
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps a null-acked steer on the targeted turn and rules it on the acknowledgment", async () => {
    // The other arm, and the reason the move is conditional: an ack naming no
    // turn disproves nothing about where the bytes went, so moving the frame
    // would abandon the only correlation there is evidence for. Naming no turn
    // weakens the correlation, never the delivery: the answered request is
    // still the provider's typed statement that it took the bytes, so the
    // steer passes at the targeted turn's settlement — the dispatcher already
    // grades the null ack degraded rather than applied (P3-1), which is where
    // that weakness is reported.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const acknowledgement = await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "participant_text",
    });
    expect(acknowledgement).toStrictEqual({
      targetedTurnId: TURN_ID,
      acknowledgedTurnId: null,
    });

    // Every item on the terminal precedes the steer; the recorded
    // acknowledgment is what rules it, and it rules it a pass.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
  });

  it("consumes a steer's frame on its ack when the acknowledged turn settled in the SAME read chunk", async () => {
    // The move the acknowledgement asks for is only safe onto a turn that can
    // still rule something. A terminal sharing the steer response's read chunk
    // is drained SYNCHRONOUSLY, so it goes by before this steer's continuation
    // runs — and a frame moved onto it afterwards would wait for a second
    // terminal that is never coming, dropping as occupancy. The refusal to
    // move stands; what changed is the ruling: the answered request already
    // proved receipt, so the frame is consumed on its own answer rather than
    // tripped — condemning the session over a receipt the provider just
    // attested contradicted the attribution rule that consumes every other
    // answered steer. The mismatch stays visible through
    // the dispatcher's degraded grading (P3-1).
    const acknowledgedTurnId = "turn-acknowledged";
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({
      result: { turnId: acknowledgedTurnId },
      trailingFrames: [zeroTurnCompletedFrame(acknowledgedTurnId)],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    // Vouches for the OPENING frame and for no other, so a trip here names the
    // steer's frame rather than merely some frame on the session.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const acknowledgement = await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    // The acknowledgement is still a fact and is still returned: the ruling is a
    // second act beside it, not a replacement for the driver's answer.
    expect(acknowledgement).toStrictEqual({ targetedTurnId: TURN_ID, acknowledgedTurnId });
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    // The targeted turn still settles clean on its opener's own evidence, and
    // the binding is NOT condemned: the next run dispatches onto it.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: "turn-after-steer" } } }));
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("consumes a steer's frame on its ack when the acknowledged turn AGED OUT of the settled memory", async () => {
    // The same window as the read-chunk case above, reached by ageing instead
    // of by ordering. The settled memory is bounded, and the acknowledgement
    // continuation reads ABSENCE from it as "that turn can still rule this
    // frame" — so a burst of terminals arriving in the steer response's own
    // chunk used to push the acknowledged turn's own settlement out, and the
    // frame was moved onto a turn no second terminal was ever coming for,
    // sitting as occupancy until the scope was released. The `inFlightSteers`
    // pin keeps the settlement readable across the round trip, so the
    // continuation refuses the move and consumes the frame on its own
    // acknowledgment instead of leaking it.
    //
    // The burst rides `trailingFrames`, which is ONE read chunk with the
    // response, so every one of these drains synchronously before the
    // continuation resumes — the ordering that makes the eviction reachable.
    // Seventy: comfortably past the memory's unpinned bound of 64, so a
    // size-based prune would certainly have reached the acknowledged turn's own
    // settlement, and comfortably under the pinned ceiling of 256, so this is
    // the eviction case rather than the overflow refusal beside it.
    const acknowledgedTurnId = "turn-acknowledged";
    const burstTurnIds: readonly string[] = Array.from(
      { length: 70 },
      (_unused, index) => `turn-burst-${String(index)}`,
    );
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({
      result: { turnId: acknowledgedTurnId },
      trailingFrames: [
        zeroTurnCompletedFrame(acknowledgedTurnId),
        ...burstTurnIds.map((burstTurnId) => turnCompletedFrame(burstTurnId, "completed")),
      ],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    // Vouches for the OPENING frame and for no other, so a trip here names the
    // steer's frame rather than merely some frame on the session.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const acknowledgement = await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    expect(acknowledgement).toStrictEqual({ targetedTurnId: TURN_ID, acknowledgedTurnId });
    await drainMicrotasks();

    // The premise, asserted rather than assumed: this stayed under the ceiling,
    // so the trip below is the ageing guard's and not the overflow refusal's.
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "settled-turn-memory-overflowed",
      ),
    ).toHaveLength(0);

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    // The targeted turn still settles clean on its opener's own evidence, and
    // the binding is NOT condemned: the next run dispatches onto it.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: "turn-after-steer" } } }));
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses the binding when the settled memory overflows during a steer", async () => {
    // The ceiling, and the reason the pin needs one: a burst past it cannot be
    // admitted beside entries the continuation may be about to read, and
    // evicting one to make room would answer "still running" for a turn that
    // ended. So the driver refuses rather than choosing which settlement to
    // forget — the same prune-then-refuse-and-never-evict answer the evidence
    // memory gives — and the teardown rules the steer's own pending frame
    // fail-closed on the way out.
    // Three hundred, past the pinned ceiling of 256, matching the figure the
    // evidence memory's own overflow test drives its refusal with.
    const acknowledgedTurnId = "turn-acknowledged";
    const burstTurnIds: readonly string[] = Array.from(
      { length: 300 },
      (_unused, index) => `turn-burst-${String(index)}`,
    );
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({
      result: { turnId: acknowledgedTurnId },
      trailingFrames: burstTurnIds.map((burstTurnId) =>
        turnCompletedFrame(burstTurnId, "completed"),
      ),
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    await drainMicrotasks();

    // Named as its OWN overflow rather than the evidence memory's: an operator
    // reading either needs to know which memory could not hold.
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "settled-turn-memory-overflowed",
      ),
    ).toHaveLength(1);
    // Loud on the run, not merely diagnosed: the refusal rules every frame the
    // departing binding was carrying, the steer's included.
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.runId).toBe(RUN_ID);
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("consumes a steer acked onto a turn that already ended, on the acknowledgment itself", async () => {
    // The acknowledged turn ended before the steer was written, so no second
    // terminal is coming for it and the move is refused. The frame is ruled
    // here — on its own recorded acknowledgment, not on the settled turn's
    // recorded outcome and not fail-closed. Not inherited, because that turn's
    // output predates the directive and vouches for nothing; not tripped,
    // because the answered request is the provider's own typed statement that
    // it took the bytes, and the attribution rule that accepts that statement
    // on the live-destination path does not stop holding because the
    // destination finished first. The oddity of the ack itself — a provider
    // naming a turn it had already ended — reaches the caller through the
    // dispatcher's degraded grading of the mismatch (P3-1).
    const acknowledgedTurnId = "turn-acknowledged";
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: acknowledgedTurnId } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    // The acknowledged turn ends BEFORE the steer is written, carrying a model
    // message of its own.
    harness.server.emitFrame(turnCompletedFrame(acknowledgedTurnId, "completed"));
    await drainMicrotasks();
    expect(harness.textNeutralizationFailures).toStrictEqual([]);

    await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    // And the frame did not linger on the TARGETED turn either: its settlement
    // finds only the opener, vouched by its own item.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
  });

  it("rules a steer's frame where it was registered when the TARGET settles in one chunk", async () => {
    // The no-turn-named arm's own ordering hazard, and the reason it needs no
    // guard: the frame is registered on the targeted turn BEFORE the bytes go
    // out, so a terminal sharing the response's chunk finds it correlated and
    // rules it in the ordinary place. A regression pin on that registration
    // rather than on anything the acknowledgement path does.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame(TURN_ID, "completed")],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const acknowledgement = await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    expect(acknowledgement).toStrictEqual({ targetedTurnId: TURN_ID, acknowledgedTurnId: null });
    await drainMicrotasks();

    // Every item the terminal carries precedes the steer, so the opening frame
    // is vouched for and the steer's is the one that trips.
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(true);
  });

  it("does not trip the opening frame when a legitimate steer settles with an unloaded item list", async () => {
    // The other polarity, and the one a per-frame store must not lose: every
    // frame on the turn produced output, and the terminal simply did not carry
    // the item list. Nothing here may fail.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();
    await harness.manager.steerRun({
      runId: RUN_ID,
      content: "also check the tests",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "participant_text",
    });
    // Answered after the steer, so it is attributable to the steer.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
  });

  it("drops the frame of a steer the provider ANSWERED with an error", async () => {
    // A provider error is an answer, and an answer is proof the provider read
    // the directive and declined it — so it started no turn and swallowed
    // nothing. Left registered, the frame would be ruled evidence-free by the
    // turn's own terminal and trip: a run failed and a provider session disposed
    // over text the provider demonstrably did not act on. Frame-scoped, so the
    // opening frame stays correlated and still gets ruled.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({
      error: { code: -32600, message: "no active turn" },
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    await expect(
      harness.manager.steerRun({
        runId: RUN_ID,
        content: "also check the tests",
        clientIdempotencyKey: "steer-1",
        frameOrigin: "participant_text",
      }),
    ).rejects.toThrow();
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("drops the frame of a steer refused before its write ever reached the host", async () => {
    // The other provably-unsent arm, and the one whose failure looks IDENTICAL
    // to a mid-flight death from the caller's side: the connection refuses ahead
    // of the write and raises the same transport error class, with near-identical
    // text, that an exit raises for a request already on the wire. Classified at
    // the transport, this one is known to have put no byte anywhere, so the
    // frame is dropped and nothing trips. Misread as merely-unknown delivery, it
    // would trip here — the connection is closed — and fail a run over a
    // directive the provider was never sent.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();
    // Kills the transport without touching the manager's record, so the steer
    // still reaches the write path and is refused there rather than upstream.
    harness.server.emitExit(1);
    await drainMicrotasks();

    await expect(
      harness.manager.steerRun({
        runId: RUN_ID,
        content: "also check the tests",
        clientIdempotencyKey: "steer-1",
        frameOrigin: "system_narration",
      }),
    ).rejects.toThrow();
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
  });

  it("keeps the frame of a steer that timed out after its bytes were written", async () => {
    // The unsafe case. The write SUCCEEDED and the provider simply never
    // answered: it may have taken the command-shaped directive, intercepted it
    // client-side, and be on its way to a zero-turn success — the rejection the
    // caller sees carries no information either way. Withdrawing the frame here
    // is exactly how a swallowed directive escapes, because the turn's terminal
    // would then rule only the opening frame, which was answered and observed.
    // Retained instead, the terminal rules the steer on its own merits.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    // `turn/steer` is deliberately NOT registered: the fake writes the line and
    // answers nothing, which is the shape of an intercepted directive.
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    // The opening frame's own evidence, observed BEFORE the steer is written, so
    // the opening frame passes on its own account and only the steer is at issue.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const steer = harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      // A different origin from the opening frame's, so the recorded detail
      // names WHICH frame the turn failed to account for.
      frameOrigin: "system_narration",
    });
    await drainMicrotasks();
    // The line is on the wire before the deadline fires: this is a post-write
    // failure, not a refusal.
    expect(harness.server.framesForMethod("turn/steer")).toHaveLength(1);
    harness.scheduler.fireAll();
    await expect(steer).rejects.toBeInstanceOf(CodexRequestTimeoutError);

    // Every item this terminal carries PRECEDES the steer, so none of them is
    // evidence for it.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
    // And the binding the swallow was observed on is condemned, not reused.
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("rules a steer whose write died with the connection instead of releasing it", async () => {
    // Retention alone cannot cover this one: the connection is gone, so the turn
    // the frame joined will never settle and no terminal will ever rule it. Left
    // pending, it would sit until the scope's budget was reclaimed and then be
    // dropped as pure occupancy — silence in the case that most warrants an
    // answer, since the provider may already have swallowed the directive.
    // Ruled fail-closed here, and ruled FRAME-scoped: settling the whole turn
    // would also trip the opening frame, whose request was answered and whose
    // delivery was therefore never in doubt.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();
    // Kills the child mid-write and then fails that write: the bytes were handed
    // to the host, and how many of them reached the child is unknowable.
    harness.server.failWriteAfterChildExit = true;
    // Baseline, so the kill asserted below is attributable to THIS teardown.
    expect(harness.server.killedSessions).toStrictEqual([]);

    await expect(
      harness.manager.steerRun({
        runId: RUN_ID,
        content: "/clear and start over",
        clientIdempotencyKey: "steer-1",
        frameOrigin: "system_narration",
      }),
    ).rejects.toThrow(/broken pipe/);
    await drainMicrotasks();

    // The steer's own origin, so the report names the frame whose delivery was
    // in doubt rather than the opening frame that was answered.
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
    expect(harness.textNeutralizationFailures[0]?.runId).toBe(RUN_ID);
    // Disposed, not merely refused: the promised recovery is a fresh spawn. The
    // follow-up call below spawns again, so this is asserted first.
    expect(harness.server.killedSessions).toHaveLength(1);
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("reports a trip on the run whose route an interrupt had already retired", async () => {
    // `turn/interrupt` resolves when the provider ACCEPTS the interrupt, not
    // when the turn ends — `turn/completed` still follows. The route is retired
    // at acceptance, correctly, so that the run stops reporting an active turn;
    // but the tripwire is ruled on the terminal. Without a correlation that
    // survives that gap the trip quarantines the session and the process while
    // the run's own subscribers hear nothing at all.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "participant_text",
      },
    });
    await harness.manager.interruptRun({ runId: RUN_ID });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);

    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: SESSION_ID,
        runId: RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      },
    ]);
    // And the session arm too: the run failure alone would leave the next run
    // free to resolve this record by session id and dispatch into the process
    // that swallowed the participant's words.
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("releases the retained interrupt correlation once its terminal has been ruled", async () => {
    // The correlation is retained only until the ruling it is owed. A duplicate
    // terminal for the same turn — which this provider can send after an
    // interrupt — must not be reported a second time, and a benign one must
    // release the entry exactly as a trip does.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "participant_text",
      },
    });
    await harness.manager.interruptRun({ runId: RUN_ID });

    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toHaveLength(1);
  });

  it("does not trip an interrupted turn whose terminal carries model output", async () => {
    // The negative control. A retained correlation must not become a second
    // route that fails an ordinary interrupted turn — the overwhelmingly common
    // case, where a participant simply stopped a run that was working.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();
    await harness.manager.interruptRun({ runId: RUN_ID });

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "interrupted"));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    // The binding is untouched, so the session takes the next run.
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a run this session is already holding too many unwatched frames for", async () => {
    // The capacity refusal, end to end on this leg, and the bound the retained
    // interrupt correlations inherit: every retained correlation is backed by a
    // frame the tripwire is still holding, so the outstanding-interrupt set can
    // never outgrow this session's watch budget.
    //
    // Refusing is the honest answer. Admitting the write and evicting the oldest
    // registration to make room means that turn later settles against nothing
    // and PASSES, which is the swallowed turn reported as a completed one.
    const harness = createManagerHarness();
    let nextTurnOrdinal = 0;
    harness.server.on("turn/start", () => {
      nextTurnOrdinal += 1;
      return { result: { turn: { id: `turn-${String(nextTurnOrdinal)}` } } };
    });
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const interruptedRunIds: RunId[] = [];
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      const runId = `44444444-4444-4444-8444-${String(index).padStart(12, "0")}` as RunId;
      interruptedRunIds.push(runId);
      await harness.manager.startRun({
        runId,
        channelId: CHANNEL_ID,
        agentConfig: {
          sessionId: SESSION_ID,
          input: "/status please",
          frameOrigin: "participant_text",
        },
      });
      // Interrupted and never terminated, so every frame stays unsettled and
      // every correlation stays retained.
      await harness.manager.interruptRun({ runId });
    }

    const writtenLinesBeforeRefusal = harness.server.writtenLines.length;
    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "one more" },
      }),
    ).rejects.toThrow(OutboundFrameCapacityRefusedError);
    // Refused BEFORE any byte reached the provider: a frame written past the
    // tripwire's reach is precisely the frame no turn can be ruled against.
    expect(harness.server.writtenLines).toHaveLength(writtenLinesBeforeRefusal);

    // Nothing was discarded to make room — every one of the interrupted turns is
    // still watched, and each still reports on its own run when it settles.
    for (let index = 0; index < interruptedRunIds.length; index += 1) {
      harness.server.emitFrame(zeroTurnCompletedFrame(`turn-${String(index + 1)}`));
    }
    await drainMicrotasks();
    expect(harness.textNeutralizationFailures.map((failure) => failure.runId)).toStrictEqual(
      interruptedRunIds,
    );
  });

  it("refuses the binding when stale interrupt correlations reach the route-memory ceiling", async () => {
    // The one reachable road to the ceiling: an interrupt whose continuation
    // resumes after its turn's terminal drained AND after enough further
    // terminals pruned that turn's id out of the settled memory — the settled
    // gate then reads absence, records a correlation nothing will ever release,
    // and stale entries accumulate toward the ceiling. At it the driver refuses
    // rather than evicting, because a live correlation evicted to make room is
    // a terminal ruled against no run.
    const harness = createManagerHarness();
    let nextTurnOrdinal = 0;
    let currentTurnId = "";
    harness.server.on("turn/start", () => {
      nextTurnOrdinal += 1;
      currentTurnId = `turn-${String(nextTurnOrdinal)}`;
      return { result: { turn: { id: currentTurnId } } };
    });
    harness.server.on("turn/interrupt", () => ({
      result: {},
      // The turn's own benign terminal, then a burst that prunes its id out of
      // the settled memory before the interrupt continuation resumes.
      trailingFrames: [
        turnCompletedFrame(currentTurnId, "completed"),
        ...Array.from({ length: 64 }, (_unused, index) =>
          turnCompletedFrame(`${currentTurnId}-prune-${String(index)}`, "completed"),
        ),
      ],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    for (let index = 0; index < 65; index += 1) {
      const runId = `77777777-7777-4777-8777-${String(index).padStart(12, "0")}` as RunId;
      await harness.manager.startRun({
        runId,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });
      harness.server.emitFrame(modelOutputItemFrame(`turn-${String(index + 1)}`));
      await Promise.resolve();
      await harness.manager.interruptRun({ runId });
      await drainMicrotasks();
    }

    const overflowDiagnostics = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "interrupted-route-memory-overflowed",
    );
    expect(overflowDiagnostics).toHaveLength(1);
    expect(overflowDiagnostics[0]).toMatchObject({ retainedTurnCount: 64 });
    // The refusal condemned the binding: nothing later runs on it.
    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow();
  });

  it("records nothing for an interrupt whose turn had already settled in the same chunk", async () => {
    // The settled gate, driven at the same seam as the refusal above but with
    // the prune burst absent: presence in the settled memory is proof the
    // terminal this correlation would route has already arrived and been ruled,
    // so nothing is recorded and nothing accumulates. Sixty-five of these —
    // one past the ceiling — leave the session healthy, where recording each
    // one would have refused the binding on the sixty-fifth.
    const harness = createManagerHarness();
    let nextTurnOrdinal = 0;
    let currentTurnId = "";
    harness.server.on("turn/start", () => {
      nextTurnOrdinal += 1;
      currentTurnId = `turn-${String(nextTurnOrdinal)}`;
      return { result: { turn: { id: currentTurnId } } };
    });
    harness.server.on("turn/interrupt", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame(currentTurnId, "completed")],
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    for (let index = 0; index < 65; index += 1) {
      const runId = `88888888-8888-4888-8888-${String(index).padStart(12, "0")}` as RunId;
      await harness.manager.startRun({
        runId,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });
      harness.server.emitFrame(modelOutputItemFrame(`turn-${String(index + 1)}`));
      await Promise.resolve();
      await harness.manager.interruptRun({ runId });
      await drainMicrotasks();
    }

    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "interrupted-route-memory-overflowed",
      ),
    ).toHaveLength(0);
    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("returns a closed session's watch budget, so a fresh spawn under the id runs", async () => {
    // The scope's budget is reclaimed where the record is provably gone. Without
    // it, a session whose turns never settled would hold its own budget for the
    // daemon's lifetime and refuse every later run on that id — a leak that
    // presents as a permanently unusable session rather than as memory.
    const harness = createManagerHarness();
    let nextTurnOrdinal = 0;
    harness.server.on("turn/start", () => {
      nextTurnOrdinal += 1;
      return { result: { turn: { id: `turn-${String(nextTurnOrdinal)}` } } };
    });
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      const runId = `66666666-6666-4666-8666-${String(index).padStart(12, "0")}` as RunId;
      await harness.manager.startRun({
        runId,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });
      await harness.manager.interruptRun({ runId });
    }

    await harness.manager.closeSession({ sessionId: SESSION_ID });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

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
      params: {
        threadId: THREAD_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", id: "item-1" }],
        },
      },
    });
  });

  it("keeps watching a concurrent attempt's frame when an overlapping start is refused", async () => {
    // Nothing serializes two starts for one run, and a frame is registered under
    // the RUN id until the provider names a turn — so both attempts are
    // correlated to the SAME key while either is in flight. A failure that drops
    // the whole key takes the live attempt's frame with it, and a turn that
    // settles against no correlated frame PASSES: the swallowed turn reported as
    // a completed one, which is the outcome the tripwire exists to catch.
    const refusedOpeningText = "the attempt the provider rejects";
    const harness = createManagerHarness();
    harness.server.on("turn/start", (params) =>
      readTurnStartInputText(params) === refusedOpeningText
        ? { error: { code: -32602, message: "input rejected" } }
        : { result: { turn: { id: TURN_ID } } },
    );
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    // The handler is attached synchronously, before anything is awaited: an
    // unattached rejection is decided unhandled on the next full microtask drain.
    const refused = harness.manager
      .startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: refusedOpeningText },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // Registered while the first attempt is still suspended on its own request,
    // which is the only window in which the overlap exists at all.
    const accepted = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    // A CLEAN refusal: the provider answered "no", so nothing is disposed and
    // the session the second attempt is running on stays live.
    expect(await refused).toBeInstanceOf(CodexProviderRequestError);
    expect(harness.server.killedSessions).toEqual([]);
    await accepted;

    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    // One trip, on the turn the SURVIVING attempt opened. Zero trips would be
    // the key-wide drop that silenced a live frame.
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(true);
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=participant_text",
    );
  });

  it("rules each of two overlapping accepted starts on the turn IT opened", async () => {
    // The other half of the overlap: both attempts are ACCEPTED, and each is
    // answered with a turn id of its own. Correlation is per FRAME because the
    // join key cannot separate them — every attempt on this run registers under
    // the same run id — so a key-wide re-key would carry the second attempt's
    // frame onto the first attempt's turn, and the second attempt would then
    // find nothing left under the run id and move nothing. Its own turn would
    // settle against no correlated frame, and that PASSES: the swallowed turn
    // reported as a completed one.
    const firstOpeningText = "the attempt answered first";
    const firstTurnId = "turn-overlap-a";
    const secondTurnId = "turn-overlap-b";
    const harness = createManagerHarness();
    harness.server.on("turn/start", (params) => ({
      result: {
        turn: {
          id: readTurnStartInputText(params) === firstOpeningText ? firstTurnId : secondTurnId,
        },
      },
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const first = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: firstOpeningText },
    });
    const second = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    await first;
    await second;

    // The SECOND attempt's turn swallows its text. Its frame has to be the one
    // ruled here, and it is reachable only if the re-key moved that frame alone.
    harness.server.emitFrame(zeroTurnCompletedFrame(secondTurnId));
    await drainMicrotasks();

    expect(harness.manager.textNeutralizationDecisionForTurn(secondTurnId).refused).toBe(true);
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=participant_text",
    );
    // The first attempt's frame stayed on ITS turn: still unsettled, still owed
    // a ruling, and not consumed by the turn beside it.
    expect(harness.manager.textNeutralizationDecisionForTurn(firstTurnId).refused).toBe(false);
  });

  it("reports the run when the OLDER of two overlapping turns swallows its text", async () => {
    // The correlation half of the overlap. Both attempts are accepted, so the
    // session carries two live turns for one run — and the turn that swallows is
    // the one that started FIRST. A routing table that could hold one turn per
    // run had already replaced the first turn's entry with the second's by then,
    // so the terminal matched no route: the trip quarantined the session and the
    // run itself was told nothing at all. Routes are keyed by turn precisely so
    // the ruling reaches the run that wrote the words.
    const firstOpeningText = "the attempt answered first";
    const firstTurnId = "turn-older-swallows-a";
    const secondTurnId = "turn-older-swallows-b";
    const harness = createManagerHarness();
    harness.server.on("turn/start", (params) => ({
      result: {
        turn: {
          id: readTurnStartInputText(params) === firstOpeningText ? firstTurnId : secondTurnId,
        },
      },
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const first = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: firstOpeningText },
    });
    const second = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    await first;
    await second;

    harness.server.emitFrame(zeroTurnCompletedFrame(firstTurnId));
    await drainMicrotasks();

    // The run heard it. This is the assertion the overwrite silenced.
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.runId).toBe(RUN_ID);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=participant_text",
    );
    expect(harness.manager.textNeutralizationDecisionForTurn(firstTurnId).refused).toBe(true);
    // And the second turn's frame was RULED as the condemned binding went away
    // rather than discarded with it. No second report: the run had already been
    // failed by the ruling that condemned the session, and one cause is owed one
    // terminal — but the frame was accounted for, which is what the count says.
    expect(harness.diagnostics).toContainEqual({
      kind: "abandoned-frames-ruled",
      ruledFrameCount: 1,
      reportedRunCount: 0,
    });
    expect(harness.textNeutralizationFailures).toHaveLength(1);
    // The process the swallow happened on is gone, and the session refuses.
    expect(harness.server.killedSessions).toHaveLength(1);
  });

  it("keeps a run's older live turn steerable after its newest is interrupted", async () => {
    // The other side of per-turn routing: retiring one turn's route must not
    // retire the run's session binding while another of its turns is still
    // running. A run-keyed retirement dropped both in one act, so the surviving
    // turn became unreachable — every intervention on it answered "no active
    // turn" while the provider went on working.
    const firstOpeningText = "the attempt answered first";
    const firstTurnId = "turn-interrupt-survivor-a";
    const secondTurnId = "turn-interrupt-survivor-b";
    const harness = createManagerHarness();
    harness.server.on("turn/start", (params) => ({
      result: {
        turn: {
          id: readTurnStartInputText(params) === firstOpeningText ? firstTurnId : secondTurnId,
        },
      },
    }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    harness.server.on("turn/steer", () => ({ result: { turn: { id: firstTurnId } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const first = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: firstOpeningText },
    });
    const second = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    await first;
    await second;

    // The interrupt names the NEWEST turn, so the older one survives it.
    await harness.manager.interruptRun({ runId: RUN_ID });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);

    // Reachable, and reached on the turn that is still live.
    await harness.manager.steerRun({
      runId: RUN_ID,
      content: "narrow the diff to the parser",
      clientIdempotencyKey: "steer-survivor",
      frameOrigin: "participant_text",
    });
    expect(harness.server.framesForMethod("turn/steer")[0]?.["params"]).toMatchObject({
      expectedTurnId: firstTurnId,
    });
  });

  it("refuses the binding rather than evicting a terminal a pending start is owed", async () => {
    // The evidence memory's hazard, driven from the one direction that reaches
    // it: ONE read chunk. The whole chunk drains synchronously while the
    // `turn/start` continuation waits as a microtask, so every turn the provider
    // mentions in it lands in the unmatched memory before the run that is about
    // to claim one of them gets to run. Oldest-first eviction discards the head
    // of that chunk — which is this run's OWN terminal, the zero-turn reply that
    // says its opening words were swallowed — and the continuation then installs
    // a live route and a re-keyed frame whose only terminal has already gone by.
    // Nothing would ever rule it. Evidence is not traded for room: the session is
    // refused instead, and the run with it.
    const swallowedRunTurnId = "turn-drain-overflow-owed";
    const chatter: Array<Record<string, unknown>> = [
      // FIRST in the chunk, so it is the first entry eviction would reach.
      zeroTurnCompletedFrame(swallowedRunTurnId),
    ];
    for (let index = 0; index < 300; index += 1) {
      chatter.push(turnCompletedFrame(`turn-drain-overflow-chatter-${index}`, "completed"));
    }
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: swallowedRunTurnId } },
      trailingFrames: chatter,
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const started = harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    // The run is REFUSED. Silently evicting instead resolved this call and left
    // the daemon believing a turn was running on a session that had swallowed
    // its opening words.
    await expect(started).rejects.toThrow(CodexTransportError);
    await drainMicrotasks();

    const overflows = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "turn-evidence-memory-overflowed",
    );
    // Exactly one, though hundreds of frames followed the refusal in that same
    // chunk: the binding is condemned once and the rest of the drain is quiet.
    expect(overflows).toHaveLength(1);
    expect(harness.server.killedSessions).toHaveLength(1);
    // And the session refuses every later resolution, so the recovery is a fresh
    // spawn rather than a retry into the process whose account was lost.
    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "try again" },
      }),
    ).rejects.toThrow();
  });

  it("evicts the evidence memory freely once no start can claim from it", async () => {
    // The other half of the policy, and the reason the refusal above is not just
    // a smaller cap: with no `turn/start` in flight, NOTHING can ever claim an
    // entry — turn ids are never reused, so a later start cannot match one — and
    // eviction there is provably free. A session that hears about hundreds of
    // turns it never started stays live and stays usable.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    for (let index = 0; index < 300; index += 1) {
      harness.server.emitFrame(
        turnCompletedFrame(`turn-unclaimable-chatter-${index}`, "completed"),
      );
    }
    await drainMicrotasks();

    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "turn-evidence-memory-overflowed",
      ),
    ).toHaveLength(0);
    expect(harness.server.killedSessions).toEqual([]);
    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a run whose config declares a frame origin, before any byte is written", async () => {
    // The origin of a run's opening frame is MINTED at the boundary, so the
    // untyped `agentConfig` bag cannot name one — least of all the exempt arm,
    // which would have the participant's command-shaped words delivered verbatim
    // to the provider's own command layer AND excuse the swallowed turn from the
    // tripwire. No type reaches a bag, so the refusal is the enforcement.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: {
          sessionId: SESSION_ID,
          input: "/compact",
          frameOrigin: "driver_command",
        },
      }),
    ).rejects.toThrow(CodexDriverConfigError);

    // Refused ahead of the write, so the text never reached the provider and no
    // route or turn was left behind by the attempt.
    expect(harness.server.writtenLines.filter((line) => line.includes("turn/start"))).toStrictEqual(
      [],
    );
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("accepts a run whose config declares the origin the boundary itself mints", async () => {
    // Declaring the truth is a no-op rather than an error: the refusal above is
    // about a caller CHOOSING an origin, not about vocabulary churn for one that
    // matches what this path writes anyway.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "participant_text",
      },
    });

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
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
    // Drained, not counted — same reason as the prelude-sentinel arm above.
    await drainMicrotasks();

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

  // THE PARAMETER-LEVEL GAP the `rollback` flag's `static` detection source
  // leaves open. The method enumeration establishes that `thread/fork` is
  // accepted; it says nothing about `ThreadForkParams.lastTurnId`, which the wire
  // reference verifies at the `0.150.1` pin and not at the `0.141.0` admission
  // floor. A build in that gap passes the static capability gate and refuses at
  // the parameter, so the classification has to happen at invocation.
  //
  // The SUCCESS path is asserted by the applied-arm test at the top of this
  // block, which still reports `applied` with its minted binding — so the guard
  // added around the fork dispatch is proven not to have moved the happy path.
  const BOUNDARY_FIELD_REFUSALS: readonly string[] = [
    // Measured verbatim on `thread/fork` itself at the pin — the deserializer's
    // answer when a required field is absent from the params it was sent.
    "Invalid request: missing field `lastTurnId`",
    // The same deserializer's answer when the field is present but not declared
    // on the params type, which is the shape a RENAMED boundary member produces.
    "Invalid request: unknown field `lastTurnId`",
  ];

  it("classifies a fork refusing the boundary field as the registered capability refusal", async () => {
    for (const providerMessage of BOUNDARY_FIELD_REFUSALS) {
      const harness = createHarness();
      await resumedSessionWithTurns(harness, 2);
      harness.server.on("thread/fork", () => ({
        error: { code: -32600, message: providerMessage },
      }));

      const refused = await harness.driver
        .rollbackTo({ sessionId: SESSION_ID, bindingId: "binding-abc", position: 1 })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(refused).toBeInstanceOf(CodexRewindBoundaryUnsupportedError);
      // The registered code, carried by class identity rather than invented
      // here: an unregistered dotted literal would be a new error-contract row.
      expect((refused as CodexRewindBoundaryUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
      expect((refused as CodexRewindBoundaryUnsupportedError).fields).toStrictEqual({
        driverId: "codex",
        flag: "rollback",
        providerError: providerMessage,
      });

      // THE SLOT WAS NOT LEAKED. A throw out of the claimed establishment body
      // must still release the session's transition slot, or this session could
      // never be rewound — or resumed, or closed — again. Driven by attempting a
      // second rollback and observing that it reaches the wire at all.
      harness.server.on("thread/fork", () => ({
        result: {
          thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
        },
      }));
      const retried = await harness.driver.rollbackTo({
        sessionId: SESSION_ID,
        bindingId: "binding-abc",
        position: 1,
      });
      expect(retried).toStrictEqual({
        status: "applied",
        sessionPosition: 1,
        bindingId: "binding-abc",
      });
    }
  });

  it("leaves every other fork failure the generic provider error it is", async () => {
    // THE NARROWNESS IS THE CONTRACT. Only a refusal that provably indicts the
    // boundary member is a capability answer; everything else stays what the
    // provider said. The third case is the one the wire reference explicitly
    // warns about: `unknown variant` names the METHOD that was sent (or an enum
    // value nested in it), so a classifier matching a phrase without the
    // backticked field name would read "this build has no `thread/fork` at all"
    // — a different condition, governed by the version floor — as a missing
    // boundary field.
    const genericRefusals: readonly string[] = [
      "Invalid request: unknown variant `thread/fork`, expected one of `initialize`, `thread/start`",
      "Invalid request: missing field `threadId`",
      "thread not found",
    ];
    for (const providerMessage of genericRefusals) {
      const harness = createHarness();
      await resumedSessionWithTurns(harness, 2);
      harness.server.on("thread/fork", () => ({
        error: { code: -32600, message: providerMessage },
      }));

      const refused = await harness.driver
        .rollbackTo({ sessionId: SESSION_ID, bindingId: "binding-abc", position: 1 })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      // Asserted as a labelled pair rather than a bare negative so a failure
      // names WHICH refusal was misread, which is the whole diagnostic value of
      // driving three shapes through one arm.
      expect({
        providerMessage,
        classifiedAsCapabilityRefusal: refused instanceof CodexRewindBoundaryUnsupportedError,
      }).toStrictEqual({ providerMessage, classifiedAsCapabilityRefusal: false });
      expect(refused).toBeInstanceOf(CodexProviderRequestError);
    }
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
      // Added by the `0.150.1` pin BESIDE the three older spellings above, not
      // in place of them: the pin hop's set difference added four notification
      // arms and removed none, so dropping `itemAdded` / `transcript/delta` /
      // `transcript/done` here would un-suppress names still on the wire.
      "thread/realtime/item/started",
      "thread/realtime/item/transcript/delta",
      "thread/realtime/item/completed",
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
      // Explicit `null`: these tests bind no live `model/list` read, so
      // `listModels()` answers the module's declared catalog. The option is
      // required precisely so that choice is written down rather than defaulted.
      modelCatalogExchange: null,
      diagnostics: makeSilentDriverDiagnostics(),
      subscribeToPtySession: () => () => undefined,
      reportDiagnostic: () => undefined,
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
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
  /**
   * The CENSUSED records the manager emitted, distinct from `harness.diagnostics`
   * (the transport-local arm). Both are captured because a turn-attribution
   * refusal is required to reach BOTH sinks, and a test reading only one could
   * not tell a two-sink report from a one-sink one.
   */
  readonly driverDiagnosticRecords: DriverDiagnosticRecord[];
}

async function routedAskHarness(
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
    modelCatalogExchange: null,
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
  await driver.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
  const harness: Harness = {
    server,
    driver,
    diagnostics,
    driverDiagnostics,
    textNeutralizationFailures: [],
    scheduler,
  };

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
  return { harness, askProvider, driverDiagnosticRecords };
}

describe("CodexAppServerConnection routed server requests (T3.15 R3)", () => {
  it("answers an allowed `item/tool/call` with the provider's own success shape", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({
          decision: "allow",
          payload: { contentItems: [{ type: "inputText", text: "ok" }] },
        }),
    });
    // A live turn, and an ask that NAMES it: a callback-tool invocation is
    // attributed by its own `turnId` and refused when that cannot be resolved,
    // so the allow arm is only reachable through a turn this daemon routes.
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });

    const answer = await askProvider("item/tool/call", {
      toolName: "search",
      arguments: {},
      turnId: TURN_ID,
    });

    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
  });

  it("REFUSES rather than truncates an answer larger than the outbound bound", async () => {
    // `CODEX_MAX_LINE_LENGTH` bounds only what this transport ACCEPTS, so an
    // answer composed from daemon-side content had no ceiling at all. A
    // truncated tool output is a WRONG answer the model cannot tell from a
    // complete one; a refusal is one it can act on.
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({
          decision: "allow",
          payload: {
            contentItems: [
              { type: "inputText", text: "x".repeat(CODEX_MAX_OUTBOUND_FRAME_BYTES + 1) },
            ],
          },
        }),
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });

    const answer = await askProvider("item/tool/call", {
      toolName: "search",
      arguments: {},
      turnId: TURN_ID,
    });

    // The provider still receives a WELL-FORMED answer in this method's own
    // refusal shape — never silence, which would hang the turn.
    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({
      success: false,
      contentItems: [{ type: "inputText", text: CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON }],
    });
    const oversized = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "server-request-answer-oversized",
    );
    expect(oversized).toHaveLength(1);
    expect(oversized[0]).toMatchObject({
      kind: "server-request-answer-oversized",
      method: "item/tool/call",
      limit: CODEX_MAX_OUTBOUND_FRAME_BYTES,
    });
  }, 30_000);

  it("records a rejected answer write rather than swallowing it", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "refuse", reason: "policy denied" }),
    });
    harness.server.rejectNextWriteWith = new Error("pty write failed: broken pipe");

    // The ask is never answered on the wire, which is precisely the fact the
    // swallowed `.catch()` hid: the exit path records that a process died, not
    // that one specific ask will never be answered.
    await expect(askProvider("item/commandExecution/requestApproval")).rejects.toThrow(
      "never answered",
    );

    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "server-request-answer-write-failed",
      ),
    ).toStrictEqual([
      {
        kind: "server-request-answer-write-failed",
        method: "item/commandExecution/requestApproval",
        detail: "pty write failed: broken pipe",
      },
    ]);
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

  it("REFUSES an approval whose named turn is unresolvable, never attributing it to another run", async () => {
    // A request that NAMES a turn makes a claim about which run raised it. The
    // sole-active fallback answered that claim by substituting a DIFFERENT run,
    // so a delayed approval from a retired turn was evaluated, persisted, and
    // projected under a newer run's identity and authorization context. A
    // decline is visible to the participant and retryable; an approval decided
    // against the wrong run is neither.
    const attributedRuns: Array<string | null> = [];
    const { harness, askProvider, driverDiagnosticRecords } = await routedAskHarness({
      answer: async (request): Promise<CodexServerRequestDecision> => {
        attributedRuns.push(request.runId);
        return await Promise.resolve({ decision: "allow" });
      },
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });

    const answer = await askProvider("item/commandExecution/requestApproval", {
      turnId: "turn-that-already-retired",
    });

    // The method's OWN refusal vocabulary, never a protocol error.
    expect(answer["result"]).toStrictEqual({ decision: "decline" });
    // The responder was never reached: refused ahead of adjudication rather
    // than adjudicated against a run that did not raise it.
    expect(attributedRuns).toStrictEqual([]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved"),
    ).toStrictEqual([
      {
        kind: "routed-ask-turn-unresolved",
        method: "item/commandExecution/requestApproval",
        turnId: "turn-that-already-retired",
        turnIdTruncated: false,
        disposition: "refused",
      },
    ]);
    // The CENSUSED kind stays callback-tool-scoped. Routing an approval refusal
    // through `callback_tool_invocation_refused` would not widen an operator's
    // view; it would corrupt a count whose name says what it counts.
    expect(driverDiagnosticRecords).toStrictEqual([]);
  });

  it("REFUSES an approval whose named turn is past the reader's bound", async () => {
    // The over-long case is INSIDE the rule rather than beside it: a turn named
    // past the bound is a turn named and not resolvable. Resolving a truncated
    // prefix is the one way this seam could match a run by coincidence.
    const attributedRuns: Array<string | null> = [];
    const { harness, askProvider } = await routedAskHarness({
      answer: async (request): Promise<CodexServerRequestDecision> => {
        attributedRuns.push(request.runId);
        return await Promise.resolve({ decision: "allow" });
      },
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });

    const answer = await askProvider("item/commandExecution/requestApproval", {
      turnId: "t".repeat(4096),
    });

    expect(answer["result"]).toStrictEqual({ decision: "decline" });
    expect(attributedRuns).toStrictEqual([]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved"),
    ).toStrictEqual([
      {
        kind: "routed-ask-turn-unresolved",
        method: "item/commandExecution/requestApproval",
        turnId: "t".repeat(256),
        turnIdTruncated: true,
        disposition: "refused",
      },
    ]);
  });

  it("still attributes an approval whose named turn IS live — the eligible shape stays eligible", async () => {
    // The negative control that keeps the refusal above from passing by
    // refusing everything: the ordinary approval, naming the turn it was raised
    // in, still reaches the responder stamped with that turn's run.
    const attributedRuns: Array<string | null> = [];
    const { harness, askProvider } = await routedAskHarness({
      answer: async (request): Promise<CodexServerRequestDecision> => {
        attributedRuns.push(request.runId);
        return await Promise.resolve({ decision: "allow" });
      },
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });

    const answer = await askProvider("item/commandExecution/requestApproval", {
      turnId: TURN_ID,
    });

    expect(answer["result"]).toStrictEqual({ decision: "accept" });
    expect(attributedRuns).toStrictEqual([RUN_ID]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved"),
    ).toStrictEqual([]);
  });

  it("records nothing and still ATTRIBUTES a legacy approval that publishes no turn id at all", async () => {
    // The fallback is scoped, not deleted. `ExecCommandApprovalParams` carries
    // no `turnId` member at the pin, so this ask makes no claim to contradict:
    // the heuristic IS its attribution, refusing it would decline real
    // approvals over the pinned protocol working as designed, and a diagnostic
    // per legacy approval would be noise rather than signal.
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "allow" }),
    });

    const answer = await askProvider("execCommandApproval", { callId: "call-9" });

    expect(answer["result"]).toStrictEqual({ decision: "approved" });
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved"),
    ).toStrictEqual([]);
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

  it("attributes the ask to the run when overlapping turns ALL belong to it", async () => {
    // Two overlapping accepted starts on ONE run put two live turns on the
    // session — the very shape the turn-keyed routes retain. Every value in the
    // turn-to-run map names the same run, so the attribution is unambiguous at
    // any turn count; a turn-count gate here dropped the run association, and
    // its `driver_ask.requested` projection, in exactly the state the routing
    // supports.
    const attributedRunIds: Array<RunId | null> = [];
    const { harness, askProvider } = await routedAskHarness({
      answer: async (request): Promise<CodexServerRequestDecision> => {
        attributedRunIds.push(request.runId);
        return await Promise.resolve({ decision: "refuse", reason: "policy denied" });
      },
    });
    const firstOpeningText = "the attempt answered first";
    harness.server.on("turn/start", (params) => ({
      result: {
        turn: {
          id:
            readTurnStartInputText(params) === firstOpeningText
              ? "turn-overlap-a"
              : "turn-overlap-b",
        },
      },
    }));
    const first = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: firstOpeningText },
    });
    const second = harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });
    await first;
    await second;

    await askProvider("item/commandExecution/requestApproval");

    expect(attributedRunIds).toStrictEqual([RUN_ID]);
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

  it("a DUPLICATE thread/started retains the child's usage base rather than re-basing it", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 100);
    await Promise.resolve();
    // The provider re-announces a child it already announced. Re-establishing
    // here would zero the base mid-stream, so the 150 reading below would meter
    // 150 rather than the 50 the child actually spent since.
    announceChild(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 150);
    await Promise.resolve();

    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
    expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
      "subagent.started",
    ]);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("thread_duplicate_child_announcement"),
    ).toHaveLength(1);
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

  // ------------------------------------------------------------------------
  // The rewind rebind. `thread/fork` mints a NEW thread and the session
  // continues on it, so the band has to move with the record: a router still
  // registered on the pre-fork identity holds every post-rewind frame pending a
  // registration that never lands, then sheds it, and the session both stops
  // projecting and stops metering for the rest of its life.
  // ------------------------------------------------------------------------

  const FORKED_THREAD_ID = "01a04202-0148-7ae2-8560-f04bed000001";

  /**
   * A full-axis prior-emitted sum.
   *
   * Every axis the fixture reports has to be based, not just `input`: an axis
   * left at zero would meter the forked thread's whole cumulative on that axis
   * AND disagree with the wire's own `last`, so a partial fixture would report
   * a cross-check mismatch that the code under test did not cause.
   */
  function priorEmittedBreakdown(value: number): CumulativeAxisReadings {
    return {
      total: value,
      input: value,
      cachedInput: value,
      cacheWriteInput: value,
      output: value,
      reasoningOutput: value,
    };
  }

  /**
   * A session created, metered, and rewound onto {@link FORKED_THREAD_ID}.
   *
   * The prior-emitted reader answers ONLY for the pre-fork thread and records
   * every key it is asked for. That asymmetry is the point: the forked id
   * resolves to nothing by construction, so a lookup keyed on it is observable
   * as a missing base rather than merely being wrong about which thread it
   * asked after.
   */
  async function rewoundSession(
    options: {
      /**
       * What the daemon's prior-emitted reader does. `prior-sum` answers for
       * the pre-fork thread only; `nothing` is a BOUND reader with no emitted
       * sum to report, which is a correct answer rather than a fault.
       */
      readonly readerAnswer?: "prior-sum" | "nothing" | "throws";
      /** Whether the session meters anything before it is rewound. */
      readonly meterBeforeFork?: boolean;
      /** The thread id the provider's `thread/fork` answers with. */
      readonly forkAnswersThreadId?: string;
      /**
       * The turn ledger the provider's `thread/fork` answers with.
       *
       * Defaults to the one turn the fixture actually ran, which AGREES with the
       * position the rewind asks for — so a test that wants the disagreement has
       * to ask for it rather than inherit it from the fixture.
       */
      readonly forkAnswersTurnIds?: readonly string[];
      /**
       * Announces a live child thread before the rewind is issued.
       *
       * The only way to hold an id that is registered with the accountant and is
       * NOT the pre-fork thread, which is the case the fork-identity check
       * cannot see.
       */
      readonly announceChildBeforeFork?: boolean;
    } = {},
  ): Promise<{
    harness: ManagerHarness;
    readerCalls: { sessionId: SessionId; threadId: string }[];
    rollbackResult: Awaited<ReturnType<CodexLifecycleManager["rollbackTo"]>>;
  }> {
    const readerAnswer = options.readerAnswer ?? "prior-sum";
    const readerCalls: { sessionId: SessionId; threadId: string }[] = [];
    const harness = await managerWithSession({
      onServerNotification: true,
      readPriorEmittedUsage: (sessionId, threadId) => {
        readerCalls.push({ sessionId, threadId });
        if (readerAnswer === "throws") {
          throw new Error("prior-emitted usage reader failed");
        }
        if (readerAnswer === "nothing") {
          return undefined;
        }
        return threadId === THREAD_ID ? priorEmittedBreakdown(100) : undefined;
      },
    });

    // A turn, so the rewind has a recorded boundary to fork through, and a
    // metered reading on the PRE-FORK thread, so there is real emitted spend
    // for the successor to base on rather than a zero either arm would produce.
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    if (options.meterBeforeFork !== false) {
      emitUsage(harness, THREAD_ID, 100);
    }
    // The boundary turn has to be OVER: a fork through a live turn is refused.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();

    if (options.announceChildBeforeFork === true) {
      announceChild(harness, "subAgent");
      await drainMicrotasks();
    }

    harness.server.on("thread/fork", () => ({
      result: {
        thread: {
          id: options.forkAnswersThreadId ?? FORKED_THREAD_ID,
          sessionId: "session-tree-1",
          turns: (options.forkAnswersTurnIds ?? [TURN_ID]).map((turnId) => ({ id: turnId })),
        },
      },
    }));
    const rollbackResult = await harness.manager.rollbackTo({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });

    // The fixture's per-thread ledger holds nothing for the forked id, so its
    // `last` would be the whole cumulative rather than the turn's own figure.
    // Seeded with what the daemon already emitted, so `last` is the arithmetic
    // per-turn figure a continuing provider counter would report and the
    // accountant's corroboration cross-check stays a real signal here.
    //
    // Seeded ONLY on the arm that emitted it. Unconditionally, the no-spend arm
    // derived its next `last` from a cumulative it never sent and shipped a
    // NEGATIVE per-turn figure on every axis — a shape no provider produces —
    // so that arm ran against an impossible wire and buried six unasserted
    // cross-check mismatches while doing it.
    if (options.meterBeforeFork !== false) {
      emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    }
    return { harness, readerCalls, rollbackResult };
  }

  it("a rewind rebinds the band onto the forked thread and bases it on the PRE-FORK thread's emitted sum", async () => {
    const { harness, readerCalls, rollbackResult } = await rewoundSession();

    expect(rollbackResult.status).toBe("applied");
    // THE load-bearing assertion. The sum is looked up under the thread the
    // daemon actually emitted spend against; the forked thread is one it has
    // never emitted a token for, so a lookup keyed on it resolves to nothing
    // and bases the whole rewound session at zero. An unrebound band asks
    // nothing at all, so both wrong states are distinguishable from this one.
    expect(readerCalls).toStrictEqual([{ sessionId: SESSION_ID, threadId: THREAD_ID }]);

    emitUsage(harness, FORKED_THREAD_ID, 150);
    await Promise.resolve();

    // ROUTED, not held: the forked thread is the session's own thread now.
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    // And metered at 50 rather than 150 — the 100 the daemon emitted before the
    // fork is not charged to the session a second time.
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
    // Neither direction of a mis-based register fired. `usage_resume_base_unavailable`
    // is what a lookup keyed on the forked id leaves behind; `usage_delta_floor_hit`
    // is what a base ABOVE the successor's readings leaves behind; the cross-check
    // is the wire's own per-turn figure agreeing with the derived interval.
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toEqual(
      [],
    );
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_delta_floor_hit")).toEqual([]);
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toEqual([]);
    // The provider's forked history AGREES with the position asked for, so the
    // corroboration record stays silent — a record that fired on every rewind
    // would say nothing about the ones that actually disagree.
    expect(
      harness.diagnostics.filter((entry) => entry.kind === "fork-turn-ledger-unconfirmed"),
    ).toStrictEqual([]);
  });

  it("a rewind retires the pre-fork thread as the session's own rather than leaving two", async () => {
    const { harness } = await rewoundSession();

    // The forked thread projects: it IS the session now.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: FORKED_THREAD_ID },
    });
    await Promise.resolve();
    expect(harness.notifications.map((entry) => entry.method)).toContain("thread/queue/changed");

    // The PRE-FORK thread does not. Re-registering the session's own identity is
    // the whole retirement — the router holds exactly one — so a late frame from
    // the thread the caller rewound away from is present-but-unregistered and
    // waits rather than projecting into the rewound timeline.
    const projectedBeforeStaleFrame = harness.notifications.length;
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: THREAD_ID },
    });
    await Promise.resolve();

    expect(harness.notifications).toHaveLength(projectedBeforeStaleFrame);
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(1);
  });

  it("a prior-emitted reader that THROWS leaves the rewind applied and records the overstatement", async () => {
    const { harness, rollbackResult } = await rewoundSession({ readerAnswer: "throws" });

    // The reader is caller-supplied and runs after the record has already been
    // re-pointed at the forked thread. A throw escaping there would report a
    // rewind that did happen as one that did not, and leave the caller retrying
    // a fork it has already taken.
    expect(rollbackResult.status).toBe("applied");
    const baseUnavailable = harness.driverDiagnostics.recentRecordsOfKind(
      "usage_resume_base_unavailable",
    );
    expect(baseUnavailable).toHaveLength(1);
    // Both ids travel, and on a rewind they DIFFER: the sum was looked up under
    // the pre-fork thread while the registers being based belong to the forked
    // one, and an operator reconciling a receipt needs the pair to see which
    // key came up empty.
    expect(baseUnavailable[0]?.details).toMatchObject({
      threadId: FORKED_THREAD_ID,
      priorEmittedThreadId: THREAD_ID,
    });
  });

  it("a rewind of a session that emitted NOTHING bases at zero silently", async () => {
    const { harness, rollbackResult } = await rewoundSession({
      readerAnswer: "nothing",
      meterBeforeFork: false,
    });

    expect(rollbackResult.status).toBe("applied");
    // A BOUND reader answering with nothing is a correct answer to a correct
    // question, not a fault: a session that legitimately emitted no spend has a
    // prior-emitted sum of zero and bases at zero exactly right. Recording it
    // would fire on every zero-spend rewind and say nothing about any of them,
    // while claiming spend was re-metered where none exists.
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toEqual(
      [],
    );

    // And the zero base is the RIGHT base: the forked thread's first reading is
    // all new spend, so it meters in full.
    emitUsage(harness, FORKED_THREAD_ID, 60);
    await Promise.resolve();
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([{ threadId: FORKED_THREAD_ID, input: 60 }]);
    // The wire's own per-turn figure agrees with the derived interval, which is
    // only true because this arm's fixture no longer seeds a cumulative the
    // session never emitted: seeded, `last` arrives negative on every axis and
    // the cross-check that is supposed to corroborate this arm fires six times.
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toEqual([]);
  });

  it("refuses a rewind the provider did not FORK, leaving the session on its original thread", async () => {
    // The provider answers with the thread it was handed. That is not a fork:
    // either it rewound the thread in place or handed the same one back, and
    // the pre-rewind conversation a fork exists to preserve is gone either way.
    const { harness, readerCalls, rollbackResult } = await rewoundSession({
      forkAnswersThreadId: THREAD_ID,
    });

    expect(rollbackResult).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-not-forked",
    });
    // Refused BEFORE the re-point, so nothing was rebound: an unforked answer
    // must not re-base this session's registers against its own emitted sum for
    // a thread that never changed.
    expect(readerCalls).toStrictEqual([]);

    // The session is exactly as it was found — still routing and still metering
    // on its original thread, which is what makes the refusal retry-safe rather
    // than merely honest.
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  it("a rewind retires the pre-fork thread's usage registers rather than leaking a set per rewind", async () => {
    const { harness } = await rewoundSession();

    // The router's retirement is FUSED into the re-registration — it holds one
    // session identity, so registering the forked one replaces it — but the
    // accountant holds a register set per thread and has no such fusion. Left
    // unreleased, every rewind leaks one for the session's whole life and
    // `hasThread` keeps answering true for a thread the caller has rewound away
    // from, so the refusal beside it can no longer tell a thread the session is
    // still metering from one it has retired.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(false);
    // And the retirement did not take the session's own metering with it: the
    // successor is established, which is what the rewind exists to do.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(FORKED_THREAD_ID)).toBe(true);
  });

  it("refuses a fork answered with a thread the session ALREADY meters, leaving both sets of registers intact", async () => {
    // A live child thread: registered with the accountant, and NOT the pre-fork
    // thread, so the fork-identity check cannot see it. Adopting it would
    // re-establish registers that are carrying a child's real spend and hand the
    // router a session identity whose frames are already attributed elsewhere.
    const { harness, readerCalls, rollbackResult } = await rewoundSession({
      announceChildBeforeFork: true,
      forkAnswersThreadId: CHILD_THREAD_ID,
    });

    expect(rollbackResult).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-target-thread-already-registered",
    });
    // Refused BEFORE the re-point, so no base was rebuilt for anything.
    expect(readerCalls).toStrictEqual([]);
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(CHILD_THREAD_ID)).toBe(true);
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(true);

    // Both are still metering on their own bases: the child under its own
    // attribution, the session on the thread it never left.
    emitUsage(harness, CHILD_THREAD_ID, 40);
    emitUsage(harness, THREAD_ID, 150);
    await drainMicrotasks();
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: CHILD_THREAD_ID, input: 40 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  it("records the ledger disagreement when the provider's forked history is a different LENGTH than the position asked for", async () => {
    const { harness, rollbackResult } = await rewoundSession({
      forkAnswersTurnIds: [TURN_ID, "turn-02"],
    });

    // The fork itself succeeded, so the rewind is real and applies — and the
    // applied result reports the CALLER's position whatever the provider's
    // history says. Unrecorded, a provider that forked to a different depth than
    // the one asked for would be visible nowhere at all.
    expect(rollbackResult).toStrictEqual({
      status: "applied",
      sessionPosition: 1,
      bindingId: "binding-abc",
    });
    expect(
      harness.diagnostics.filter((entry) => entry.kind === "fork-turn-ledger-unconfirmed"),
    ).toStrictEqual([
      { kind: "fork-turn-ledger-unconfirmed", expectedTurnCount: 1, confirmedTurnCount: 2 },
    ]);
  });

  it("records the same disagreement, once, when the fork answers with no readable turn history", async () => {
    const { harness, rollbackResult } = await rewoundSession({ forkAnswersTurnIds: [] });

    // The absent-history arm is not a second kind of disagreement: an unreadable
    // list reads as zero turns, which disagrees with the position like any other
    // count. One report covers both, so neither arm can double-report.
    expect(rollbackResult.status).toBe("applied");
    expect(
      harness.diagnostics.filter((entry) => entry.kind === "fork-turn-ledger-unconfirmed"),
    ).toStrictEqual([
      { kind: "fork-turn-ledger-unconfirmed", expectedTurnCount: 1, confirmedTurnCount: 0 },
    ]);
  });

  /**
   * A rewind SUSPENDED at its `thread/fork` request, with the answer left in the
   * test's hands.
   *
   * No `thread/fork` handler is registered, so the fake answers nothing and the
   * request stays in flight. That suspension is the whole point: every hazard in
   * the rebind lives between the request and its answer, and a fixture that
   * answered from a handler would close the window before a concurrent caller
   * could be dispatched into it.
   */
  async function rewindSuspendedAtFork(): Promise<{
    harness: ManagerHarness;
    rewind: ReturnType<CodexLifecycleManager["rollbackTo"]>;
    answerFork: () => Promise<void>;
  }> {
    const harness = await managerWithSession({
      onServerNotification: true,
      readPriorEmittedUsage: (_sessionId, threadId) =>
        threadId === THREAD_ID ? priorEmittedBreakdown(100) : undefined,
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    emitUsage(harness, THREAD_ID, 100);
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    const rewind = harness.manager.rollbackTo({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
    // Drained so the request has actually reached the wire: a test that raced
    // the write would be asserting against a rewind that had not begun.
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);

    return {
      harness,
      rewind,
      answerFork: async (): Promise<void> => {
        harness.server.emitFrame({
          jsonrpc: "2.0",
          id: harness.server.framesForMethod("thread/fork")[0]?.["id"],
          result: {
            thread: {
              id: FORKED_THREAD_ID,
              sessionId: "session-tree-1",
              turns: [{ id: TURN_ID }],
            },
          },
        });
        await drainMicrotasks();
      },
    };
  }

  it("refuses a turn dispatched while a rewind's fork is IN FLIGHT, and the rewound session still projects and meters", async () => {
    const { harness, rewind, answerFork } = await rewindSuspendedAtFork();
    const turnStartFramesBeforeRewind = harness.server.framesForMethod("turn/start").length;

    // Dispatched inside the fork's suspension. Unclaimed, this turn is accepted
    // on the PRE-FORK thread; the fork then moves the routing and metering band
    // off it, and every frame the turn produces is held-then-shed — the run
    // never projects, never meters, and its id is discarded by the ledger
    // splice, all while the caller was told the turn started.
    const refusal = await harness.manager
      .startRun({
        runId: SECOND_RUN_ID,
        channelId: CHANNEL_ID,
        agentConfig: { sessionId: SESSION_ID, input: "second" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(CodexTransportError);
    expect((refusal as Error).message).toContain("being re-established");
    // Refused at the ENTRANCE: nothing reached the wire, so there is no accepted
    // turn to strand on a thread the rewind is about to leave.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(turnStartFramesBeforeRewind);
    expect(harness.manager.hasActiveTurn(SECOND_RUN_ID)).toBe(false);

    await answerFork();
    await expect(rewind).resolves.toStrictEqual({
      status: "applied",
      sessionPosition: 1,
      bindingId: "binding-abc",
    });

    // The surviving path is WHOLE, which is the half a refusal alone does not
    // prove: the forked thread is the session's own, it projects, and it meters
    // against the pre-fork thread's emitted sum rather than being held and shed.
    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: FORKED_THREAD_ID },
    });
    emitUsage(harness, FORKED_THREAD_ID, 150);
    await drainMicrotasks();

    expect(harness.notifications.map((entry) => entry.method)).toContain("thread/queue/changed");
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
  });

  it("meters a forked-thread frame held across the fork against the base the rebind establishes", async () => {
    const { harness, rewind, answerFork } = await rewindSuspendedAtFork();

    // The provider has forked on ITS side and the new thread is already
    // emitting, but the daemon's continuation has not run yet — so the frame
    // names a thread the router does not know, and it is HELD rather than shed.
    // Seeded first because the fixture's `last` is derived per thread: without
    // it the wire would carry the whole cumulative as a turn figure.
    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    emitUsage(harness, FORKED_THREAD_ID, 150);
    await drainMicrotasks();
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(1);
    expect(harness.meteredUsage).toHaveLength(1);

    await answerFork();
    await expect(rewind).resolves.toMatchObject({ status: "applied" });

    // Released by the registration inside the rebind and metered at 50 — the
    // pre-fork spend is not charged twice, and the frame is not lost. This is
    // also the only assertion covering the rebind's ORDER contract: delivered
    // ahead of the base establishment, the accountant refuses a thread it has no
    // registers for, `meterReading` answers null, and the released reading is
    // dropped without so much as a record — spend that reaches no receipt.
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
  });

  it("a resume whose prior-emitted reader THROWS still resumes, and records the base it could not rebuild", async () => {
    const harness = createManagerHarness({
      onServerNotification: true,
      readPriorEmittedUsage: () => {
        throw new Error("prior-emitted usage reader failed");
      },
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    const result = await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    // The base is a TELEMETRY input, not a gate on the resume. A caller-supplied
    // reader that throws must not convert a live provider session into a typed
    // failure the daemon then tries to recover from — the process is up and the
    // thread is resumed whatever the reader did.
    expect(result.status).toBe("resumed");
    // Contained, never silent: this is the faulty arm, so the overstatement it
    // causes is recorded rather than left to surface on a receipt.
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable"),
    ).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// T3.12 C-8 — the model catalog, reachable through the composed driver.
// --------------------------------------------------------------------------

describe("CodexDriver model catalog (T3.12 C-8)", () => {
  function buildCatalogDriverOptions(): ConstructorParameters<typeof CodexDriver>[0] {
    return {
      ptyHost: new FakeCodexAppServer(),
      modelCatalogExchange: null,
      diagnostics: makeSilentDriverDiagnostics(),
      subscribeToPtySession: () => () => undefined,
      reportDiagnostic: () => undefined,
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
      newBindingId: () => "binding-abc",
      readCapabilities: () => makeCapabilities(true),
    };
  }

  it("serves the declared catalog through the composed entry", async () => {
    const driver = new CodexDriver(buildCatalogDriverOptions());

    const models = await driver.listModels();

    expect(models.map((model) => model.id)).toEqual(
      CODEX_DECLARED_MODEL_CATALOG.map((model) => model.id),
    );
    // The member the currency duty exists for, reachable from the driver object
    // rather than only from the module that declares it — and carrying the
    // vocabulary split the pinned build publishes.
    expect(models.find((model) => model.id === "gpt-5.6-sol")?.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(models.find((model) => model.id === "gpt-5.5")?.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("serves a bound exchange's reading instead of the declaration", async () => {
    const driver = new CodexDriver({
      ...buildCatalogDriverOptions(),
      modelCatalogExchange: async () => ({
        data: [
          {
            id: "gpt-future-9",
            displayName: "GPT-Future-9",
            supportedReasoningEfforts: [{ reasoningEffort: "glacial" }],
          },
        ],
        nextCursor: null,
      }),
    });

    const models = await driver.listModels();

    // A level this file never enumerates: the vocabulary is the build's, not
    // this driver's, which is what keeps the catalog current without an edit.
    expect(models).toEqual([
      { id: "gpt-future-9", name: "GPT-Future-9", capabilities: [], effortLevels: ["glacial"] },
    ]);
  });

  it("propagates a bound exchange's failure rather than serving the declaration", async () => {
    const driver = new CodexDriver({
      ...buildCatalogDriverOptions(),
      modelCatalogExchange: async () => ({ data: [], nextCursor: "page-2" }),
    });

    await expect(driver.listModels()).rejects.toThrow(/paginated/);
  });
});

// --------------------------------------------------------------------------
// T3.15 leg 3 — the callback-tool host reaches the provider end to end.
// --------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-005 §Required Behavior` — the driver answers EVERY callback-tool
//     invocation. Asserted through the composed path a production spawn will
//     use rather than through the host in isolation: a provider `item/tool/call`
//     frame reaches the daemon's `CallbackToolHost`, and the host's answer
//     reaches the provider as a `DynamicToolCallResponse`.
//   `Spec-012 §Required Behavior` — every invocation is adjudicated. Asserted
//     as the evaluation seam having been consulted before the executor ran on
//     the admitted path, and as no executor reaching a withheld registry.
//
// THE COMPILE-TIME HALF OF THIS TEST IS THE `answerServerRequest` ARGUMENT.
// `createCallbackToolAskResponder` returns the host module's own structurally
// declared port; passing it where `CodexSessionServerRequestResponder` is
// required is what proves the two independent declarations still agree, and a
// divergence would fail here as a type error rather than at runtime.

const SEARCH_CALLBACK_TOOL: SessionCallbackTool = {
  name: "search_workspace",
  description: "Searches the session's mounted workspace.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

interface CallbackToolRoundTripHarness {
  readonly askProvider: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  readonly binding: CallbackToolSpawnBinding;
  readonly executedInvocations: CallbackToolInvocation[];
  readonly evaluatedToolNames: string[];
  readonly hostDiagnostics: DriverDiagnosticRecord[];
  /** The manager's CENSUSED records — the sink an operator's counters read. */
  readonly driverDiagnosticRecords: DriverDiagnosticRecord[];
  /** The transport-local arm, captured beside the censused one. */
  readonly transportDiagnostics: CodexTransportDiagnostic[];
  readonly startTurn: () => Promise<void>;
  /**
   * A SECOND run with its own live turn on the same session — the state in
   * which the sole-active heuristic can answer nothing at all.
   */
  readonly startSecondTurn: () => Promise<void>;
}

async function callbackToolRoundTripHarness(options: {
  readonly providerRegistrationAvailable: boolean;
  readonly executeResult?: CallbackToolResult;
}): Promise<CallbackToolRoundTripHarness> {
  const executedInvocations: CallbackToolInvocation[] = [];
  const evaluatedToolNames: string[] = [];
  const hostDiagnostics: DriverDiagnosticRecord[] = [];
  const host = new CallbackToolHost({
    provider: "codex",
    diagnostics: new DriverDiagnosticsEmitter({
      logSink: { record: (record) => hostDiagnostics.push(record) },
      counterSink: { increment: () => undefined },
    }),
    executor: {
      execute: async (invocation) => {
        executedInvocations.push(invocation);
        return await Promise.resolve(
          options.executeResult ?? { status: "completed", output: "2 matches" },
        );
      },
    },
    activitySink: { record: () => undefined },
    approvalSeam: {
      evaluate: async (request) => {
        evaluatedToolNames.push(request.toolName);
        return await Promise.resolve({ decision: "allow", basis: "policy" });
      },
    },
  });
  const binding = bindCallbackToolsForSpawn(host, {
    sessionId: SESSION_ID,
    requestedTools: [SEARCH_CALLBACK_TOOL],
    providerRegistrationAvailable: options.providerRegistrationAvailable,
    providerRegistrationUnavailableDetail: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
  });
  const { harness, askProvider, driverDiagnosticRecords } = await routedAskHarness(
    createCallbackToolAskResponder({ host, approvalAskResponder: null }),
  );
  const startTurn = async (): Promise<void> => {
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });
  };
  const startSecondTurn = async (): Promise<void> => {
    harness.server.on("turn/start", () => ({ result: { turn: { id: SECOND_TURN_ID } } }));
    await harness.driver.startRun({
      runId: SECOND_RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace again" },
    });
  };
  return {
    askProvider,
    binding,
    executedInvocations,
    evaluatedToolNames,
    hostDiagnostics,
    driverDiagnosticRecords,
    transportDiagnostics: harness.diagnostics,
    startTurn,
    startSecondTurn,
  };
}

describe("CodexDriver callback-tool round trip (T3.15 leg 3)", () => {
  it("carries a provider tool call to the host and the host's answer back", async () => {
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: true });
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-77",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    // Adjudicated before executed, and answered in the provider's own shape.
    expect(roundTrip.evaluatedToolNames).toStrictEqual([SEARCH_CALLBACK_TOOL.name]);
    expect(roundTrip.executedInvocations[0]?.toolCallId).toBe("call-77");
    // The run identity the transport does not hold was resolved at answer time
    // and reached the invocation, which is what makes the call attributable.
    expect(roundTrip.executedInvocations[0]?.runId).toBe(RUN_ID);
    expect(answer["result"]).toStrictEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "2 matches" }],
    });
  });

  it("answers the provider's own refusal shape when the tool is not registered", async () => {
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: true });
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: "delete_everything",
      callId: "call-78",
      arguments: {},
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(answer["result"]).toMatchObject({ success: false });
    // Refused BEFORE the pipeline: malformed or unknown provider output never
    // reaches Cedar, and it certainly never reaches the executor.
    expect(roundTrip.evaluatedToolNames).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
  });

  it("refuses every call when the registry was withheld at spawn", async () => {
    // The truthful production value at this pin: `ThreadStartParams.dynamicTools`
    // is experimental-generation-only, so a Codex composition root reports the
    // registration unavailable and the host withholds the whole registry.
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: false });
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-79",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(roundTrip.binding.resolution).toStrictEqual({
      admitted: false,
      reason: "provider-registration-unavailable",
      detail: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
      // A withholding still INSTALLS an empty registry, so the binding still
      // owes a scoped teardown and still carries the token that scopes it.
      registryToken: roundTrip.binding.resolution.registryToken,
    });
    expect(roundTrip.binding.resolution.registryToken).not.toBeNull();
    expect(answer["result"]).toMatchObject({ success: false });
    expect(roundTrip.executedInvocations).toStrictEqual([]);
  });

  it("refuses a tool call that names no turn, BEFORE the host is reached", async () => {
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: true });

    // `DynamicToolCallParams` carries a REQUIRED non-nullable `turnId` at the
    // pin, so a callback-tool ask without one is a shape this daemon cannot
    // attribute — and attributing it to whichever run happened to be
    // sole-active is exactly what a delayed request after an earlier run ended
    // would exploit.
    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-80",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
    });

    expect(answer["result"]).toMatchObject({ success: false });
    // The host was never asked: an unattributable invocation is refused ahead
    // of adjudication rather than adjudicated against a guessed run.
    expect(roundTrip.hostDiagnostics).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
    // BOTH sinks. The censused kind is what an operator's counters name.
    expect(roundTrip.driverDiagnosticRecords.map((record) => record.kind)).toStrictEqual([
      "callback_tool_invocation_refused",
    ]);
    expect(roundTrip.driverDiagnosticRecords[0]?.details["turnId"]).toBeNull();
    expect(
      roundTrip.transportDiagnostics.filter(
        (diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved",
      ),
    ).toStrictEqual([
      {
        kind: "routed-ask-turn-unresolved",
        method: "item/tool/call",
        turnId: null,
        turnIdTruncated: false,
        disposition: "refused",
      },
    ]);
  });

  it("refuses an over-bound turn id and records it as a MARKED truncation, never as absent", async () => {
    // Two different provider faults with two different fixes. Collapsed to a
    // bare `null` they would read identically in the record, and an operator
    // would be told the ask named no turn when it named one 4096 characters
    // long. The over-bound value is never RESOLVED — a truncated prefix could
    // match a shorter live turn — but it is still reported.
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: true });
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-84",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: "t".repeat(4096),
    });

    expect(answer["result"]).toMatchObject({ success: false });
    expect(roundTrip.executedInvocations).toStrictEqual([]);
    expect(
      roundTrip.transportDiagnostics.filter(
        (diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved",
      ),
    ).toStrictEqual([
      {
        kind: "routed-ask-turn-unresolved",
        method: "item/tool/call",
        turnId: "t".repeat(256),
        turnIdTruncated: true,
        disposition: "refused",
      },
    ]);
    expect(roundTrip.driverDiagnosticRecords[0]?.details["turnIdTruncated"]).toBe(true);
  });

  it("resolves the callback run from the turn the ask names, with two runs live", async () => {
    // THE FINDING. The sole-active heuristic returns `null` here — two distinct
    // runs hold live turns — so every callback invocation on this session used
    // to be refused. The turn the ask NAMES resolves it exactly.
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: true });
    await roundTrip.startTurn();
    await roundTrip.startSecondTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-81",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: SECOND_TURN_ID,
    });

    expect(answer["result"]).toMatchObject({ success: true });
    expect(roundTrip.executedInvocations[0]?.runId).toBe(SECOND_RUN_ID);
    // And the first run's turn resolves to the FIRST run over the same
    // connection, which is what makes this attribution rather than a coin flip.
    await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-82",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(roundTrip.executedInvocations[1]?.runId).toBe(RUN_ID);
  });

  it("refuses a tool call naming a turn this daemon holds no live route for", async () => {
    // The delayed-request shape: the ask arrives after its own turn retired,
    // while a NEWER run is live. Misattributing it would run the older turn's
    // tool against the newer run's registry and approval seam.
    const roundTrip = await callbackToolRoundTripHarness({ providerRegistrationAvailable: true });
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-83",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: "turn-that-already-retired",
    });

    expect(answer["result"]).toMatchObject({ success: false });
    expect(roundTrip.hostDiagnostics).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
    expect(roundTrip.driverDiagnosticRecords[0]?.details["turnId"]).toBe(
      "turn-that-already-retired",
    );
  });
});

// Console-parity operations — T3.26 (`Spec-005 §Desktop Console Parity
// Surfaces`, invariant I-005-13).
// --------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-005 §Desktop Console Parity Surfaces` — compaction settles on the
//     provider's TYPED EVIDENCE and never on the request being accepted; the
//     wait is bounded and twice-terminated; bounding the OPERATION never bounds
//     the BOUNDARY'S RECORD; the command surface is a LIVE READ held as
//     driver-session state and never a stored registry, whose entries carry the
//     `(driverName, providerAccountId)` they were read under.

describe("CodexLifecycleManager.compactContext (T3.26, native)", () => {
  // A child thread of this session's own thread. Declared here rather than
  // reused from the routing suite's block scope so this leg's child case cannot
  // be silently repointed by an edit to a neighbouring describe.
  const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000002";

  async function compactionHarness(): Promise<ManagerHarness> {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    return harness;
  }

  function emitCompactionBoundary(
    harness: ManagerHarness,
    params: Record<string, unknown> = { threadId: THREAD_ID, turnId: TURN_ID },
  ): void {
    harness.server.emitFrame({ jsonrpc: "2.0", method: "thread/compacted", params });
  }

  it("dispatches `thread/compact/start` for the session's own thread and settles `applied` on the typed frame", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();
    // The trigger names the session's CURRENT thread, read off the record — not
    // a value the caller supplied, which the params do not carry at all.
    expect(harness.server.framesForMethod("thread/compact/start")).toHaveLength(1);
    expect(harness.server.framesForMethod("thread/compact/start")[0]?.["params"]).toStrictEqual({
      threadId: THREAD_ID,
    });

    // The provider's typed evidence. `ContextCompactedNotification` is
    // `{ threadId, turnId }` at the pin and names NO position, so `null` here
    // is the positive statement that the frame carried none — not a driver that
    // forgot to read one.
    emitCompactionBoundary(harness);

    await expect(compaction).resolves.toStrictEqual({
      status: "applied",
      boundaryPosition: null,
    });
  });

  it("carries a boundary position through verbatim when a frame names one", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();
    // A FORWARD-COMPATIBILITY vector, not a pinned one: no member of the
    // pinned payload carries a position, so this pins the reader's behaviour
    // for a pin that starts publishing one rather than asserting today's wire.
    emitCompactionBoundary(harness, { threadId: THREAD_ID, turnId: TURN_ID, boundaryPosition: 7 });

    await expect(compaction).resolves.toStrictEqual({ status: "applied", boundaryPosition: 7 });
  });

  it("does NOT settle `applied` on the empty acknowledgement alone", async () => {
    const harness = await compactionHarness();

    let observed: DriverCompactionResult | "still-waiting" = "still-waiting";
    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    void compaction.then((result) => {
      observed = result;
    });
    await drainMicrotasks();

    // `ThreadCompactStartResponse` is `Record<string, never>` — an empty
    // acknowledgement the provider returns the moment it ACCEPTS the job. The
    // request has resolved by now (the frame count proves the dispatch
    // happened) and the operation is still open.
    expect(harness.server.framesForMethod("thread/compact/start")).toHaveLength(1);
    expect(observed).toBe("still-waiting");
    // Non-vacuous: the operation is open because a WAIT is armed at the driver's
    // own declared bound, not because the request hung.
    expect(harness.scheduler.pendingDelays()).toContain(CODEX_COMPACTION_WAIT_MS);

    emitCompactionBoundary(harness);
    await expect(compaction).resolves.toMatchObject({ status: "applied" });
  });

  it("settles `wait_expired` when the declared bound elapses — and a LATE compaction frame still normalizes", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    // ONLY the compaction bound, never `fireAll`: a live session also holds the
    // transport's own 60s request deadline, and firing that too would reject
    // the in-flight request and settle `provider_error` — the same failed
    // assertion for the wrong reason.
    expect(harness.scheduler.fireDelay(CODEX_COMPACTION_WAIT_MS)).toBe(1);

    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "wait_expired",
    });
    const terminals = harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.details["terminal"]).toBe("wait_expired");
    expect(terminals[0]?.details["declaredBoundMs"]).toBe(CODEX_COMPACTION_WAIT_MS);

    // THE SECOND HALF, asserted in the same test because it is the same claim:
    // bounding the OPERATION never bounds the BOUNDARY'S RECORD. The frame that
    // arrives after the wait expired settles nobody and still travels its
    // ordinary route into the normalize band. A tap that had been written as a
    // diversion would swallow it here.
    const before = harness.notifications.length;
    emitCompactionBoundary(harness);
    await drainMicrotasks();
    expect(harness.notifications.slice(before).map((entry) => entry.method)).toEqual([
      "thread/compacted",
    ]);
  });

  it("settles `binding_lost` the instant the binding goes, with no timer ever firing", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    await harness.manager.closeSession({ sessionId: SESSION_ID });

    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "binding_lost",
    });
    // THE IMMEDIACY PROPERTY, and the whole reason the second terminal is a
    // PUSH from the disposal path rather than a periodic liveness check: a
    // binding lost at t=0 settles at t=0. A poller would pass every assertion
    // above and fail this one, because it could only settle when a timer ran.
    expect(harness.scheduler.firedDelays()).not.toContain(CODEX_COMPACTION_WAIT_MS);
    const terminals = harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.details["terminal"]).toBe("binding_lost");
  });

  it("settles `provider_error` when the trigger itself is refused, and records no false terminal", async () => {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({
      error: { code: -32603, message: "compaction unavailable" },
    }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await expect(
      harness.manager.compactContext({ sessionId: SESSION_ID, bindingId: "binding-abc" }),
    ).resolves.toStrictEqual({ status: "failed", reason: "provider_error" });
    const terminals = harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.details["terminal"]).toBe("provider_error");

    // THE ARMED WAIT IS WITHDRAWN, not left to time out. A thrown request means
    // the transport failed, and `CODEX_COMPACTION_WAIT_MS` is longer than the
    // transport deadline that produces such a throw — so a registration left
    // behind here outlives its own caller by the difference. No compaction-bound
    // timer survives this arm.
    expect(harness.scheduler.pendingDelays()).not.toContain(CODEX_COMPACTION_WAIT_MS);

    // Non-vacuous in the direction that matters: there is nothing left for the
    // bound to fire, so a later elapse cannot revive a settled operation or emit
    // a second terminal for one call.
    expect(harness.scheduler.fireDelay(CODEX_COMPACTION_WAIT_MS)).toBe(0);
    await drainMicrotasks();
    expect(harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(
      1,
    );
  });

  it("withdraws only its OWN wait — a concurrent caller still settles on the evidence", async () => {
    // The property that makes the withdrawal safe, and the reason it is not a
    // settlement. Settling is per-key because one provider compaction is one
    // compaction; withdrawing is per-waiter. A caller whose own dispatch threw
    // must therefore not settle a participant who asked independently and is
    // still owed the truth about the compaction that IS running.
    const harness = createManagerHarness({ onServerNotification: true });
    let dispatchCount = 0;
    harness.server.on("thread/compact/start", () => {
      dispatchCount += 1;
      return dispatchCount === 1
        ? { result: {} }
        : { error: { code: -32603, message: "compaction unavailable" } };
    });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    const surviving = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    await expect(
      harness.manager.compactContext({ sessionId: SESSION_ID, bindingId: "binding-abc" }),
    ).resolves.toStrictEqual({ status: "failed", reason: "provider_error" });

    // Exactly ONE compaction bound is still armed: the refused caller's is gone
    // and the surviving caller's is untouched. Counted rather than merely
    // contained, so a withdrawal that took the whole key down fails here.
    expect(
      harness.scheduler.pendingDelays().filter((delay) => delay === CODEX_COMPACTION_WAIT_MS),
    ).toHaveLength(1);

    emitCompactionBoundary(harness);
    await expect(surviving).resolves.toStrictEqual({ status: "applied", boundaryPosition: null });
  });

  // ----------------------------------------------------------------------
  // The wait is keyed by the BINDING it was dispatched under, not by the
  // session. This driver's thread identity moves WITHIN a live session — a
  // successful `rollbackTo` forks a replacement and a superseding
  // `resumeSession` installs a new record on the same session id — so a
  // session-keyed wait would outlive the binding it was armed against and lose
  // the second of its two terminals.
  // ----------------------------------------------------------------------

  const FORKED_THREAD_ID = "01a04202-0148-7ae2-8560-forked000001";

  async function rewindableCompactionHarness(): Promise<ManagerHarness> {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({ result: {} }));
    // Seeded through a resume rather than by running turns: a resumed thread
    // carries the turn ledger a rewind indexes, without making these
    // assertions depend on the turn-dispatch band.
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });
    return harness;
  }

  it("settles a pending wait `binding_lost` the instant a rollback forks its thread away", async () => {
    const harness = await rewindableCompactionHarness();
    harness.server.on("thread/fork", () => ({
      result: {
        thread: {
          id: FORKED_THREAD_ID,
          sessionId: "session-tree-1",
          turns: [{ id: "turn-0" }],
        },
      },
    }));

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
    });
    await drainMicrotasks();

    await expect(
      harness.manager.rollbackTo({
        sessionId: SESSION_ID,
        bindingId: "binding-predecessor",
        position: 1,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    // IMMEDIATELY, and on the honest terminal. The binding this caller
    // dispatched into is gone, so `binding_lost` is what it is owed — never
    // `wait_expired` a full declared bound later, and never `applied` on some
    // compaction the SUCCESSOR thread performs.
    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "binding_lost",
    });
    expect(harness.scheduler.firedDelays()).not.toContain(CODEX_COMPACTION_WAIT_MS);
  });

  it("a SUCCESSOR thread's compaction released by the rewind's own registration settles no PREDECESSOR wait", async () => {
    // THE CASE THE KEY EXISTS FOR, and the one the two releases alone do not
    // cover. `#bindSessionThread` registers the forked thread and FLUSHES the
    // router's pending-registration hold through the ordinary delivery path in
    // the same synchronous run — strictly BEFORE the rewind releases the
    // predecessor's waits. So a `thread/compacted` naming the successor that
    // arrived while it was still unannounced reaches the settlement tap while a
    // predecessor wait is still armed. Keyed by session alone that frame settles
    // it `applied`: a compaction this caller never asked for, on a thread it was
    // never bound to, reported as its own.
    const harness = await rewindableCompactionHarness();
    harness.server.on("thread/fork", () => ({
      result: {
        thread: {
          id: FORKED_THREAD_ID,
          sessionId: "session-tree-1",
          turns: [{ id: "turn-0" }],
        },
      },
    }));

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
    });
    await drainMicrotasks();

    // Held, not routed: the successor thread is not registered yet, so the
    // router parks this frame rather than projecting or quarantining it.
    emitCompactionBoundary(harness, { threadId: FORKED_THREAD_ID, turnId: TURN_ID });
    await drainMicrotasks();
    expect(harness.scheduler.pendingDelays()).toContain(CODEX_COMPACTION_WAIT_MS);

    await expect(
      harness.manager.rollbackTo({
        sessionId: SESSION_ID,
        bindingId: "binding-predecessor",
        position: 1,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    // `binding_lost` and emphatically not `applied`: the flushed frame belongs
    // to the successor's key and settles nobody, and the release that follows
    // it tells this caller the truth about the binding it dispatched into.
    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "binding_lost",
    });
  });

  it("a compaction on the REWOUND session settles on the successor thread's own frame", async () => {
    // The other half of the same claim, and what keeps the first from passing
    // by simply breaking compaction after a rewind: the key MOVED with the
    // record rather than being torn down. Also the stale-evidence guard — the
    // pre-fork thread's frame settles nothing here.
    const harness = await rewindableCompactionHarness();
    harness.server.on("thread/fork", () => ({
      result: {
        thread: {
          id: FORKED_THREAD_ID,
          sessionId: "session-tree-1",
          turns: [{ id: "turn-0" }],
        },
      },
    }));
    await harness.manager.rollbackTo({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/compact/start")[0]?.["params"]).toStrictEqual({
      threadId: FORKED_THREAD_ID,
    });

    // The RETIRED thread's frame first: it names a thread this session no
    // longer registers, so it settles nobody.
    emitCompactionBoundary(harness, { threadId: THREAD_ID, turnId: TURN_ID });
    await drainMicrotasks();
    expect(harness.scheduler.pendingDelays()).toContain(CODEX_COMPACTION_WAIT_MS);

    emitCompactionBoundary(harness, { threadId: FORKED_THREAD_ID, turnId: TURN_ID });
    await expect(compaction).resolves.toStrictEqual({ status: "applied", boundaryPosition: null });
  });

  it("settles a pending wait `binding_lost` when a resume supersedes the binding it was armed on", async () => {
    const harness = await rewindableCompactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
    });
    await drainMicrotasks();

    // A resume beside a live leg SUPERSEDES it: the process the wait was
    // dispatched into is replaced, so its evidence can never arrive.
    await harness.manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "binding_lost",
    });
    expect(harness.scheduler.firedDelays()).not.toContain(CODEX_COMPACTION_WAIT_MS);
  });

  it("records NO terminal diagnostic on the applied path", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();
    emitCompactionBoundary(harness);
    await compaction;

    // The counter is a FAILURE counter. Emitting on the success path too would
    // make it a request count and hide the ratio it exists to expose.
    expect(harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal")).toEqual([]);
  });

  it("a registered CHILD thread's compaction never settles the participant's wait", async () => {
    const harness = await compactionHarness();
    // A provider-INTERNAL compaction child: the most adversarial case this leg
    // has, because the child is itself a compaction, so the only thing
    // separating its boundary frame from the participant's is whose thread it
    // names.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: {
          id: CHILD_THREAD_ID,
          parentThreadId: THREAD_ID,
          threadSourceKind: "compaction",
        },
      },
    });

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    emitCompactionBoundary(harness, { threadId: CHILD_THREAD_ID, turnId: "child-turn" });
    await drainMicrotasks();

    // The child's boundary frame routed `carve-out-usage` — a different arm
    // from the two the tap is called from — so it reached neither the
    // participant's wait nor the parent's timeline.
    expect(harness.notifications).toStrictEqual([]);
    expect(harness.scheduler.pendingDelays()).toContain(CODEX_COMPACTION_WAIT_MS);

    // And the proof that it settled NOTHING: the wait still runs out its own
    // declared bound. Were the tap comparing nothing, or were the routing
    // classification to regress, this would already have resolved `applied`.
    expect(harness.scheduler.fireDelay(CODEX_COMPACTION_WAIT_MS)).toBe(1);
    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "wait_expired",
    });
  });
});

describe("CodexLifecycleManager.listProviderCommands (T3.26, live read)", () => {
  interface SkillFixture {
    name: string;
    description?: unknown;
    scope?: unknown;
    enabled?: unknown;
  }

  function skillsListResult(skills: readonly SkillFixture[]): JsonRpcAnswer {
    // The pinned reply is NESTED — `{ data: SkillsListEntry[] }` where each
    // entry is `{ cwd, skills, errors }`, one group per scanned root — so the
    // fixture reproduces that shape rather than a flat array the driver would
    // never see.
    return {
      result: {
        data: [{ cwd: SESSION_CWD, skills: [...skills], errors: [] }],
      },
    };
  }

  async function enumerationHarness(
    skills: readonly SkillFixture[],
    options: ManagerHarnessOptions = {},
  ): Promise<ManagerHarness> {
    const harness = createManagerHarness({ onServerNotification: true, ...options });
    let current: readonly SkillFixture[] = skills;
    harness.server.on("skills/list", () => skillsListResult(current));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      sessionId: SESSION_ID,
      config: options.config ?? SESSION_CONFIG,
    });
    Object.assign(harness, {
      setSkills: (next: readonly SkillFixture[]) => {
        current = next;
      },
    });
    return harness;
  }

  it("returns disabled entries, carries `enabled` verbatim, and maps an empty description to an ABSENT key", async () => {
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
      { name: "retired", description: "Not offerable", scope: "user", enabled: false },
      // `SkillMetadata.description` is a REQUIRED string at the pin, and a skill
      // file may legitimately leave it blank.
      { name: "blank", description: "", scope: "repo", enabled: true },
      { name: "whitespace", description: "   ", scope: "repo", enabled: true },
      // A provider that publishes no Boolean at all: absence must stay absence,
      // never a synthesized `true`.
      { name: "undeclared", description: "No enabled flag", scope: "system" },
    ]);

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    const entries = result.bindings[0]?.entries ?? [];

    // THE DISABLED ENTRY IS RETURNED. The flag governs offerability, not
    // presence — filtering it would leave a consumer unable to tell a disabled
    // command from one that does not exist.
    expect(entries.map((entry) => entry.name)).toEqual([
      "review",
      "retired",
      "blank",
      "whitespace",
      "undeclared",
    ]);
    expect(entries.map((entry) => entry.enabled)).toEqual([true, false, true, true, undefined]);
    // KEY-PRESENCE, not `toBeUndefined()`: under `exactOptionalPropertyTypes` a
    // present-but-undefined key and an absent one are different values, and
    // only the second is what "the provider declared nothing" means.
    expect(Object.hasOwn(entries[4] as object, "enabled")).toBe(false);

    // The empty and whitespace-only descriptions become ABSENT rather than
    // refusing their entries: `wireFreeFormString` rejects both, so carrying
    // them through would have dropped two real commands.
    expect(Object.hasOwn(entries[2] as object, "description")).toBe(false);
    expect(Object.hasOwn(entries[3] as object, "description")).toBe(false);
    expect(entries[0]?.description).toBe("Review a diff");
    expect(entries.every((entry) => entry.kind === "skill")).toBe(true);
    expect(entries[0]?.scope).toBe("repo");
  });

  it("drops an entry whose NAME cannot be read, and only its name — every refusal RECORDED", async () => {
    const harness = await enumerationHarness([
      { name: "keeper", description: "fine", scope: "repo", enabled: true },
      // A caption too long to carry costs the CAPTION, never the command: a
      // command whose description was lost is still a command that exists.
      { name: "long-caption", description: "x".repeat(20_000), scope: "repo", enabled: true },
      // A scope this driver cannot bound likewise costs the scope only.
      { name: "odd-scope", description: "fine", scope: 17, enabled: true },
      // A nameless entry names nothing a consumer could show or route, so it is
      // the ONE field whose failure drops the row.
      { name: "" as unknown as string, description: "fine", scope: "repo", enabled: true },
    ]);

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    const entries = result.bindings[0]?.entries ?? [];

    expect(entries.map((entry) => entry.name)).toEqual(["keeper", "long-caption", "odd-scope"]);
    expect(Object.hasOwn(entries[1] as object, "description")).toBe(false);
    expect(Object.hasOwn(entries[2] as object, "scope")).toBe(false);

    // AND NEITHER ERASURE IS SILENT. Absence on this contract is a POSITIVE
    // claim — no description published, no scope stated — so a declaration the
    // bounds refused, erased without a record, reaches a consumer as a claim
    // the provider never made: `odd-scope` would read as an unscoped skill.
    const rejected = harness.driverDiagnostics.recentRecordsOfKind(
      "provider_command_entry_rejected",
    );
    expect(
      rejected.map((record) => ({
        field: record.details["rejectedField"],
        dropped: record.details["dropped"],
      })),
    ).toEqual([
      { field: "description", dropped: false },
      { field: "scope", dropped: false },
      { field: "name", dropped: true },
    ]);
    // The LENGTHS travel and the values never do — the value is exactly the
    // untrusted string a bound just rejected.
    expect(rejected[0]?.details["rejectedValueLength"]).toBe(20_000);
    // Not a string, so no length to report — stated rather than synthesized.
    expect(rejected[1]?.details["rejectedValueLength"]).toBeNull();
    expect(rejected.every((record) => record.rawWireType === "skills/list")).toBe(true);
  });

  it("records NOTHING for metadata the provider genuinely declared none of", async () => {
    // The negative control for the records above. Three shapes that are the
    // provider stating "none" rather than publishing something unreadable — and
    // a record for any of them would make the channel report the pinned
    // protocol working as a fault.
    const harness = await enumerationHarness([
      // `SkillMetadata.description` is a REQUIRED string at the pin, so a skill
      // file that leaves it blank has no other way to say "none".
      { name: "blank-caption", description: "", scope: "repo" },
      { name: "whitespace-caption", description: "   ", scope: "repo" },
      // An absent key, and an explicit null, on both optional members.
      { name: "no-metadata" },
      { name: "null-metadata", description: null, scope: null },
    ]);

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    const entries = result.bindings[0]?.entries ?? [];

    expect(entries.map((entry) => entry.name)).toEqual([
      "blank-caption",
      "whitespace-caption",
      "no-metadata",
      "null-metadata",
    ]);
    expect(entries.every((entry) => !Object.hasOwn(entry, "description"))).toBe(true);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("provider_command_entry_rejected"),
    ).toStrictEqual([]);
  });

  it("records a BLANK scope, which the pin has no way of publishing as a stated absence", async () => {
    // The asymmetry, and its reason. The pin publishes `scope` only where one is
    // DECLARED, so a provider with no scope omits the member entirely — which
    // makes a present-but-blank scope malformed rather than a stated absence,
    // exactly the reading a blank description IS.
    const harness = await enumerationHarness([{ name: "blank-scope", scope: "   " }]);

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });

    expect(result.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["blank-scope"]);
    expect(
      harness.driverDiagnostics
        .recentRecordsOfKind("provider_command_entry_rejected")
        .map((record) => record.details["rejectedField"]),
    ).toEqual(["scope"]);
  });

  it("records the refusal ONCE per read, not once per palette open", async () => {
    // The enumeration is read once and HELD, so emitting from whichever reply a
    // caller was served would turn one provider fault into a record per palette
    // open — and would say the provider published it again each time.
    const harness = await enumerationHarness([
      { name: "odd-scope", description: "fine", scope: 17 },
    ]);

    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });

    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("provider_command_entry_rejected"),
    ).toHaveLength(1);
  });

  it("stamps the run from the record the read went through, never a successor's", async () => {
    // THE WINDOW. `listProviderCommands` takes no session slot, so a successful
    // `resumeSession` can install a REPLACEMENT record for the same session id
    // while a `skills/list` reading is still being resolved. The epoch already
    // stops that reading from being CACHED, and it is still correctly answered
    // to its own caller — so the provenance stamped beside it must be the
    // predecessor's too. Re-resolving the run by session id after the await
    // reads whichever record is installed NOW, and the reply then claims a run
    // that never saw this enumeration's process.
    //
    // The window is narrow by construction and this test drives it exactly: the
    // resume installs its record and only afterwards releases the predecessor's
    // connection, and releasing REJECTS every request still pending on it. So
    // the reply must be delivered between those two acts, which is inside one
    // synchronous block — reached here through the superseded-frame diagnostic
    // the resume reports from within it.
    let releaseEnumeration = (): void => {};
    const harness = createManagerHarness({
      onServerNotification: true,
      onTransportDiagnostic: (diagnostic) => {
        if (diagnostic.kind === "superseded-frames-failed") {
          releaseEnumeration();
        }
      },
    });
    // Two connections are live inside the window, and the listener registry is
    // keyed by pty session id: shared ids would make the successor's subscribe
    // displace the predecessor's reader and the held answer would reach nobody.
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("skills/list", () =>
      skillsListResult([{ name: "review", description: "Review a diff", scope: "repo" }]),
    );
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("thread/resume", () => threadStartResult(1));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);

    releaseEnumeration = harness.server.holdAnswers("skills/list");
    const enumeration = harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);

    const resumed = await harness.manager.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
    expect(resumed.status).toBe("resumed");

    const result = await enumeration;

    // The successor's record carries an EMPTY turn map — no run has started on
    // it — so an id-keyed re-resolution answers `null` and erases an
    // attribution that was true of the process this list came from. Reading the
    // record directly keeps the pair `{ runId, providerAccountId }` describing
    // one process.
    expect(result.bindings[0]?.runId).toBe(RUN_ID);
    expect(result.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["review"]);
  });

  it("caps the REPLY at the wire bound while the held enumeration stays whole", async () => {
    const overCap = DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 3;
    const harness = await enumerationHarness(
      Array.from({ length: overCap }, (_unused, index) => ({
        name: `skill-${index}`,
        description: `entry ${index}`,
        scope: "repo",
        enabled: true,
      })),
    );

    const first = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });

    expect(first.bindings[0]?.complete).toBe(false);
    expect(first.bindings[0]?.entries).toHaveLength(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    const truncations = harness.driverDiagnostics.recentRecordsOfKind(
      "provider_command_entries_truncated",
    );
    expect(truncations).toHaveLength(1);
    expect(truncations[0]?.details["heldCount"]).toBe(overCap);
    expect(truncations[0]?.details["returnedCount"]).toBe(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);

    // THE HELD LIST WAS NOT TRUNCATED. Read a second time: the provider is not
    // asked again (one `skills/list` frame in total, so this reply came from the
    // held state), and the diagnostic still reports the FULL held count. A cap
    // applied to the held list instead of at composition would report the
    // capped number here.
    const second = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);
    expect(second.bindings[0]?.complete).toBe(false);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("provider_command_entries_truncated"),
    ).toHaveLength(2);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("provider_command_entries_truncated")[1]
        ?.details["heldCount"],
    ).toBe(overCap);

    // NO PRESENCE-CHECK SUB-ASSERTION HERE, deliberately. The contract's
    // "a truncated read can never manufacture a `command_absent` refusal" is
    // about the EMULATED leg's pre-dispatch presence check; this leg is native
    // and performs none — `DriverCompactionResult`'s `refused` arm is
    // unreachable from `compactContext` above — so a presence-check assertion
    // would test nothing on this driver. The held-count assertion above is the
    // property that check would have rested on.
  });

  it("re-reads in FULL on `skills/changed`, never patching the held list", async () => {
    const harness = (await enumerationHarness([
      { name: "alpha", description: "first", scope: "repo", enabled: true },
      { name: "beta", description: "second", scope: "repo", enabled: true },
    ])) as ManagerHarness & { setSkills: (next: readonly SkillFixture[]) => void };

    const first = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(first.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);

    // A second read with no invalidation is served from held state.
    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);

    // `beta` is deleted upstream and `gamma` appears. The provider's own
    // invalidation cue carries an EMPTY payload — `SkillsChangedNotification`
    // is `Record<string, never>` — so there is nothing to patch WITH.
    harness.setSkills([
      { name: "alpha", description: "first", scope: "repo", enabled: true },
      { name: "gamma", description: "third", scope: "user", enabled: false },
    ]);
    harness.server.emitFrame({ jsonrpc: "2.0", method: "skills/changed", params: {} });
    await drainMicrotasks();

    const third = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);
    // A PATCH would have left `beta` behind. A full re-read is the only way
    // this list is exactly the provider's current one.
    expect(third.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["alpha", "gamma"]);
  });

  it("does NOT cache a reading taken across an invalidation that landed mid-flight", async () => {
    // The RACE the epoch closes. `skills/changed` can arrive while a
    // `skills/list` is still in flight, and discarding a list that is not there
    // yet discards nothing — the continuation then stores a reading taken
    // BEFORE the change and serves it until the next invalidation, which for an
    // idle skill tree is forever.
    const harness = (await enumerationHarness([
      { name: "alpha", description: "first", scope: "repo", enabled: true },
    ])) as ManagerHarness & { setSkills: (next: readonly SkillFixture[]) => void };
    // The invalidation rides the SAME read chunk as the reply, which is what
    // makes it land between the dispatch and the response continuation: the
    // notification is processed synchronously in that drain, while the
    // continuation is a microtask behind it. Split across two emissions the
    // microtask would drain in between and the interleave would not happen.
    let invalidateOnNextRead = true;
    harness.server.on("skills/list", () => {
      const answer = skillsListResult(
        invalidateOnNextRead
          ? [{ name: "alpha", description: "first", scope: "repo", enabled: true }]
          : [{ name: "gamma", description: "third", scope: "user", enabled: true }],
      );
      if (!invalidateOnNextRead) {
        return answer;
      }
      invalidateOnNextRead = false;
      return {
        ...answer,
        trailingFrames: [{ jsonrpc: "2.0", method: "skills/changed", params: {} }],
      };
    });

    // The racing read still ANSWERS ITS OWN CALLER — the reading is a correct
    // answer to a question asked before the change, and refusing it would fail
    // a palette open for a skill-file save.
    const racing = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(racing.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);

    // And it was cached for NOBODY: the next ask re-reads in full and sees the
    // post-change list. Without the epoch this returns the stale `alpha`
    // forever, with no further invalidation coming.
    const next = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);
    expect(next.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["gamma"]);

    // NON-VACUOUS in the other direction: ordinary caching is untouched, so a
    // guard that simply stopped caching would fail here.
    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);
  });

  it("hands back DEEP-FROZEN entries, so one consumer cannot poison a later reply", async () => {
    // The held enumeration is retained driver-session state and every reply
    // shares the same entry objects — the caller copies the ARRAY and nothing
    // more. A consumer that rewrote an entry's `name`, or its nested `binding`,
    // would corrupt the routing provenance of every later palette read on this
    // session. `Object.freeze` on the entry alone is SHALLOW, which is why the
    // binding is asserted separately.
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
    ]);

    const first = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    const entry = first.bindings[0]?.entries[0];

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.binding)).toBe(true);
    // The suite is an ES module, so an assignment to a frozen object THROWS
    // rather than failing silently — the mutation cannot even be attempted
    // quietly.
    expect(() => {
      (entry as ProviderCommandEntry).name = "hijacked";
    }).toThrow(TypeError);
    expect(() => {
      (entry as ProviderCommandEntry).binding.providerAccountId = "someone-else";
    }).toThrow(TypeError);

    // The freeze is shared, not per-reply: the next read hands back the same
    // uncorrupted graph.
    const second = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(second.bindings[0]?.entries[0]?.name).toBe("review");
    expect(second.bindings[0]?.entries[0]?.binding).toStrictEqual({
      driverName: "codex",
      providerAccountId: null,
    });
    // The ARRAY is still the caller's own: the cap slice and the copy make it
    // ordinary and mutable, so a consumer may sort or filter its own reply.
    expect(() => second.bindings[0]?.entries.push(entry as ProviderCommandEntry)).not.toThrow();
  });

  it("carries `providerAccountId: null` on an accountless session, key present", async () => {
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
    ]);

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    const binding = result.bindings[0]?.binding;
    const entryBinding = result.bindings[0]?.entries[0]?.binding;

    // ABSENCE IS STATED, NEVER SYNTHESIZED. A session with no bound account is
    // the ORDINARY case until the provider-account plane ships, and `""` / a
    // placeholder / the driver name would all make two accountless bindings on
    // DIFFERENT providers compare equal on the very half of the routing pair
    // that is supposed to separate them.
    expect(binding).toStrictEqual({ driverName: "codex", providerAccountId: null });
    expect(entryBinding).toStrictEqual({ driverName: "codex", providerAccountId: null });
    expect(Object.hasOwn(entryBinding as object, "providerAccountId")).toBe(true);
    // The other half of the invariant — that a `null` account matches NOTHING
    // rather than acting as a wildcard — is enforced by the daemon-side routing
    // guard, which is not this driver's code; what is asserted here is the
    // producer half that makes that guard possible at all.
  });

  it("passes a bound account through verbatim to every entry", async () => {
    const harness = await enumerationHarness(
      [{ name: "review", description: "Review a diff", scope: "repo", enabled: true }],
      { config: { ...SESSION_CONFIG, providerAccountId: "account-7" } },
    );

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "codex",
      providerAccountId: "account-7",
    });
    expect(result.bindings[0]?.entries[0]?.binding.providerAccountId).toBe("account-7");
  });

  it("resolves the group's run: none live, exactly one live, and two live", async () => {
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
    ]);

    // ZERO RUNS — the ordinary pre-first-turn palette read. It SUCCEEDS with a
    // stated `null`, because a binding that has not run anything yet still
    // enumerates real entries.
    const beforeAnyRun = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(beforeAnyRun.bindings[0]?.runId).toBeNull();
    expect(Object.hasOwn(beforeAnyRun.bindings[0] as object, "runId")).toBe(true);
    expect(beforeAnyRun.bindings[0]?.entries).toHaveLength(1);

    // EXACTLY ONE live run is attributable, so it is named.
    await harness.manager.startRun({
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const oneLive = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(oneLive.bindings[0]?.runId).toBe(RUN_ID);

    // TWO live runs on one binding: no single run is attributable, and picking
    // one would be a coin flip presented as provenance.
    harness.server.on("turn/start", () => ({ result: { turn: { id: "turn-02" } } }));
    await harness.manager.startRun({
      runId: SECOND_RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: { sessionId: SESSION_ID, input: "also go" },
    });
    const twoLive = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(twoLive.bindings[0]?.runId).toBeNull();
  });

  it("keeps the bound account across a resume, and refuses a present-but-empty one", async () => {
    // The DRIVER harness rather than the manager one: the resume path is
    // exercised through the same facade the existing I-005-5 resume tests use,
    // and `listProviderCommands` is on the driver's own `Pick` since T3.26.
    const harness = createHarness();
    // REQUIRED here and nowhere else in this block: a resume holds the new
    // connection and the superseded one at once, and the fake's listener
    // registry is keyed by pty session id — shared ids make the resume's own
    // subscribe register the new reader and the predecessor's later unsubscribe
    // then DELETE it, leaving the live connection deaf and every later request
    // unanswered. That is a fixture artifact of the double-spawn, not a driver
    // behaviour.
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/start", () => threadStartResult());
    harness.server.on("thread/resume", () => threadStartResult(1));
    // Answered because the supersede path awaits it and this harness runs on a
    // manual scheduler where the courtesy deadline would never fire.
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));
    harness.server.on("skills/list", () => ({
      result: {
        data: [
          {
            cwd: SESSION_CWD,
            skills: [
              { name: "review", description: "Review a diff", scope: "repo", enabled: true },
            ],
            errors: [],
          },
        ],
      },
    }));
    await harness.driver.createSession({
      sessionId: SESSION_ID,
      config: { ...SESSION_CONFIG, providerAccountId: "account-7" },
    });

    await harness.driver.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);

    await harness.driver.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });
    const afterResume = await harness.driver.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });

    // A resume RE-REALIZES the same credential home rather than re-deriving the
    // account from the request, unlike the credential policy beside it: an
    // account that silently moved mid-session would re-key the receipt's
    // per-paying-account axis.
    expect(afterResume.bindings[0]?.binding.providerAccountId).toBe("account-7");
    // THE ENUMERATION, by contrast, does NOT survive: it was a live read from a
    // process this resume replaced, and the `skills/changed` cue that would
    // have invalidated it travels over a connection that no longer exists. So
    // the post-resume read is a FRESH round trip, not the held list.
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);

    // A present-but-EMPTY account is a daemon that meant to bind one and bound
    // nothing, which is a different fact from a session that never had one —
    // and only the second may enumerate under a `null`.
    expect(() => parseCodexSessionConfig({ ...SESSION_CONFIG, providerAccountId: "" })).toThrow(
      CodexDriverConfigError,
    );
  });

  it("sends empty params, and discards the held enumeration with the session", async () => {
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
    ]);

    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    // `SkillsListParams` is `{ cwds?, forceReload? }` and an empty `cwds`
    // defaults to the session's own working directory, which is this
    // connection's spawn cwd. Restating it would narrow the read if a later
    // build scans more roots by default.
    expect(harness.server.framesForMethod("skills/list")[0]?.["params"]).toStrictEqual({});

    await harness.manager.closeSession({ sessionId: SESSION_ID });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });

    // A held list that survived its session would answer the NEXT session on
    // this id with the previous one's skills.
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);
  });
});

describe("readCodexAskOptionSet (T3.26, the input-ask choice set)", () => {
  it("reads `item/tool/requestUserInput` options with value === label", () => {
    // `ToolRequestUserInputOption` is `{ label, description }` at the pin and
    // carries NO value member, so the label IS the answer token the provider
    // expects back. Synthesizing an index or a hash would invent one it would
    // not recognize.
    const reading = readCodexAskOptionSet("item/tool/requestUserInput", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "item-1",
      isBlocking: true,
      questions: [
        {
          id: "q1",
          header: "Pick a branch",
          question: "Which branch?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "main", description: "the default branch" },
            { label: "develop", description: "the integration branch" },
          ],
        },
      ],
    });

    expect(reading).toStrictEqual({
      kind: "read",
      options: [
        { value: "main", label: "main" },
        { value: "develop", label: "develop" },
      ],
    });
  });

  it("reads all three MCP single-select enum arms", () => {
    const untitled = readCodexAskOptionSet("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: { pick: { type: "string", enum: ["a", "b"] } },
      },
    });
    expect(untitled).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b" },
      ],
    });

    // The ONE arm where value and label genuinely differ — which is why
    // `ProviderAskOption` has two members rather than one.
    const titled = readCodexAskOptionSet("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: {
          pick: {
            type: "string",
            oneOf: [
              { const: "a", title: "Alpha" },
              { const: "b", title: "Beta" },
            ],
          },
        },
      },
    });
    expect(titled).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    });

    // The legacy arm pairs POSITIONALLY, and its names array is optional and
    // may be short: an entry with no name opposite it falls back to its own
    // value, because a missing caption is not a missing choice.
    const legacy = readCodexAskOptionSet("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: {
          pick: { type: "string", enum: ["a", "b", "c"], enumNames: ["Alpha", "Beta"] },
        },
      },
    });
    expect(legacy).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
        { value: "c", label: "c" },
      ],
    });
  });

  it("reads absent for a method, mode, or shape that publishes no choice set", () => {
    // The approval arms publish a decision vocabulary the DAEMON composes, not
    // a set the provider offers.
    expect(readCodexAskOptionSet("item/commandExecution/requestApproval", {})).toStrictEqual({
      kind: "absent",
    });
    // `openai/form` carries an untyped `JsonValue` this driver will not guess
    // at, and `url` carries no schema at all.
    expect(
      readCodexAskOptionSet("mcpServer/elicitation/request", {
        mode: "openai/form",
        requestedSchema: { properties: { pick: { enum: ["a"] } } },
      }),
    ).toStrictEqual({ kind: "absent" });
    // The MULTI-SELECT arms are deliberately not read: their answer is an
    // ARRAY, so offering their items would present a pick-one card for a
    // pick-many question.
    expect(
      readCodexAskOptionSet("mcpServer/elicitation/request", {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { pick: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
        },
      }),
    ).toStrictEqual({ kind: "absent" });
  });

  it("drops a multi-question ask rather than merging two sets into one", () => {
    const reading = readCodexAskOptionSet("item/tool/requestUserInput", {
      questions: [
        { id: "q1", options: [{ label: "main", description: "" }] },
        { id: "q2", options: [{ label: "yes", description: "" }] },
      ],
    });

    // A flat list built from two questions answers NEITHER.
    expect(reading).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });

  it("drops a MIXED-QUESTION ask: one option-bearing question beside a free-text sibling", () => {
    // ELIGIBILITY IS THE TOTAL ASK SHAPE, not the option-bearing count — the
    // same rule the elicitation form states. This ask's answer covers EVERY
    // question it declares and `ProviderAskOption` carries no question
    // identity, so a flat set can stand in for the whole answer only where the
    // ask declares exactly ONE question. Counting only the OPTION-BEARING
    // questions made this shape look answerable, and every pick would have
    // produced an answer missing a question the provider is still waiting on.
    const freeTextSibling = readCodexAskOptionSet("item/tool/requestUserInput", {
      questions: [
        { id: "q1", question: "Which branch?", options: [{ label: "main", description: "" }] },
        { id: "q2", question: "Why?" },
      ],
    });
    // The ASK's question count, which is the number that explains the drop.
    expect(freeTextSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });

    // An EMPTY option list on the sibling is the same shape: it publishes no
    // choices, so it is a question the choice set cannot carry either.
    const emptyOptionSibling = readCodexAskOptionSet("item/tool/requestUserInput", {
      questions: [
        { id: "q1", options: [{ label: "main", description: "" }] },
        { id: "q2", options: [] },
      ],
    });
    expect(emptyOptionSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });

  it("still reads a SOLE-question ask — the eligible shape stays eligible", () => {
    // The negative control that keeps the drop above from passing by refusing
    // everything: a one-question ask projects its choices exactly as before.
    expect(
      readCodexAskOptionSet("item/tool/requestUserInput", {
        questions: [{ id: "q1", options: [{ label: "main", description: "" }] }],
      }),
    ).toStrictEqual({ kind: "read", options: [{ value: "main", label: "main" }] });
  });

  it("drops a MIXED-FIELD form: one single-select beside any sibling answers the form for neither", () => {
    // ELIGIBILITY IS THE TOTAL FORM SHAPE, not the enum count. A form's answer
    // is one OBJECT keyed by property name and `ProviderAskOption` carries no
    // property identity, so a flat set can stand in for the whole answer only
    // where the form has exactly ONE property. Counting only the ENUM-BEARING
    // properties made this shape — the commonest real elicitation there is —
    // look answerable, and every pick would have produced an answer missing a
    // field the provider is still waiting for.
    const requiredSibling = readCodexAskOptionSet("mcpServer/elicitation/request", {
      mode: "form",
      requestedSchema: {
        type: "object",
        required: ["pick", "reason"],
        properties: {
          pick: { type: "string", enum: ["a", "b"] },
          reason: { type: "string" },
        },
      },
    });
    // The FORM's property count, which is the number that explains the drop.
    expect(requiredSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });

    // REQUIREDNESS IS DELIBERATELY NOT CONSULTED. An optional sibling is
    // equally unanswerable by a value with no field name on it, so refining on
    // `required` would reopen the same defect for exactly this case.
    const optionalSibling = readCodexAskOptionSet("mcpServer/elicitation/request", {
      mode: "form",
      requestedSchema: {
        type: "object",
        required: ["pick"],
        properties: {
          pick: { type: "string", enum: ["a", "b"] },
          note: { type: "string" },
        },
      },
    });
    expect(optionalSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });

  it("still reads a SOLE-property single-select — the eligible shape stays eligible", () => {
    // The negative control that keeps the drop above from passing by refusing
    // everything: a form whose one property is the single-select projects its
    // choices exactly as before.
    expect(
      readCodexAskOptionSet("mcpServer/elicitation/request", {
        mode: "form",
        requestedSchema: {
          type: "object",
          required: ["pick"],
          properties: { pick: { type: "string", enum: ["a", "b"] } },
        },
      }),
    ).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b" },
      ],
    });
  });

  it("drops an over-large set rather than truncating it", () => {
    const reading = readCodexAskOptionSet("mcpServer/elicitation/request", {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          pick: {
            type: "string",
            enum: Array.from({ length: CODEX_ASK_OPTION_SET_MAX + 1 }, (_u, i) => `opt-${i}`),
          },
        },
      },
    });

    expect(reading).toMatchObject({
      kind: "dropped",
      declaredCount: CODEX_ASK_OPTION_SET_MAX + 1,
    });
  });

  it("drops the WHOLE set when one option is unreadable, never a partial one", () => {
    const reading = readCodexAskOptionSet("mcpServer/elicitation/request", {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { pick: { type: "string", enum: ["fine", "   "] } },
      },
    });

    // A partial set silently removes a choice the provider offered, so the card
    // would look complete and could not express the answer the provider is
    // waiting for.
    expect(reading).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });
});

describe("Codex ask normalization at the session seam (T3.26)", () => {
  async function askHarness(
    recorded: CodexSessionServerRequest[],
  ): Promise<{ harness: ManagerHarness; ask: (method: string, params: unknown) => Promise<void> }> {
    const harness = createManagerHarness({
      onServerNotification: true,
      answerServerRequest: {
        answer: async (request): Promise<CodexServerRequestDecision> => {
          recorded.push(request);
          return await Promise.resolve({ decision: "refuse", reason: "test" });
        },
      },
    });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
    let nextAskId = 4000;
    const ask = async (method: string, params: unknown): Promise<void> => {
      nextAskId += 1;
      harness.server.onData(
        "pty-session-1",
        new TextEncoder().encode(
          `${JSON.stringify({ jsonrpc: "2.0", id: nextAskId, method, params })}\r\n`,
        ),
      );
      await drainMicrotasks();
    };
    return { harness, ask };
  }

  it("stamps a readable choice set onto the session-scoped ask", async () => {
    const recorded: CodexSessionServerRequest[] = [];
    const { ask } = await askHarness(recorded);

    await ask("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: {
          pick: { type: "string", oneOf: [{ const: "a", title: "Alpha" }] },
        },
      },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.options).toStrictEqual([{ value: "a", label: "Alpha" }]);
    // The verbatim payload still travels beside it: this member is a derived
    // projection and never a replacement for what the provider sent.
    expect(recorded[0]?.params).toMatchObject({ serverName: "files" });
  });

  it("omits the key entirely when the ask publishes no choice set", async () => {
    const recorded: CodexSessionServerRequest[] = [];
    const { ask } = await askHarness(recorded);

    await ask("item/commandExecution/requestApproval", { threadId: THREAD_ID });

    expect(recorded).toHaveLength(1);
    // KEY-PRESENCE: under `exactOptionalPropertyTypes` a present-but-undefined
    // key is a different value from an absent one, and absent is what this
    // member's contract describes.
    expect(Object.hasOwn(recorded[0] as object, "options")).toBe(false);
  });

  it("drops an over-large choice set with a diagnostic while the ask STILL normalizes", async () => {
    const recorded: CodexSessionServerRequest[] = [];
    const { harness, ask } = await askHarness(recorded);

    await ask("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: {
          pick: {
            type: "string",
            enum: Array.from({ length: CODEX_ASK_OPTION_SET_MAX + 1 }, (_u, i) => `opt-${i}`),
          },
        },
      },
    });

    // THE ASK STILL REACHED THE DAEMON. Refusing to normalize an ask because
    // its garnish did not parse would hang a turn over a decoration; the
    // free-text arm is unconditional and still carries it.
    expect(recorded).toHaveLength(1);
    expect(Object.hasOwn(recorded[0] as object, "options")).toBe(false);
    const drops = harness.driverDiagnostics.recentRecordsOfKind(
      "interactive_request_option_set_dropped",
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]?.rawWireType).toBe("mcpServer/elicitation/request");
    expect(drops[0]?.details["declaredOptionCount"]).toBe(CODEX_ASK_OPTION_SET_MAX + 1);
    expect(drops[0]?.details["optionSetMax"]).toBe(CODEX_ASK_OPTION_SET_MAX);
  });
});

describe("CodexLifecycleManager.replayTranscript (T3.20)", () => {
  // Plan-005 T3.20 / invariant I-005-8. Every case here turns on the same rule:
  // the seeding calls answering successfully is not evidence, and only the
  // target's own answer is.

  const TARGET = {
    providerSessionId: "session-tree-1",
    resumeHandle: THREAD_ID,
  } as const;

  /** A rendered transcript frame at the shape `exportTranscript` emits. */
  function frame(position: number, role: "participant" | "assistant", text: string): unknown {
    return { position, role, segments: [{ kind: "text", position, text }] };
  }

  const TRANSCRIPT: readonly unknown[] = [
    frame(1, "participant", "what changed in the parser?"),
    frame(2, "assistant", "the enclosure settle moved after the strip"),
    frame(3, "participant", "why that order?"),
    frame(4, "assistant", "stripping first orphans the tool calls"),
  ];

  /** Answers every seeded frame, and reports what the target holds. */
  function readbackAnswering(...turns: readonly string[]): ReplayTargetReadbackReader {
    return () => Promise.resolve<ReplayTargetReadback>({ kind: "turns", turns });
  }

  const SEEDED_BODIES: readonly string[] = [
    "what changed in the parser?",
    "the enclosure settle moved after the strip",
    "why that order?",
    "stripping first orphans the tool calls",
  ];

  function injectedFrameCount(harness: ManagerHarness): number {
    return harness.server.framesForMethod("thread/inject_items").length;
  }

  async function freshTarget(harness: ManagerHarness): Promise<void> {
    harness.server.on("thread/inject_items", () => ({ result: {} }));
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });
  }

  it("seeds frame by frame and CONFIRMS against the target's own answer", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    await freshTarget(harness);

    const result = await harness.manager.replayTranscript({
      target: TARGET,
      frames: [...TRANSCRIPT],
    });

    expect(result).toStrictEqual({ status: "applied", declaredLosses: [] });
    // The envelope is the WIRE contract, whose refinements this leg has to
    // satisfy rather than merely resemble — round-tripped instead of eyeballed,
    // because the `applied` arm carries its own rule (it may not declare
    // `conversation_history_summarized`) that a structural comparison cannot see.
    expect(DriverTranscriptReplayResultSchema.parse(result)).toStrictEqual(result);
    // One request per frame — the decision that makes an interior refusal an
    // observable state rather than an unknowable prefix.
    expect(injectedFrameCount(harness)).toBe(4);
  });

  // A REPLAY NEVER WRITES TO ANY SESSION BUT THE TARGET. Asserting that each
  // written frame carried `TARGET.resumeHandle` against ONE live session proves
  // nothing — the lookup matches records BY that handle, so the equality holds by
  // construction and no implementation can fail it. Two live sessions with
  // distinct threads make it a real claim: a leg that resolved the wrong record
  // writes a whole conversation into a stranger's session, and here that shows up
  // as frames on the second thread.
  it("writes only to the target's thread while another session is live", async () => {
    const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222" as SessionId;
    const OTHER_THREAD_ID = "01a04202-0148-7ae2-8560-000000000002";
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/inject_items", () => ({ result: {} }));

    // The BYSTANDER starts first, so a leg that reached for "the first session
    // this manager holds" rather than the one the handle names lands on it.
    harness.server.on("thread/start", () => ({
      result: {
        thread: { id: OTHER_THREAD_ID, sessionId: "session-tree-other", turns: [] },
      },
    }));
    await harness.manager.createSession({ sessionId: OTHER_SESSION_ID, config: SESSION_CONFIG });
    harness.server.on("thread/start", () => threadStartResult());
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] });

    const threadsWritten = harness.server
      .framesForMethod("thread/inject_items")
      .map((written) => (written["params"] as { threadId?: unknown }).threadId);
    expect(threadsWritten).toStrictEqual([
      TARGET.resumeHandle,
      TARGET.resumeHandle,
      TARGET.resumeHandle,
      TARGET.resumeHandle,
    ]);
    expect(threadsWritten).not.toContain(OTHER_THREAD_ID);
  });

  // A replay target is SINGLE-USE, and the success path is the one that has to
  // say so. `thread/inject_items` does not advance `turnBoundaries`, so the
  // freshness gate cannot see a session this driver itself just seeded: without
  // the ledger's success entry a second call writes the conversation in twice and
  // the assertion CONFIRMS it, because more answered turns than seeded is
  // tolerated and the tail still matches.
  it("burns a CONFIRMED target, so replaying the same handle twice is impossible", async () => {
    const harness = createManagerHarness({
      // Answers the doubled transcript — the reading a second replay would
      // actually produce, so this test fails on the ledger and not on the
      // readback being unrealistically stale.
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES, ...SEEDED_BODIES),
    });
    await freshTarget(harness);

    await harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] });
    expect(injectedFrameCount(harness)).toBe(4);

    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    // Refused BEFORE writing: the doubling never reached the provider.
    expect(injectedFrameCount(harness)).toBe(4);
  });

  // THE MANDATORY CASE. The fake provider accepts every `thread/inject_items`
  // request and then answers with an empty session — the untyped-injection
  // failure mode the whole assertion exists for.
  it("REFUSES a provider that accepts every frame and answers with zero turns", async () => {
    const harness = createManagerHarness({ transcriptReplayReadback: readbackAnswering() });
    await freshTarget(harness);

    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(PostReplayAssertionFailedError);
    // Every seeding call SUCCEEDED, which is exactly why the return value is
    // worth nothing as evidence.
    expect(injectedFrameCount(harness)).toBe(4);
  });

  // A RESUMED session is the reachable non-fresh target: its turn ledger is
  // seeded from the provider's own `thread.turns`, and that ledger IS the
  // session-position axis, so a non-empty one is proof the target has already
  // held a conversation. The gate costs no round trip and runs before any write.
  it("refuses a target that already holds turns, before writing anything", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    harness.server.on("thread/inject_items", () => ({ result: {} }));
    harness.server.on("thread/resume", () => threadStartResult(3));
    await harness.manager.resumeSession({ sessionId: SESSION_ID, resumeHandle: THREAD_ID });

    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/must be fresh/);
    expect(injectedFrameCount(harness)).toBe(0);
  });

  // NS-89's replay-target lifecycle: a prefix-accepted, then-refused target is
  // abandoned and never reused, so the memo settlement its caller falls back to
  // lands in a FRESH target and no surviving session holds both native frames
  // and a memo about the same exchanges.
  it("abandons a target refused mid-seeding, and never admits it again", async () => {
    let acceptedFrames = 0;
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    harness.server.on("thread/inject_items", () => {
      acceptedFrames += 1;
      return acceptedFrames <= 2
        ? { result: {} }
        : { error: { code: -32602, message: "unsupported item shape" } };
    });
    await harness.manager.createSession({ sessionId: SESSION_ID, config: SESSION_CONFIG });

    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/abandoned and must not be reused/);
    // A PREFIX was applied: the target is not pristine, which is what makes
    // reuse unsafe rather than merely untidy.
    expect(acceptedFrames).toBe(3);

    // The burn survives the session's disposal, so a caller holding the stale
    // handle is told what happened rather than being quietly re-admitted.
    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    expect(acceptedFrames).toBe(3);
  });

  it("abandons a target whose seeding delivery is AMBIGUOUS", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    await freshTarget(harness);
    // The bytes leave and no answer ever comes back: the transport classifies
    // the delivery `indeterminate`, and whether the frame landed is unknowable
    // from here. That is a different fact from a refusal, and it is the one that
    // makes a retry a duplicated turn rather than a second chance.
    harness.server.holdAnswers("thread/inject_items");

    const replaying = harness.manager.replayTranscript({
      target: TARGET,
      frames: [...TRANSCRIPT],
    });
    const rejects = expect(replaying).rejects.toThrow(/abandoned and must not be reused/);
    harness.scheduler.fireAll();
    await rejects;

    // No surviving session may hold a duplicated frame, so the ambiguous target
    // is refused for good rather than retried.
    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
  });

  it("abandons rather than confirming when no readback reader is bound", async () => {
    const harness = createManagerHarness();
    await freshTarget(harness);

    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/post-replay assertion cannot run/);
    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
  });

  it("treats a rejecting readback reader as unreadable, never as a pass", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: () => Promise.reject(new Error("target vanished")),
    });
    await freshTarget(harness);

    await expect(
      harness.manager.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(PostReplayAssertionFailedError);
  });

  // A replay NEVER writes to the session the transcript came from: the target is
  // resolved from the handle the caller passed, and a handle this manager holds
  // no session for is refused rather than established.
  it("refuses a target this manager holds no session for", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    await freshTarget(harness);

    await expect(
      harness.manager.replayTranscript({
        target: { providerSessionId: "session-tree-9", resumeHandle: "some-other-thread" },
        frames: [...TRANSCRIPT],
      }),
    ).rejects.toThrow(/No live Codex session is bound to replay target thread/);
    expect(injectedFrameCount(harness)).toBe(0);
  });

  it("refuses a frame carrying a segment kind it cannot represent, rather than skipping it", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    await freshTarget(harness);

    await expect(
      harness.manager.replayTranscript({
        target: TARGET,
        frames: [
          frame(1, "participant", "kept"),
          { position: 2, role: "assistant", segments: [{ kind: "hologram", position: 2 }] },
        ],
      }),
    ).rejects.toThrow(/unsupported segment kind/);
    // Parsed BEFORE anything is written, so an unrepresentable transcript costs
    // the provider nothing and leaves the target pristine.
    expect(injectedFrameCount(harness)).toBe(0);
  });

  it("refuses an empty transcript rather than confirming a replay of nothing", async () => {
    const harness = createManagerHarness({
      transcriptReplayReadback: readbackAnswering(...SEEDED_BODIES),
    });
    await freshTarget(harness);

    await expect(harness.manager.replayTranscript({ target: TARGET, frames: [] })).rejects.toThrow(
      /nothing to reconstitute/,
    );
  });
});
