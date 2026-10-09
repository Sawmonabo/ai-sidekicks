// Shared fakes for the Codex driver tests: a scripted Codex service host that is the process
// launcher, the short-command runner and the socket connector, the daemon ports the driver reports
// to, and the driver and manager harnesses built on them.

import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type ExecutionPosture,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { InboundDelivery, InboundOutcome } from "../../../../session/run/inbound.js";
import {
  makeManualScheduler,
  type ManualScheduler,
} from "../../../__fixtures__/manual-scheduler.js";
import type { PermissionAskPort } from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import { PortRegistration } from "../../../port/registration.js";
import type { CommandOutputPublisher } from "../../../port/command-output-publisher.js";
import type { ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import type { ToolServerRoute } from "../../../port/tool-server-route.js";
import type { CumulativeAxisReadings, MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import type { DriverResumeResult } from "../../contract.js";
import type { DaemonTurnBindingResolver } from "../../run-control.js";
import { DriverDiagnosticsEmitter, type DriverDiagnosticRecord } from "../../diagnostics.js";
import type { CodexServerPromptPort } from "../commands.js";
import { CodexDriver } from "../index.js";
import type { CodexSessionServerRequestResponder } from "../server-requests.js";
import type {
  CodexCommandRunner,
  CodexProcessLaunch,
  CodexServiceLauncher,
  CodexServiceProcess,
} from "../service/process.js";
import type { CodexHomeResolver } from "../service/registry.js";
import type { CodexServiceHome } from "../service/dependencies.js";
import type { CodexLifecycleOptions, CodexLostRunFailure } from "../session/state.js";
import type { CodexTransportDiagnostic } from "../transport/diagnostics.js";
import type {
  CodexServiceSocket,
  CodexServiceSocketConnector,
  CodexServiceSocketHandlers,
} from "../transport/socket.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../../../operating-system/darwin.js";

/** One scripted answer to a request the driver sent. */
export interface JsonRpcAnswer {
  result?: unknown;
  // `data` is optional on the wire; it carries the provider's structured refusal detail.
  error?: { code: number; message: string; data?: unknown };
  /**
   * Frames the service sends right after this answer, in the same turn of the event loop, so a
   * continuation of the answer runs after they were handled.
   */
  trailingFrames?: Array<Record<string, unknown>>;
}

type MethodHandler = (params: unknown, codexHome: string) => JsonRpcAnswer;

/** One message the driver sent, on the home whose service it reached. */
export interface SentFrame {
  readonly codexHome: string;
  readonly frame: Record<string, unknown>;
}

/** The home the node's default account runs in. */
export const DEFAULT_CODEX_HOME = "/homes/default";
/** A second account, on a home of its own. */
export const SECOND_ACCOUNT_ID = "account-b";
export const SECOND_CODEX_HOME = "/homes/account-b";
export const EXECUTABLE_PATH = "/opt/codex/bin/codex";
/** The home an account runs in, every one managed by the app. */
export function codexHomeFor(providerAccountId: string | undefined): CodexServiceHome {
  return {
    codexHome: providerAccountId === undefined ? DEFAULT_CODEX_HOME : `/homes/${providerAccountId}`,
    providerAccountId,
    isManaged: true,
  };
}

interface FakeProcessEntry {
  readonly codexHome: string;
  readonly resolveExit: (exit: ProcessExit) => void;
  isRunning: boolean;
}

interface FakeSocketEntry {
  readonly codexHome: string;
  /** The process the socket reached: the newest running on its home when it was dialed. */
  readonly process: FakeProcessEntry;
  readonly handlers: CodexServiceSocketHandlers;
  isOpen: boolean;
  /** The notifications the connection's `initialize` asked never to be sent, as Codex honors. */
  optedOutMethods: ReadonlySet<string>;
}

/**
 * Scripted Codex services, one per `CODEX_HOME`: each launch is one process, each dial one
 * websocket. Answers registered methods on a microtask, back to the socket that asked only.
 */
export class FakeCodexAppServer {
  readonly launches: CodexProcessLaunch[] = [];
  /** Every short command the driver ran, in order. */
  readonly commandRuns: CodexProcessLaunch[] = [];
  /** What `codex debug models` prints; a test sets the catalog it needs. */
  catalogDump: string = JSON.stringify({ models: [] });
  readonly sent: SentFrame[] = [];
  /** Rejects the driver's next send without closing the socket. */
  rejectNextSendWith: Error | undefined = undefined;
  /** The largest message, in bytes, the service says it takes; Codex names 16 MiB. */
  sentMessageByteLimit: number | undefined = 16 * 1024 * 1024;
  readonly #handlers = new Map<string, MethodHandler>();
  readonly #heldMethods = new Set<string>();
  readonly #heldEmissions = new Map<string, Array<() => void>>();
  readonly #sockets: FakeSocketEntry[] = [];
  readonly #processes: FakeProcessEntry[] = [];
  #nextServerRequestId = 9000;

  /** Starts one fake process; its home comes from the launch's `CODEX_HOME`. */
  readonly launchProcess: CodexServiceLauncher = (launch) => {
    this.launches.push(launch);
    const codexHome =
      launch.environment.find(([name]) => name === "CODEX_HOME")?.[1] ?? "(no CODEX_HOME)";
    let resolveExit: (exit: ProcessExit) => void = () => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const entry: FakeProcessEntry = { codexHome, resolveExit, isRunning: true };
    this.#processes.push(entry);
    const serviceProcess: CodexServiceProcess = {
      exited,
      stop: () => {
        this.#end(entry, { signal: "SIGTERM", outputTail: "(no output)" });
      },
      kill: () => {
        this.#end(entry, { signal: "SIGKILL", outputTail: "(no output)" });
      },
    };
    return serviceProcess;
  };

  /** Runs one short command: `debug models` prints {@link catalogDump}, anything else fails. */
  readonly runCommand: CodexCommandRunner = async (run) => {
    this.commandRuns.push(run);
    if (run.args.join(" ") !== "debug models") {
      throw new Error(`no scripted output for codex ${run.args.join(" ")}`);
    }
    return this.catalogDump;
  };

  /** Runs a service on `codexHome` that the daemon did not start, as the person's own. */
  runOwnService(codexHome: string): void {
    this.#processes.push({ codexHome, resolveExit: () => undefined, isRunning: true });
  }

  /** Whether a service runs on `codexHome` now. */
  isServiceRunning(codexHome: string): boolean {
    return this.#processes.some((entry) => entry.isRunning && entry.codexHome === codexHome);
  }

  /**
   * Opens one fake websocket on the home being dialed. With no process running there it waits,
   * as the real dial waits for the socket to appear, until the dial is called off.
   */
  readonly connectSocket: CodexServiceSocketConnector = async (_socketPath, handlers, options) => {
    await Promise.resolve();
    const servedBy = (): FakeProcessEntry | undefined =>
      this.#processes.findLast((entry) => entry.isRunning && entry.codexHome === options.codexHome);
    if (servedBy() === undefined) {
      await new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal.addEventListener("abort", () => {
          reject(options.signal.reason);
        });
      });
    }
    const process = servedBy();
    if (process === undefined) {
      throw new Error(`no process serves ${options.codexHome}`);
    }
    const entry: FakeSocketEntry = {
      codexHome: options.codexHome,
      process,
      handlers,
      isOpen: true,
      optedOutMethods: new Set(),
    };
    this.#sockets.push(entry);
    const namedLimit = (): number | undefined => this.sentMessageByteLimit;
    const socket: CodexServiceSocket = {
      get sentMessageByteLimit() {
        return namedLimit();
      },
      send: async (text) => {
        const rejection = this.rejectNextSendWith;
        if (rejection !== undefined) {
          this.rejectNextSendWith = undefined;
          throw rejection;
        }
        this.#receive(entry, text);
      },
      close: () => {
        this.#closeSocket(entry, "closed by the client");
      },
    };
    return socket;
  };

  on(method: string, handler: MethodHandler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  /** Every frame the driver sent, in order. */
  writtenFrames(): Array<Record<string, unknown>> {
    return this.sent.map((sent) => sent.frame);
  }

  framesForMethod(method: string, codexHome?: string): Array<Record<string, unknown>> {
    return this.sent
      .filter((sent) => codexHome === undefined || sent.codexHome === codexHome)
      .map((sent) => sent.frame)
      .filter((frame) => frame["method"] === method);
  }

  /** The params of every `method` request the driver sent. */
  paramsFor(method: string, codexHome?: string): Array<Record<string, unknown>> {
    return this.framesForMethod(method, codexHome).map(
      (frame) => frame["params"] as Record<string, unknown>,
    );
  }

  /** Where the first `method` request sits in the send order, or -1. */
  indexOfMethod(method: string): number {
    return this.sent.findIndex((sent) => sent.frame["method"] === method);
  }

  /** How many processes the daemon started on `codexHome`. */
  launchCountFor(codexHome: string): number {
    return this.launches.filter((launch) =>
      launch.environment.some(([name, value]) => name === "CODEX_HOME" && value === codexHome),
    ).length;
  }

  /** How many processes run now, on every home. */
  runningProcessCount(): number {
    return this.#processes.filter((entry) => entry.isRunning).length;
  }

  /** Sends a notification to every open connection on `codexHome`. */
  emitFrame(frame: Record<string, unknown>, codexHome: string = DEFAULT_CODEX_HOME): void {
    const text = JSON.stringify(frame);
    for (const entry of this.#sockets) {
      const method = frame["method"];
      const isOptedOut = typeof method === "string" && entry.optedOutMethods.has(method);
      if (entry.isOpen && entry.codexHome === codexHome && !isOptedOut) {
        entry.handlers.onMessage(text);
      }
    }
  }

  /**
   * Sends a server request on the home's first open connection and resolves with the answer the
   * driver wrote, after the queued work settles.
   */
  async askProvider(
    method: string,
    params: unknown = {},
    codexHome: string = DEFAULT_CODEX_HOME,
  ): Promise<Record<string, unknown>> {
    const requestId = (this.#nextServerRequestId += 1);
    const before = this.sent.length;
    const entry = this.#sockets.find((socket) => socket.isOpen && socket.codexHome === codexHome);
    if (entry === undefined) {
      throw new Error(`no open connection on ${codexHome}`);
    }
    entry.handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const answer = this.sent
      .slice(before)
      .find((sent) => sent.frame["id"] === requestId && !("method" in sent.frame));
    if (answer === undefined) {
      throw new Error(`the driver never answered the ${method} ask`);
    }
    return answer.frame;
  }

  /** Ends the home's running process on its own, as a crash. */
  emitExit(
    codexHome: string = DEFAULT_CODEX_HOME,
    exit: ProcessExit = { exitCode: 1, outputTail: "panicked" },
  ): void {
    for (const entry of this.#processes) {
      if (entry.isRunning && entry.codexHome === codexHome) {
        this.#end(entry, exit);
      }
    }
  }

  /** Closes every open connection on `codexHome` while its process runs on, as a dropped link. */
  dropConnections(codexHome: string = DEFAULT_CODEX_HOME): void {
    for (const entry of this.#sockets) {
      if (entry.codexHome === codexHome) {
        this.#closeSocket(entry, "the connection dropped");
      }
    }
  }

  /**
   * Suspends `method`'s answers until the returned release; the request is still recorded when it
   * is sent. The release answers in its own tick.
   */
  holdAnswers(method: string): () => void {
    this.#heldMethods.add(method);
    return () => {
      this.#heldMethods.delete(method);
      const emissions = this.#heldEmissions.get(method) ?? [];
      this.#heldEmissions.delete(method);
      for (const emit of emissions) {
        emit();
      }
    };
  }

  #receive(entry: FakeSocketEntry, text: string): void {
    if (!entry.isOpen) {
      throw new Error("the socket is closed");
    }
    const frame = JSON.parse(text) as Record<string, unknown>;
    this.sent.push({ codexHome: entry.codexHome, frame });
    const method = frame["method"];
    if (method === "initialize") {
      const capabilities = (frame["params"] as Record<string, unknown> | undefined)?.[
        "capabilities"
      ] as Record<string, unknown> | undefined;
      entry.optedOutMethods = new Set(
        (capabilities?.["optOutNotificationMethods"] as string[] | undefined) ?? [],
      );
    }
    const id = frame["id"];
    if (typeof method !== "string" || id === undefined) {
      return;
    }
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      return;
    }
    const answer = handler(frame["params"], entry.codexHome);
    const emit = (): void => {
      if (!entry.isOpen) {
        return;
      }
      entry.handlers.onMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...(answer.error === undefined ? { result: answer.result } : { error: answer.error }),
        }),
      );
      for (const trailing of answer.trailingFrames ?? []) {
        entry.handlers.onMessage(JSON.stringify(trailing));
      }
    };
    if (this.#heldMethods.has(method)) {
      this.#heldEmissions.set(method, [...(this.#heldEmissions.get(method) ?? []), emit]);
      return;
    }
    queueMicrotask(emit);
  }

  #end(entry: FakeProcessEntry, exit: ProcessExit): void {
    if (!entry.isRunning) {
      return;
    }
    entry.isRunning = false;
    for (const socket of this.#sockets) {
      if (socket.process === entry) {
        this.#closeSocket(socket, "the service ended");
      }
    }
    entry.resolveExit(exit);
  }

  #closeSocket(entry: FakeSocketEntry, detail: string): void {
    if (!entry.isOpen) {
      return;
    }
    entry.isOpen = false;
    entry.handlers.onClose(detail);
  }
}

