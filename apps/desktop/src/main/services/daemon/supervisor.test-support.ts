// A background service played by a test behind a fake client helper, for the supervisor's suites:
// what each connect meets, how each call is answered, and the processes main starts, finds and
// ends, each exiting a second after it is ended.

import { DAEMON_REPAIRING_CODE } from "@ai-sidekicks/contracts/daemon/recovery";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  CONNECTION_UNAVAILABLE_CODE,
  type JsonRpcError,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { CONNECTION_VERSION_MISMATCH_CODE } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { expect, vi } from "vitest";

import { NOT_ANSWERING_MESSAGE, type DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { DaemonRefusal, type ClientHelperListener, type MainCallMethod } from "./client/process.js";
import { DaemonLink } from "./link/status.js";
import { DaemonSupervisor, type DaemonSupervisorOptions } from "./supervisor.js";
import type { ServiceEnding, ServiceExit, ServiceProcess } from "./service/process.js";

/** The process id of the service the supervisor finds running. */
export const FOUND_SERVICE_PROCESS_ID = 3000;

/** The flush bound the fake helper reports, as the client's would be. */
export const FLUSH_WAIT_MS = 10_000;

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

/** How the scripted service answers a call: at once, after `delayMs`, refused, or never. */
export type CallAnswer = "answered" | { readonly delayMs: number } | "refused" | "silent";

/**
 * How the scripted service answers the next connect; `repairing` refuses it while so, with the
 * refusal's `fields` as the service sends them.
 */
export type ConnectAnswer =
  | { readonly kind: "absent" }
  | { readonly kind: "answering" }
  | { readonly kind: "repairing"; readonly fields: Record<string, unknown> }
  | { readonly kind: "silent" };

/** The refusal a connect meets where no socket answers. */
export const NO_SOCKET: JsonRpcError = {
  code: JsonRpcErrorCode.DomainRefusal,
  message: "the service is not listening",
  data: { type: CONNECTION_UNAVAILABLE_CODE, category: "unavailable" },
};

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
  /** Whether the status read names the service's process. */
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
  /** Refusals the next connects meet, in order, before `connectAnswer` applies. */
  public readonly connectFailures: JsonRpcError[] = [];
  public connectAnswer: ConnectAnswer = { kind: "absent" };
  /** What a start leaves the next connect meeting; `undefined` makes the start fail. */
  public afterStart: ConnectAnswer | undefined = { kind: "answering" };
  /** Whether main ended the helper at quit. */
  public isHelperDisposed = false;
  #listener: ClientHelperListener | undefined;
  #current: OpenLink | undefined;

  /** The client helper the supervisor drives, over this service. */
  public readonly helper: DaemonSupervisorOptions["helper"] = {
    flushWaitMs: FLUSH_WAIT_MS,
    listen: (listener) => {
      this.#listener = listener;
    },
    connect: () => this.#connect(),
    closeLink: () => {
      this.#closeCurrent();
    },
    dispose: () => {
      this.isHelperDisposed = true;
      this.#closeCurrent();
    },
    call: <Response>(method: MainCallMethod<Response>) => this.#call(method.method),
    subscribe: () => () => undefined,
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

  /** The open link is lost: the client fails the calls on it and reports it reconnecting. */
  public loseLink(): void {
    this.#failUnanswered();
    this.#listener?.linkStateChanged("reconnecting");
  }

  /** The client helper exits. */
  public exitHelper(): void {
    this.#closeCurrent();
    this.#listener?.exited();
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

  #connect(): Promise<JsonRpcError | undefined> {
    this.connectTimes.push(Date.now());
    const failure = this.connectFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const answer = this.connectAnswer;
    switch (answer.kind) {
      case "absent":
        return Promise.resolve(NO_SOCKET);
      case "repairing":
        return Promise.resolve({
          code: JsonRpcErrorCode.DomainRefusal,
          message: "repairing the database file",
          data: { type: DAEMON_REPAIRING_CODE, category: "unavailable", fields: answer.fields },
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
        return Promise.resolve(undefined);
      }
    }
  }

  #call<Response>(method: string): Promise<Response> {
    const current = this.#current;
    if (current === undefined || current.isClosed) {
      return Promise.reject(new Error(NOT_ANSWERING_MESSAGE));
    }
    current.link.requests.push(method);
    if (method === "daemon.stop" || method === "daemon.restart") {
      this.stopsReceivedAt.push(performance.now());
    }
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
        return this.isIdentityReported
          ? scripted(this.statusReadAnswer, {
              processIdentity: {
                processId: this.runningProcessId,
                bootId: "boot-1",
                processStartTime: `start of ${String(this.runningProcessId)}`,
              },
            })
          : Promise.reject(new Error("The daemon.status.read reply does not match its contract."));
      case "daemon.stop":
      case "daemon.restart":
        return scripted(this.stopAnswer, { accepted: true });
      default:
        return new Promise(() => undefined);
    }
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
  if (answer === "answered") {
    return Promise.resolve(result as Response);
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(result as Response);
    }, answer.delayMs);
  });
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
    attachServiceProcess: service.attachServiceProcess,
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
