// A background service played by a test behind a fake client helper, for the supervisor's suites:
// what each connect meets, how each call is answered, the processes main starts and the endings it
// asks the helper for, each ending settling a second after it began.

import type { DaemonEndingOutcome, DaemonEndingRequest } from "@ai-sidekicks/client-sdk";
import {
  DAEMON_REPAIRING_CODE,
  type DaemonRepairingDetails,
} from "@ai-sidekicks/contracts/daemon/recovery";
import type { ServiceStatusFile } from "@ai-sidekicks/contracts/daemon/service-status";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  CONNECTION_UNAVAILABLE_CODE,
  type JsonRpcError,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  CONNECTION_VERSION_MISMATCH_CODE,
  CURRENT_PROTOCOL_VERSION,
  type ConnectionInitializeResponse,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { expect, vi } from "vitest";

import { NOT_ANSWERING_MESSAGE, type DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import {
  DaemonRefusal,
  type ClientHelperConnectOutcome,
  type ClientHelperListener,
} from "./client/process.js";
import { DaemonLink } from "./link/status.js";
import type { ServiceExit, StartedService } from "./service/start.js";
import { DaemonSupervisor, type DaemonSupervisorOptions } from "./supervisor.js";

/** The process id of the service the supervisor finds running. */
export const FOUND_SERVICE_PROCESS_ID = 3000;

/** How long each ending the fake helper runs takes to settle, as the process ends. */
export const ENDING_MS = 1_000;

/** The handshake deadline the fake helper reports. */
export const HANDSHAKE_DEADLINE_MS = 8_000;

/** One link a connect opened: the methods main called on it, and whether main closed it. */
export interface ScriptedLink {
  readonly requests: string[];
  /** Whether main closed it. */
  readonly isClosedByMain: () => boolean;
}

/** The link a connect opened, and the rejections of the calls still unanswered on it. */
interface OpenLink {
  readonly link: ScriptedLink;
  isClosed: boolean;
  readonly unanswered: Set<(failure: Error) => void>;
}

/** How the scripted service answers a call: at once, refused, or never. */
export type CallAnswer = "answered" | "refused" | "silent";

/**
 * What a connect meets: no socket, a link (`compatible` or not), a service still writing its
 * token, one repairing with the refusal's `fields`, or nothing until the client's wait runs out.
 */
export type ConnectAnswer =
  | { readonly kind: "absent" }
  | { readonly kind: "answering"; readonly isCompatible?: boolean }
  | { readonly kind: "noToken" }
  | { readonly kind: "repairing"; readonly fields: Record<string, unknown> }
  | { readonly kind: "silent" };

/** One connect main made: when, and whether it waited for a starting service. */
export interface ScriptedConnect {
  readonly at: number;
  readonly waitsForStart: boolean;
}

/** The refusal a connect meets where no socket answers. */
const NO_SOCKET: JsonRpcError = {
  code: JsonRpcErrorCode.DomainRefusal,
  message: "the service is not listening",
  data: { type: CONNECTION_UNAVAILABLE_CODE, category: "unavailable" },
};

/** A background service played by the test: what each connect meets, and the starts asked for. */
export class ScriptedService {
  public readonly links: ScriptedLink[] = [];
  public readonly connects: ScriptedConnect[] = [];
  public readonly startTimes: number[] = [];
  /** Each ending main asked for, in order: `stop`, `restart`, or `process <id>`, with when. */
  public readonly endings: { readonly at: number; readonly ending: string }[] = [];
  /** The process id the status read reports: the found service's until a start replaces it. */
  public runningProcessId: number = FOUND_SERVICE_PROCESS_ID;
  /** What the client's ending answers. */
  public endingOutcome: DaemonEndingOutcome = { end: "exited" };
  /** What the status file holds. */
  public statusFile: ServiceStatusFile | undefined;
  readonly #exits = new Map<number, PromiseWithResolvers<ServiceExit>>();
  /** How a link answers `daemon.flush`. */
  public flushAnswer: CallAnswer = "answered";
  /** How a link answers `daemon.status.read`. */
  public statusReadAnswer: CallAnswer = "answered";
  /** What a probe meets. */
  public connectAnswer: ConnectAnswer = { kind: "absent" };
  /** What the wait for a starting service meets; `undefined` meets what a probe does. */
  public waitAnswer: ConnectAnswer | undefined;
  /** What a start leaves connects meeting; `undefined` makes the start fail. */
  public afterStart: ConnectAnswer | undefined = { kind: "answering" };
  /** Whether main ended the helper at quit. */
  public isHelperDisposed = false;
  #listener: ClientHelperListener | undefined;
  #current: OpenLink | undefined;

  /** The client helper the supervisor drives, over this service. */
  public readonly helper: DaemonSupervisorOptions["helper"] = {
    listen: (listener) => {
      this.#listener = listener;
    },
    connect: (waitsForStart) => this.#connect(waitsForStart),
    closeLink: () => {
      this.#closeCurrent();
    },
    dispose: () => {
      this.isHelperDisposed = true;
      this.#closeCurrent();
    },
    call: (method) => this.#call(method),
    subscribe: () => () => undefined,
    facts: () =>
      Promise.resolve({
        kind: "helper.started",
        handshakeDeadlineMs: HANDSHAKE_DEADLINE_MS,
        flushWaitMs: ENDING_MS,
        statusFile: { path: "status.json" },
      }),
    endDaemon: (request: DaemonEndingRequest) => this.#ending(request),
    endDaemonProcess: (identity: ProcessIdentity) =>
      this.#ending(`process ${String(identity.processId)}`),
    readProcessIdentity: (processId: number) => Promise.resolve(identityOf(processId)),
  };

  public startService = (): Promise<StartedService> => {
    this.startTimes.push(Date.now());
    if (this.afterStart === undefined) {
      return Promise.reject(
        Object.assign(new Error("spawn sidekicks-daemon ENOENT"), { code: "ENOENT" }),
      );
    }
    this.connectAnswer = this.afterStart;
    this.waitAnswer = undefined;
    this.runningProcessId = 4000 + this.startTimes.length;
    const processId = this.runningProcessId;
    const exited = this.#exitOf(processId);
    let hasExited = false;
    void exited.promise.then(() => {
      hasExited = true;
    });
    return Promise.resolve({
      processId,
      hasExited: () => hasExited,
      whenExited: () => exited.promise,
    });
  };

  public readServiceStatus = (): Promise<ServiceStatusFile | undefined> =>
    Promise.resolve(this.statusFile);

  /** The started process with `processId` exits as `exit` says. */
  public exit(processId: number, exit: ServiceExit): void {
    this.#exitOf(processId).resolve(exit);
  }

  /** The open link is lost: the client fails the calls on it and reports it `state`. */
  public loseLink(state: "silent" | "down" = "silent"): void {
    this.#failUnanswered();
    this.#listener?.linkStateChanged(state);
  }

  /** The client helper exits. */
  public exitHelper(): void {
    this.#closeCurrent();
    this.#listener?.exited();
  }

  /** A starting service answers the client's wait that it is repairing, as `details` say. */
  public answerRepairing(details: DaemonRepairingDetails): void {
    this.#listener?.repairing(details);
  }

  #ending(ending: string): Promise<DaemonEndingOutcome> {
    this.endings.push({ at: Date.now(), ending });
    const outcome = this.endingOutcome;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(outcome);
      }, ENDING_MS);
    });
  }

  /** Closes the open link, failing every call still unanswered on it as the helper does. */
  #closeCurrent(): void {
    const current = this.#current;
    if (current === undefined || current.isClosed) {
      return;
    }
    current.isClosed = true;
    this.#failUnanswered();
  }

  #failUnanswered(): void {
    const unanswered = this.#current?.unanswered ?? new Set();
    for (const fail of unanswered) {
      fail(new Error(NOT_ANSWERING_MESSAGE));
    }
    unanswered.clear();
  }

  #connect(waitsForStart: boolean): Promise<ClientHelperConnectOutcome> {
    this.connects.push({ at: Date.now(), waitsForStart });
    const answer = (waitsForStart ? this.waitAnswer : undefined) ?? this.connectAnswer;
    switch (answer.kind) {
      case "absent":
        return Promise.resolve({ error: NO_SOCKET });
      case "noToken":
        return Promise.resolve({
          error: {
            code: JsonRpcErrorCode.InternalError,
            message: "The background service's token file could not be read",
          },
        });
      case "repairing":
        return Promise.resolve({
          error: {
            code: JsonRpcErrorCode.DomainRefusal,
            message: "repairing the database file",
            data: { type: DAEMON_REPAIRING_CODE, category: "unavailable", fields: answer.fields },
          },
        });
      case "silent":
        return new Promise(() => undefined);
      case "answering": {
        const requests: string[] = [];
        const current: OpenLink = {
          link: { requests, isClosedByMain: () => current.isClosed },
          isClosed: false,
          unanswered: new Set(),
        };
        this.links.push(current.link);
        this.#current = current;
        return Promise.resolve({
          initializeResponse: initializeResponseOf(answer.isCompatible ?? true),
        });
      }
    }
  }

  #call<Response>(method: string): Promise<Response> {
    const current = this.#current;
    if (current === undefined || current.isClosed) {
      return Promise.reject(new Error(NOT_ANSWERING_MESSAGE));
    }
    current.link.requests.push(method);
    const answered = Promise.withResolvers<Response>();
    current.unanswered.add(answered.reject);
    void this.#answer<Response>(method).then(answered.resolve, answered.reject);
    return answered.promise;
  }

  #answer<Response>(method: string): Promise<Response> {
    switch (method) {
      case "daemon.flush":
        return scripted(this.flushAnswer, { flushed: true });
      case "daemon.status.read":
        return scripted(this.statusReadAnswer, {
          processIdentity: identityOf(this.runningProcessId),
        });
      default:
        return new Promise(() => undefined);
    }
  }

  #exitOf(processId: number): PromiseWithResolvers<ServiceExit> {
    const exited = this.#exits.get(processId) ?? Promise.withResolvers<ServiceExit>();
    this.#exits.set(processId, exited);
    return exited;
  }
}