/** A thread reply naming `threadId` and the profile the request asked for. */
export function threadReply(threadId: string, params: unknown, turnCount = 0): JsonRpcAnswer {
  const requested = (params as Record<string, unknown> | undefined)?.["permissions"];
  return {
    result: {
      thread: {
        id: threadId,
        sessionId: "session-tree-1",
        turns: Array.from({ length: turnCount }, (_unused, index) => ({ id: `turn-${index}` })),
      },
      activePermissionProfile: { id: requested, extends: null },
    },
  };
}

/** The hook commands the newest service started with, as its `-c` switches name them. */
export function launchedHookCommands(server: FakeCodexAppServer): string[] {
  const args = server.launches.at(-1)?.args ?? [];
  return args.flatMap((arg) => {
    const quoted = /^hooks\.\w+=.*command=("(?:[^"\\]|\\.)*")/.exec(arg)?.[1];
    return quoted === undefined ? [] : [JSON.parse(quoted) as string];
  });
}

/** The answers every service gives a request the test does not script itself. */
function answerDefaults(server: FakeCodexAppServer): void {
  let startedThreads = 0;
  let forkedThreads = 0;
  server
    .on("initialize", () => ({
      result: { userAgent: "ai-sidekicks-daemon/0.161.0 (Mac OS 26.0.0; arm64)" },
    }))
    .on("hooks/list", () => ({
      result: {
        data: [
          {
            hooks: launchedHookCommands(server).map((command, index) => ({
              source: "sessionFlags",
              command,
              key: `hook-${index}`,
              currentHash: `hash-${index}`,
              trustStatus: "untrusted",
            })),
          },
        ],
      },
    }))
    .on("config/value/write", () => ({ result: {} }))
    .on("thread/start", (params) => {
      startedThreads += 1;
      return threadReply(startedThreads === 1 ? THREAD_ID : `thread-${startedThreads}`, params);
    })
    .on("thread/resume", (params) =>
      threadReply(String((params as Record<string, unknown>)["threadId"]), params),
    )
    .on("thread/fork", (params) => {
      forkedThreads += 1;
      return threadReply(forkedThreadId(forkedThreads), params);
    })
    .on("thread/turns/list", () => ({ result: { data: [], nextCursor: null } }))
    .on("thread/unsubscribe", () => ({ result: {} }))
    // A conversation let go reads as unloaded, so a build move goes on without a close to wait for.
    .on("thread/read", () => ({ result: { thread: { status: { type: "notLoaded" } } } }))
    .on("thread/backgroundTerminals/list", () => ({ result: { data: [], nextCursor: null } }))
    .on("thread/backgroundTerminals/terminate", () => ({ result: {} }))
    .on("thread/backgroundTerminals/clean", () => ({ result: {} }))
    .on("model/list", () => ({ result: { data: [], nextCursor: null } }))
    .on("thread/settings/update", () => ({ result: {} }))
    // Answered so the resume-failure auth classification resolves on the manual scheduler.
    .on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
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
export const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;
export const SECOND_SESSION_ID = "44444444-4444-4444-8444-444444444444" as SessionId;
export const RUN_ID = "22222222-2222-4222-8222-222222222222" as RunId;
export const SECOND_RUN_ID = "33333333-3333-4333-8333-333333333333" as RunId;
export const THREAD_ID = "01a04202-0148-7ae2-8560-622babf33ed0";

/** The thread the `count`th `thread/fork` a service answers by default starts, from 1. */
export function forkedThreadId(count: number): string {
  return `thread-fork-${count}`;
}
export const TURN_ID = "turn-01";
/** A thread the session's thread starts, as `announceChildThread` announces it. */
export const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000001";

/** The run the harness's run engine starts for the `count`th child run, from 1. */
export function childRunId(count: number): RunId {
  return `66666666-6666-4666-8666-${String(count).padStart(12, "0")}` as RunId;
}
// The second run's turn. Two runs holding live turns is a state the sole-active-run fallback
// cannot answer in and turn-keyed attribution resolves exactly.
export const SECOND_TURN_ID = "turn-02";
export const SESSION_CWD = "/work/session";
const GIT_COMMON_FOLDER = "/work/repo/.git";
export const BASE_INSTRUCTIONS = "You are the session's agent.";
const TOOL_SERVER_BASE_URL = "http://127.0.0.1:4318/tools";

/** The posture a test session runs at unless a test names another. */
export const TEST_POSTURE: ExecutionPosture = {
  mode: "ask",
  writableRoots: [],
  credentialPolicyRef: "curated-default",
};

/** The agent the test session's runs belong to. */
export const AGENT_ID = "55555555-5555-4555-8555-555555555555";

/** The agent config a run on the test session starts from, on the harness's binding. */
export function runConfig(
  input = "hello",
  sessionId: SessionId = SESSION_ID,
): Record<string, unknown> {
  return { sessionId, bindingId: "binding-abc", agentId: AGENT_ID, input };
}

/** What the daemon's ports received. */
interface PortRecords {
  /** Every delivery the driver handed the run engine's inbound dispatch, in order. */
  readonly deliveries: InboundDelivery[];
  readonly endedTurns: Array<{ runId: RunId; exit: ProcessExit }>;
  readonly settledOutputSpeeds: Array<{
    sessionId: SessionId;
    runId: RunId;
    state: ProviderOutputSpeedState;
  }>;
  readonly relaunched: Array<{ sessionId: SessionId; result: DriverResumeResult }>;
  /** Every run the driver started for a turn of its own, in order. */
  readonly daemonTurnRunIds: RunId[];
  readonly lostRuns: Array<{ sessionId: SessionId; runId: RunId; failure: CodexLostRunFailure }>;
  readonly meteredUsage: Array<{ sessionId: SessionId; delta: MeteredUsageDelta }>;
}

/** The registrations the driver hands admitted asks, blocks and prompt reads to. */
interface HarnessPorts {
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  readonly questions: PortRegistration<QuestionPort>;
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  readonly serverPrompts: PortRegistration<CodexServerPromptPort>;
  readonly commandOutput: PortRegistration<CommandOutputPublisher>;
}

/** What a harness can change about the driver it builds. */
export interface HarnessOptions {
  readonly steer?: boolean;
  readonly answerCallbackToolCall?: CodexSessionServerRequestResponder;
  readonly readPriorEmittedUsage?: (
    sessionId: SessionId,
    threadId: string,
  ) => CumulativeAxisReadings | undefined;
  readonly newBindingId?: () => string;
  /** The crash window's clock, in milliseconds. */
  readonly now?: () => number;
  /** The socket the daemon's hook programs reach it on; absent, services run no hooks. */
  readonly hookSocketPath?: string;
  /** Where sessions' helper role files are written; absent, a folder no harness writes to. */
  readonly helperRolesFolder?: string;
  /** Answers one delivery in place of the run engine's usual outcome. */
  readonly answerDelivery?: (delivery: InboundDelivery) => InboundOutcome | undefined;
  /** The home each account runs in; absent, {@link codexHomeFor}. */
  readonly homes?: CodexHomeResolver;
  /** Opens the binding of a run the driver starts itself; absent, the session's own binding. */
  readonly openDaemonTurnBinding?: DaemonTurnBindingResolver["openDaemonTurnBinding"];
  /** Points a binding at the conversation a fork moved its session to; absent, nothing does. */
  readonly rebindRuntimeBinding?: CodexLifecycleOptions["rebindRuntimeBinding"];
}

/** A driver over the fake host, and everything it reported. */
export interface Harness extends PortRecords {
  readonly server: FakeCodexAppServer;
  readonly driver: CodexDriver;
  readonly ports: HarnessPorts;
  readonly diagnostics: CodexTransportDiagnostic[];
  readonly driverDiagnostics: DriverDiagnosticsEmitter;
  readonly driverDiagnosticRecords: DriverDiagnosticRecord[];
  readonly scheduler: ManualScheduler;
}

// The outcome the run engine gives a delivery it admits: an ask admitted, a child run started
// under a fresh id, a turn opened, anything else taken.
function admitDelivery(delivery: InboundDelivery, childRunCount: number): InboundOutcome {
  switch (delivery.kind) {
    case "permission_ask":
      return { disposition: "ask_admitted" };
    case "child_run":
      return {
        disposition: "child_run_started",
        runId: childRunId(childRunCount),
      };
    case "turn_boundary":
      return { disposition: "turn_opened" };
    default:
      return { disposition: "published" };
  }
}

/** Builds a driver over a fresh fake host, recording every port it reports to. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const server = new FakeCodexAppServer();
  answerDefaults(server);
  const diagnostics: CodexTransportDiagnostic[] = [];
  const driverDiagnosticRecords: DriverDiagnosticRecord[] = [];
  const driverDiagnostics = new DriverDiagnosticsEmitter({
    logSink: { record: (record) => driverDiagnosticRecords.push(record) },
    counterSink: { increment: () => undefined },
  });
  const scheduler = makeManualScheduler();
  const records: PortRecords = {
    deliveries: [],
    endedTurns: [],
    settledOutputSpeeds: [],
    relaunched: [],
    daemonTurnRunIds: [],
    lostRuns: [],
    meteredUsage: [],
  };
  const ports: HarnessPorts = {
    permissionAsks: new PortRegistration<PermissionAskPort>("permission asks"),
    questions: new PortRegistration<QuestionPort>("questions"),
    reviewerDenials: new PortRegistration<ReviewerDenialPort>("reviewer denials"),
    serverPrompts: new PortRegistration<CodexServerPromptPort>("server prompts"),
    commandOutput: new PortRegistration<CommandOutputPublisher>("command output"),
  };
  const toolServerRoute = new PortRegistration<ToolServerRoute>("tool server route");
  toolServerRoute.register({
    urlFor: (sessionId, serverName) => `${TOOL_SERVER_BASE_URL}/${sessionId}/${serverName}`,
  });
  let childRunCount = 0;
  const lifecycleOptions: CodexLifecycleOptions = {
    providerCommand: async () => EXECUTABLE_PATH,
    providerBaseEnvironment: [["PATH", "/usr/bin"]],
    operatingSystem: DARWIN_PROVIDER_OPERATING_SYSTEM,
    homes: options.homes ?? {
      codexHomeFor: async (providerAccountId) => codexHomeFor(providerAccountId),
    },
    spawnContext: {
      resolveSpawnContext: async () => ({
        workingDirectory: SESSION_CWD,
        gitCommonFolder: GIT_COMMON_FOLDER,
        environmentRows: undefined,
        baseInstructions: BASE_INSTRUCTIONS,
      }),
    },
    credentialPolicy: {
      resolveCredentialPolicy: async (credentialPolicyRef) => ({
        credentialPolicyRef,
        denyPaths: ["/home/agent/.ssh"],
        denyEnvVars: [],
      }),
    },
    toolServerRoute,
    hookSocketPath: options.hookSocketPath,
    // A session that defines no helper writes nothing, so the default folder stays empty.
    helperRolesFolder:
      options.helperRolesFolder ?? path.join(tmpdir(), "codex-helper-roles-unwritten"),
    launchProcess: server.launchProcess,
    runCommand: server.runCommand,
    connectSocket: server.connectSocket,
    executableResolver: {
      realpath: async (candidate) => candidate,
      isExecutableFile: async () => true,
      platform: "darwin",
      workingDirectory: "/",
    },
    reportDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    diagnostics: driverDiagnostics,
    scheduleTimeout: scheduler.schedule,
    now: options.now ?? ((): number => 0),
    newBindingId: options.newBindingId ?? ((): string => "binding-abc"),
    runEngine: {
      startDaemonTurn: async (request) => {
        const ordinal = String(records.daemonTurnRunIds.length).padStart(12, "0");
        const runId = `77777777-7777-4777-8777-${ordinal}` as RunId;
        records.daemonTurnRunIds.push(runId);
        await request.startTurn(runId);
        return runId;
      },
      endTurnOnProcessExit: async (runId, exit) => {
        records.endedTurns.push({ runId, exit });
      },
      recordSettledOutputSpeed: async (sessionId, runId, state) => {
        records.settledOutputSpeeds.push({ sessionId, runId, state });
      },
    },
    daemonTurnBindings: {
      openDaemonTurnBinding:
        options.openDaemonTurnBinding ??
        (async () => ({
          bindingId: "binding-abc",
          agentId: AGENT_ID as AgentId,
        })),
    },
    inbound: {
      dispatch: async (delivery) => {
        records.deliveries.push(delivery);
        if (delivery.kind === "child_run") {
          childRunCount += 1;
        }
        return options.answerDelivery?.(delivery) ?? admitDelivery(delivery, childRunCount);
      },
    },
    ...ports,
    onSessionRelaunched: (sessionId, result) => {
      records.relaunched.push({ sessionId, result });
    },
    rebindRuntimeBinding: options.rebindRuntimeBinding ?? (async () => undefined),
    onLostRunFailure: (sessionId, runId, failure) => {
      records.lostRuns.push({ sessionId, runId, failure });
    },
    onMeteredUsage: (sessionId, delta) => {
      records.meteredUsage.push({ sessionId, delta });
    },
    ...(options.readPriorEmittedUsage === undefined
      ? {}
      : { readPriorEmittedUsage: options.readPriorEmittedUsage }),
    ...(options.answerCallbackToolCall === undefined
      ? {}
      : { answerCallbackToolCall: options.answerCallbackToolCall }),
  };
  const driver = new CodexDriver({
    ...lifecycleOptions,
    readCapabilities: () => makeCapabilities(options.steer ?? true),
  });
  return {
    ...records,
    server,
    driver,
    ports,
    diagnostics,
    driverDiagnostics,
    driverDiagnosticRecords,
    scheduler,
  };
}

/**
 * The `model_context_window` the driver's last `method` request carried in its `config`, or
 * `"omitted"` when it carried none.
 */
export function sentContextWindow(harness: Harness, method: string): unknown {
  const config = harness.server.paramsFor(method).at(-1)?.["config"] as Record<string, unknown>;
  return Object.hasOwn(config, "model_context_window") ? config["model_context_window"] : "omitted";
}

/** The deliveries of one kind the driver handed the run engine, in order. */
export function deliveriesOf<Kind extends InboundDelivery["kind"]>(
  harness: Harness,
  kind: Kind,
): Array<Extract<InboundDelivery, { kind: Kind }>> {
  return harness.deliveries.filter(
    (delivery): delivery is Extract<InboundDelivery, { kind: Kind }> => delivery.kind === kind,
  );
}

/** Opens the test session on the driver, at {@link TEST_POSTURE} unless told otherwise. */
export async function createdSession(
  harness: Harness,
  overrides: { sessionId?: SessionId; providerAccountId?: string; posture?: ExecutionPosture } = {},
): Promise<{ resumeHandle: string }> {
  return await harness.driver.createSession({
    model: TEST_MODEL,
    largerWindow: undefined,
    sessionId: overrides.sessionId ?? SESSION_ID,
    config: {},
    executionPosture: overrides.posture ?? TEST_POSTURE,
    ...(overrides.providerAccountId === undefined
      ? {}
      : { providerAccountId: overrides.providerAccountId }),
  });
}

/**
 * A `turn/completed` frame at the pinned shape (`params.turn.{id,status}`) carrying one
 * model-output item, as an ordinary turn ends.
 */
export function turnCompletedFrame(
  turnId: string,
  status: string,
  threadId: string = THREAD_ID,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, status, items: [{ type: "agentMessage", id: "item-1" }] },
    },
  };
}

/** Announces `CHILD_THREAD_ID` as a thread of `threadSourceKind` the session's thread started. */
export function announceChildThread(harness: Harness, threadSourceKind: string): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "thread/started",
    params: { thread: { id: CHILD_THREAD_ID, parentThreadId: THREAD_ID, threadSourceKind } },
  });
}
