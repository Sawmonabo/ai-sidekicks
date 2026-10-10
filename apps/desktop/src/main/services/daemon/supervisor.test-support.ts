// A background service played by a test, for the supervisor's suites: what each connect meets,
// how each call is answered, and the processes main starts, finds and ends, each exiting a second
// after it is ended.

import {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcTransportUnavailableError,
  type ClientTransport,
  type DaemonConnection as DaemonClientConnection,
  type DaemonConnectionObserver,
} from "@ai-sidekicks/client-sdk";
import { JSONRPC_VERSION, type JsonRpcRequest } from "@ai-sidekicks/contracts/jsonrpc/message";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  CURRENT_PROTOCOL_VERSION,
  NEGOTIATION_VERSION_MISMATCH_CODE,
  type DaemonHelloAck,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { DAEMON_REPAIRING_CODE } from "@ai-sidekicks/contracts/daemon/recovery";
import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon/status";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { DeviceIdSchema, type DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { expect, vi } from "vitest";

import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { DaemonLink } from "./link/status.js";
import { DaemonSupervisor } from "./supervisor.js";
import type { ServiceEnding, ServiceExit, ServiceProcess } from "./service/process.js";

/** The process id of the service the supervisor finds running. */
export const FOUND_SERVICE_PROCESS_ID = 3000;

/** The service's own device id, which its hello names as the calling device. */
export const SERVICE_DEVICE_ID: DeviceId = DeviceIdSchema.parse("service-device");

/** A service on the protocol main speaks. */
export const COMPATIBLE_HELLO: DaemonHelloAck = {
  compatible: true,
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  deviceId: SERVICE_DEVICE_ID,
};

/** A service on a newer protocol than main speaks. */
export const INCOMPATIBLE_HELLO: DaemonHelloAck = {
  compatible: false,
  protocolVersion: "2027-01-01",
  deviceId: SERVICE_DEVICE_ID,
  reason: "version.floor_exceeded",
  daemonSupportedProtocols: ["2027-01-01"],
};

/** One connection the scripted service opened: the requests main sent, and its close. */
export interface ScriptedLink {
  readonly requests: string[];
  /** The service drops the connection with `reason`. */
  closeWith(reason: Error): void;
  /** Whether main closed it. */
  readonly isClosedByMain: () => boolean;
}

/** How the scripted service answers a call: at once, after `delayMs`, refused, or never. */
export type CallAnswer = "answered" | { readonly delayMs: number } | "refused" | "silent";

/** How the scripted service answers the next connect; `repairing` refuses the hello while so. */
export type ConnectAnswer =
  | { readonly kind: "absent" }
  | { readonly kind: "answering"; readonly hello: DaemonHelloAck; readonly answersPing: boolean }
  | { readonly kind: "repairing" }
  | { readonly kind: "silent" };

/** A background service played by the test: what each connect meets, and the starts asked for. */
export class ScriptedService {
  public readonly links: ScriptedLink[] = [];
  public readonly connectTimes: number[] = [];
  public readonly startTimes: number[] = [];
  /** Each process main ended, as its id and the cause it gave. */
  public readonly endedServices: string[] = [];
  /** Each ending main asked for, in order. */
  public readonly endings: ServiceEnding[] = [];
  /** When each `daemon.stop` or `daemon.restart` reached the service. */
  public readonly stopsReceivedAt: number[] = [];
  /** The process id the status read reports: the found service's until a start replaces it. */
  public runningProcessId: number = FOUND_SERVICE_PROCESS_ID;
  /** Whether the status read names the service's process; an older protocol's reply may not. */
  public isIdentityReported = true;
  /** Whether ending a process fails, as a failed look at the system would. */
  public isEndingFailing = false;
  readonly #exits = new Map<number, PromiseWithResolvers<ServiceExit>>();
  /** How a link answers `daemon.flush`. */
  public flushAnswer: CallAnswer = "answered";
  /** How a link answers `daemon.stop` and `daemon.restart`. */
  public stopAnswer: CallAnswer = "answered";
  /** How a link answers `daemon.status.read`. */
  public statusReadAnswer: CallAnswer = "answered";
  /** The abort signal each connect was handed, in order. */
  public readonly connectSignals: AbortSignal[] = [];
  /** Failures the next connects meet, in order, before `connectAnswer` applies. */
  public readonly connectFailures: Error[] = [];
  public connectAnswer: ConnectAnswer = { kind: "absent" };
  /** What a start leaves the next connect meeting; `undefined` makes the start fail. */
  public afterStart: ConnectAnswer | undefined = {
    kind: "answering",
    hello: COMPATIBLE_HELLO,
    answersPing: true,
  };