/** The identity the system reads for `processId`. */
function identityOf(processId: number): ProcessIdentity {
  return { processId, bootId: "boot-1", processStartTime: `start of ${String(processId)}` };
}

/** The daemon's handshake answer, refusing this app's version as too old when not compatible. */
function initializeResponseOf(isCompatible: boolean): ConnectionInitializeResponse {
  return isCompatible
    ? {
        compatible: true,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        deviceId: "device-1" as DeviceId,
      }
    : {
        compatible: false,
        protocolVersion: "2027-01-01",
        deviceId: "device-1" as DeviceId,
        reason: "connection.version.floorExceeded",
        daemonSupportedProtocols: ["2027-01-01"],
      };
}

/** A call's answer as the scripted service gives it. */
function scripted<Response>(answer: CallAnswer, result: unknown): Promise<Response> {
  if (answer === "silent") {
    return new Promise(() => undefined);
  }
  if (answer === "refused") {
    return Promise.reject(
      new DaemonRefusal({
        code: JsonRpcErrorCode.DomainRefusal,
        message: "protocol version mismatch",
        data: { type: CONNECTION_VERSION_MISMATCH_CODE, category: "failedPrecondition" },
      }),
    );
  }
  return Promise.resolve(result as Response);
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
    helper: service.helper,
    startService: service.startService,
    readServiceStatus: service.readServiceStatus,
    log,
  });
  return { service, link, log, supervisor, connections };
}

/** Start the supervisor with the service found running, and let the link come up. */
export async function linkToRunningService(under: SupervisorUnderTest): Promise<void> {
  under.service.connectAnswer = { kind: "answering" };
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