  public connect = (
    observer: DaemonConnectionObserver,
    signal: AbortSignal,
  ): Promise<DaemonClientConnection> => {
    this.connectTimes.push(Date.now());
    this.connectSignals.push(signal);
    const failure = this.connectFailures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const answer = this.connectAnswer;
    if (answer.kind === "absent") {
      return Promise.reject(
        new JsonRpcTransportUnavailableError(
          "/run/daemon.sock",
          Object.assign(new Error("no"), { code: "ENOENT" }),
        ),
      );
    }
    if (answer.kind === "repairing") {
      return Promise.reject(
        new JsonRpcRemoteError(JsonRpcErrorCode.InvalidRequest, "repairing the database file", {
          type: DAEMON_REPAIRING_CODE,
        }),
      );
    }
    if (answer.kind === "silent") {
      return new Promise(() => undefined);
    }
    return Promise.resolve(this.#open(observer, answer.hello, answer.answersPing));
  };

  public startService = (): Promise<ServiceProcess> => {
    this.startTimes.push(Date.now());
    if (this.afterStart === undefined) {
      return Promise.reject(Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
    }
    this.connectAnswer = this.afterStart;
    this.runningProcessId = 4000 + this.startTimes.length;
    return Promise.resolve(this.#processOf(this.runningProcessId));
  };

  public attachServiceProcess = (identity: ProcessIdentity): ServiceProcess =>
    this.#processOf(identity.processId);

  /** The process with `processId` exits as `exit` says. */
  public exit(processId: number, exit: ServiceExit): void {
    this.#exitOf(processId).resolve(exit);
  }

  #exitOf(processId: number): PromiseWithResolvers<ServiceExit> {
    const exited = this.#exits.get(processId) ?? Promise.withResolvers<ServiceExit>();
    this.#exits.set(processId, exited);
    return exited;
  }

  /** The process with `processId`; every handle to one process id sees the same exit. */
  #processOf(processId: number): ServiceProcess {
    const exited = this.#exitOf(processId);
    let hasExited = false;
    void exited.promise.then(() => {
      hasExited = true;
    });
    return {
      processId,
      hasExited: () => hasExited,
      whenExited: () => exited.promise,
      // An ended service exits 1 second later, inside the 2 seconds before its kill.
      end: (ending) => {
        this.endedServices.push(`${String(processId)} ${ending.cause}`);
        this.endings.push(ending);
        if (this.isEndingFailing) {
          return Promise.reject(new Error("ps could not run"));
        }
        setTimeout(() => {
          exited.resolve({ code: 0, signal: null });
        }, 1_000);
        return Promise.resolve();
      },
    };
  }

  #open(
    observer: DaemonConnectionObserver,
    hello: DaemonHelloAck,
    answersPing: boolean,
  ): DaemonClientConnection {
    const requests: string[] = [];
    let deliver: ((message: never) => void) | undefined;
    let onClose: ((reason?: Error) => void) | undefined;
    let isClosedByMain = false;
    const transport: ClientTransport = {
      send: (envelope) => {
        if (!("id" in envelope)) {
          return;
        }
        const request = envelope as JsonRpcRequest;
        requests.push(request.method);
        if (request.method === "daemon.stop" || request.method === "daemon.restart") {
          this.stopsReceivedAt.push(performance.now());
        }
        const answer = this.#answerOf(request.method, answersPing);
        if (answer !== undefined) {
          const reply = (): void => {
            observer.frameReceived();
            deliver?.({ jsonrpc: JSONRPC_VERSION, id: request.id, ...answer.frame } as never);
          };
          if (answer.delayMs === 0) {
            queueMicrotask(reply);
          } else {
            setTimeout(reply, answer.delayMs);
          }
        }
      },
      onMessage: (handler) => {
        deliver = handler as (message: never) => void;
      },
      onClose: (handler) => {
        onClose = handler;
      },
      close: () => {
        isClosedByMain = true;
        observer.closed(undefined);
        onClose?.(undefined);
        return Promise.resolve();
      },
    };
    const client = new JsonRpcClient(transport, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      maxQueuedValuesPerSubscription: 8,
    });
    // The handshake's own reply is the link's first frame.
    observer.frameReceived();
    this.links.push({
      requests,
      closeWith: (reason) => {
        observer.closed(reason);
        onClose?.(reason);
      },
      isClosedByMain: () => isClosedByMain,
    });
    return { client, hello, close: transport.close };
  }

  /** How the service answers `method`, or `undefined` when it leaves the call unanswered. */
  #answerOf(
    method: string,
    answersPing: boolean,
  ): { frame: { result: unknown } | { error: unknown }; delayMs: number } | undefined {
    switch (method) {
      case "daemon.ping":
        return answersPing ? { frame: { result: {} }, delayMs: 0 } : undefined;
      case "daemon.flush":
        return scriptedAnswer(this.flushAnswer, { flushed: true });
      case "daemon.status.read":
        return scriptedAnswer(this.statusReadAnswer, this.#statusRead());
      case "daemon.stop":
      case "daemon.restart":
        return scriptedAnswer(this.stopAnswer, { accepted: true });
      default:
        return undefined;
    }
  }

  #statusRead(): DaemonStatusReadResponse | Record<string, never> {
    if (!this.isIdentityReported) {
      return {};
    }
    const readAt = new Date().toISOString();
    return {
      processState: "running",
      processIdentity: {
        processId: this.runningProcessId,
        bootId: "boot-1",
        processStartTime: `start of ${String(this.runningProcessId)}`,
      },
      version: "1.0.0",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      transportEndpoint: "/run/daemon.sock",
      startedAt: readAt,
      uptimeMs: 0,
      dataDirectory: "/home/person/.ai-sidekicks",
      processor: { percent: 0, readAt },
      memory: { residentBytes: 1, readAt },
      recovery: { overall: "healthy", sessions: [] },
    };
  }
}

/** The frame a scripted call answers with, or `undefined` when it never answers. */
function scriptedAnswer(
  answer: CallAnswer,
  result: unknown,
): { frame: { result: unknown } | { error: unknown }; delayMs: number } | undefined {
  if (answer === "silent") {
    return undefined;
  }
  if (answer === "refused") {
    return {
      frame: {
        error: {
          code: JsonRpcErrorCode.InvalidRequest,
          message: "protocol version mismatch",
          data: { type: NEGOTIATION_VERSION_MISMATCH_CODE },
        },
      },
      delayMs: 0,
    };
  }
  return { frame: { result }, delayMs: answer === "answered" ? 0 : answer.delayMs };
}

/** A supervisor over a scripted service, and every connection state its link reported. */
export interface SupervisorUnderTest {
  readonly service: ScriptedService;
  readonly link: DaemonLink;
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly supervisor: DaemonSupervisor;
  readonly connections: DaemonConnection[];
}

/** A fresh scripted service and the supervisor over it; the suite installs fake timers first. */
export function supervisorOverScriptedService(): SupervisorUnderTest {
  const service = new ScriptedService();
  const link = new DaemonLink();
  const connections: DaemonConnection[] = [];
  link.subscribe((state) => {
    connections.push(state.connection);
  });
  const log = { write: vi.fn() };
  const supervisor = new DaemonSupervisor({
    link,
    connect: service.connect,
    startService: service.startService,
    attachServiceProcess: service.attachServiceProcess,
    log,
  });
  return { service, link, log, supervisor, connections };
}

/** Start the supervisor with the service found running, and let the link come up. */
export async function linkToRunningService(
  under: SupervisorUnderTest,
  answersPing = true,
): Promise<void> {
  under.service.connectAnswer = { kind: "answering", hello: COMPATIBLE_HELLO, answersPing };
  under.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(under.link.state.connection).toStrictEqual({ kind: "connected" });
}

/** Start the supervisor with no service running, so the app starts one, and link to it. */
export async function linkToStartedService(under: SupervisorUnderTest): Promise<void> {
  under.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(under.link.state.startedByApp).toBe(true);
}
