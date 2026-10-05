// The supervisor over a scripted service and a fake clock: it starts the service when none
// answers and waits 10 seconds for the handshake, through a token not written yet and no longer
// once the started service exits, asks a quiet link to answer after 5 seconds and counts it dead
// after 20, brings a lost link back at the backoff's waits and stops after five failed starts,
// reads an unrecognized loss as `unknown`, starts again on `Retry`, and starts nothing once it is
// let go at quit. It reads the service's process as each link comes up, on another protocol too,
// so a hung service is ended whether this app started it or found it running, and a failed ending
// is recorded. A quit sends `daemon.flush` alone, signals nothing and waits for a service a `Stop`
// is ending; the person's `Stop` and `Restart` flush first, at most 10 seconds, then ask, then end
// the service of either kind, counting its drain from the request, and a restart's next start
// waits for it to exit. A loss before the stop's answer reads as stopped, and a refusal does not.

import {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTransportPeerClosedError,
  JsonRpcTransportUnavailableError,
  type ClientTransport,
  type DaemonConnection as DaemonClientConnection,
  type DaemonConnectionObserver,
} from "@ai-sidekicks/client-sdk";
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  type JsonRpcRequest,
} from "@ai-sidekicks/contracts/jsonrpc";
import {
  CURRENT_PROTOCOL_VERSION,
  type DaemonHelloAck,
} from "@ai-sidekicks/contracts/jsonrpc-negotiation";
import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon-lifecycle";
import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon-status";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonConnection } from "@shared/daemon-status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { DaemonLink } from "./daemon-link.js";
import {
  DaemonSupervisor,
  SERVICE_FLUSH_WAIT_MS,
  SERVICE_HELLO_WAIT_MS,
} from "./daemon-supervisor.js";
import type { ServiceEnding, ServiceExit, ServiceProcess } from "./service-process.js";

/** The process id of the service the supervisor finds running. */
const FOUND_SERVICE_PROCESS_ID = 3000;

const COMPATIBLE_HELLO: DaemonHelloAck = {
  compatible: true,
  protocolVersion: CURRENT_PROTOCOL_VERSION,
};

/** A service on a newer protocol than main speaks. */
const INCOMPATIBLE_HELLO: DaemonHelloAck = {
  compatible: false,
  protocolVersion: "2027-01-01",
  reason: "version.floor_exceeded",
  daemonSupportedProtocols: ["2027-01-01"],
};

/** One connection the scripted service opened: the requests main sent, and its close. */
interface ScriptedLink {
  readonly requests: string[];
  /** The service drops the connection with `reason`. */
  closeWith(reason: Error): void;
  /** Whether main closed it. */
  readonly isClosedByMain: () => boolean;
}

/** How the scripted service answers a call: at once, after `delayMs`, refused, or never. */
type CallAnswer = "answered" | { readonly delayMs: number } | "refused" | "silent";

/** How the scripted service answers the next connect. */
type ConnectAnswer =
  | { readonly kind: "absent" }
  | { readonly kind: "answering"; readonly hello: DaemonHelloAck; readonly answersPing: boolean }
  | { readonly kind: "silent" };

/** A background service played by the test: what each connect meets, and the starts asked for. */
class ScriptedService {
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
  public runningProcessId = FOUND_SERVICE_PROCESS_ID;
  /** Whether the status read names the service's process; an older protocol's reply may not. */
  public isIdentityReported = true;
  /** Whether ending a process fails, as a failed look at the system would. */
  public isEndingFailing = false;
  readonly #exits = new Map<number, PromiseWithResolvers<ServiceExit>>();
  /** How a link answers `daemon.flush`. */
  public flushAnswer: CallAnswer = "answered";
  /** How a link answers `daemon.stop` and `daemon.restart`. */
  public stopAnswer: CallAnswer = "answered";
  /** Failures the next connects meet, in order, before `connectAnswer` applies. */
  public readonly connectFailures: Error[] = [];
  public connectAnswer: ConnectAnswer = { kind: "absent" };
  /** What a start leaves the next connect meeting; `undefined` makes the start fail. */
  public afterStart: ConnectAnswer | undefined = {
    kind: "answering",
    hello: COMPATIBLE_HELLO,
    answersPing: true,
  };

  public connect = (observer: DaemonConnectionObserver): Promise<DaemonClientConnection> => {
    this.connectTimes.push(Date.now());
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
        return { frame: { result: this.#statusRead() }, delayMs: 0 };
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
          data: { type: "protocol.version_mismatch" },
        },
      },
      delayMs: 0,
    };
  }
  return { frame: { result }, delayMs: answer === "answered" ? 0 : answer.delayMs };
}

let service: ScriptedService;
let link: DaemonLink;
let log: Pick<MainDiagnosticLog, "write">;
let supervisor: DaemonSupervisor;
let connections: DaemonConnection[];

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  service = new ScriptedService();
  link = new DaemonLink();
  connections = [];
  link.subscribe((state) => {
    connections.push(state.connection);
  });
  log = { write: vi.fn() };
  supervisor = new DaemonSupervisor({
    link,
    connect: service.connect,
    startService: service.startService,
    attachServiceProcess: service.attachServiceProcess,
    log,
    now: () => new Date(),
  });
});

afterEach(async () => {
  await supervisor.dispose();
  vi.useRealTimers();
});

/** Start the supervisor with the service found running, and let the link come up. */
async function linkedToRunningService(answersPing = true): Promise<void> {
  service.connectAnswer = { kind: "answering", hello: COMPATIBLE_HELLO, answersPing };
  supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(link.state.connection).toStrictEqual({ kind: "connected" });
}

describe("starting the service", () => {
  it("starts the service when none answers, and reports the link up and started by the app", async () => {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.startTimes).toStrictEqual([0]);
    expect(link.client).toBeDefined();
    expect(link.state).toMatchObject({
      connection: { kind: "connected" },
      startedByApp: true,
      negotiation: { compatible: true, appProtocolVersion: CURRENT_PROTOCOL_VERSION },
    });
    expect(connections.map((connection) => connection.kind)).toStrictEqual([
      "connecting",
      "connecting",
      "starting",
      "connected",
    ]);
  });

  it("reaches a running service without starting one", async () => {
    await linkedToRunningService();

    expect(service.startTimes).toStrictEqual([]);
    expect(link.state.startedByApp).toBe(false);
  });

  it("waits 10 seconds for the handshake, then counts the start failed and tries again", async () => {
    service.connectAnswer = { kind: "silent" };
    supervisor.start();

    await vi.advanceTimersByTimeAsync(SERVICE_HELLO_WAIT_MS - 1);
    expect(service.connectTimes).toStrictEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    // The start after a failed one waits the backoff's first 100 ms.
    await vi.advanceTimersByTimeAsync(100);
    expect(service.connectTimes).toStrictEqual([0, SERVICE_HELLO_WAIT_MS + 100]);
    expect(link.client).toBeUndefined();
  });

  it("reads a refused handshake as version-incompatible, naming the side that is behind", async () => {
    service.connectAnswer = { kind: "answering", hello: INCOMPATIBLE_HELLO, answersPing: true };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state).toMatchObject({
      connection: { kind: "version-incompatible" },
      negotiation: { compatible: false, behind: "app", daemonProtocolVersion: "2027-01-01" },
    });
  });

  it("still links to a service on another protocol that does not name its process", async () => {
    service.connectAnswer = { kind: "answering", hello: INCOMPATIBLE_HELLO, answersPing: true };
    service.isIdentityReported = false;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state.connection).toStrictEqual({ kind: "version-incompatible" });
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining(
          "The background service on another protocol did not name its process",
        ),
      }),
    );
  });

  it("keeps trying a just-started service with no token file yet, or the last start's token", async () => {
    service.connectFailures.push(
      new JsonRpcTransportUnavailableError(
        "/run/daemon.sock",
        Object.assign(new Error("no"), { code: "ENOENT" }),
      ),
      Object.assign(new Error("ENOENT: no such file, open '/run/daemon.token'"), {
        code: "ENOENT",
      }),
      new JsonRpcRemoteError(JsonRpcErrorCode.InvalidRequest, "token invalid", {
        type: "auth.token_invalid",
      }),
    );
    supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.startTimes).toStrictEqual([0]);
    // The probe, then the started service at the socket wait's first two pauses.
    expect(service.connectTimes).toStrictEqual([0, 0, 50, 150]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("ends the hello wait when the started service exits, and records how it exited", async () => {
    service.afterStart = { kind: "silent" };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    service.exit(4001, { code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "The background service did not start: The background service exited before it " +
          "answered daemon.hello (exit code 1)",
      }),
    );
    // The next attempt comes at the backoff's first 100 ms, not after the hello wait.
    await vi.advanceTimersByTimeAsync(100);
    expect(service.connectTimes).toStrictEqual([0, 0, 100]);
  });
});

describe("watching the link", () => {
  it("asks a quiet link to answer at 5 seconds, and an answer of any kind keeps it", async () => {
    await linkedToRunningService();
    const [current] = service.links;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(current?.requests).toStrictEqual(["daemon.status.read"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(current?.requests).toStrictEqual(["daemon.status.read", "daemon.ping"]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
    expect(current?.isClosedByMain()).toBe(false);
  });

  it.each([
    ["started", 4001],
    ["found running", FOUND_SERVICE_PROCESS_ID],
  ])(
    "counts a link with no frame for 20 seconds dead, drops it and ends the hung service it %s",
    async (way, hungProcessId) => {
      if (way === "started") {
        service.afterStart = { kind: "answering", hello: COMPATIBLE_HELLO, answersPing: false };
        supervisor.start();
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await linkedToRunningService(false);
      }
      const [current] = service.links;

      await vi.advanceTimersByTimeAsync(19_999);
      expect(link.state.connection).toStrictEqual({ kind: "connected" });
      service.connectAnswer = { kind: "silent" };
      await vi.advanceTimersByTimeAsync(1);

      expect(current?.isClosedByMain()).toBe(true);
      expect(link.client).toBeUndefined();
      expect(link.state.connection).toStrictEqual({
        kind: "transient_disconnect",
        attempt: 1,
        attemptLimit: 5,
      });
      expect(service.endedServices).toStrictEqual([`${String(hungProcessId)} unanswered`]);
    },
  );

  it("ends a hung service on another protocol by the process it named", async () => {
    service.connectAnswer = { kind: "answering", hello: INCOMPATIBLE_HELLO, answersPing: false };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    service.connectAnswer = { kind: "silent" };

    await vi.advanceTimersByTimeAsync(20_000);

    expect(service.endedServices).toStrictEqual([`${String(FOUND_SERVICE_PROCESS_ID)} unanswered`]);
  });

  it("records an ending that fails, as a failed look at the system would", async () => {
    await linkedToRunningService(false);
    service.connectAnswer = { kind: "silent" };
    service.isEndingFailing = true;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "Ending the background service failed: ps could not run",
      }),
    );
  });

  it("notices a killed service when its socket closes, and starts it again after 100 ms", async () => {
    await linkedToRunningService();
    service.connectAnswer = { kind: "absent" };

    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());
    expect(link.client).toBeUndefined();
    expect(link.state.connection.kind).toBe("transient_disconnect");
    await vi.advanceTimersByTimeAsync(99);
    expect(service.startTimes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(service.startTimes).toStrictEqual([100]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("reads a loss it does not recognize as unknown, never connected, and still brings it back", async () => {
    await linkedToRunningService();
    service.connectAnswer = { kind: "absent" };

    service.links[0]?.closeWith(new Error("the frame header was malformed"));

    expect(link.state.connection).toStrictEqual({
      kind: "unknown",
      lastError: "the frame header was malformed",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });
});

describe("bringing the service back", () => {
  it("starts again at 100, 300, 1000, 3000 and 10000 ms, and stops after five failed starts", async () => {
    await linkedToRunningService();
    service.connectAnswer = { kind: "absent" };
    service.afterStart = undefined;

    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.startTimes).toStrictEqual([100, 400, 1_400, 4_400, 14_400]);
    expect(link.state.connection).toStrictEqual({
      kind: "degraded",
      attemptLimit: 5,
      lastError: "spawn node ENOENT",
    });
  });

  it("starts at once again on Retry, with a full set of attempts", async () => {
    service.afterStart = undefined;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.startTimes).toHaveLength(5);
    expect(link.state.connection.kind).toBe("degraded");

    service.afterStart = { kind: "answering", hello: COMPATIBLE_HELLO, answersPing: true };
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.startTimes).toStrictEqual([0, 100, 400, 1_400, 4_400, 60_000]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.startTimes).toHaveLength(6);
  });

  it("starts nothing once let go at quit, even with a start pending, and closes its connection", async () => {
    await linkedToRunningService();
    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    await supervisor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.connectTimes).toStrictEqual([0]);
    expect(service.startTimes).toStrictEqual([]);
  });

  it("closes main's connection at quit and signals nothing", async () => {
    await linkedToRunningService();

    await supervisor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(service.endedServices).toStrictEqual([]);
    expect(service.connectTimes).toStrictEqual([0]);
  });
});

describe("the person's Stop and Restart", () => {
  /** Start the supervisor with no service running, so the app starts one, and link to it. */
  async function linkedToStartedService(): Promise<void> {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.state.startedByApp).toBe(true);
  }

  it("a stop flushes, then stops, ends the service the app started, and leaves it stopped", async () => {
    await linkedToStartedService();

    await expect(supervisor.endService("daemon.stop")).resolves.toStrictEqual({ accepted: true });

    expect(service.links[0]?.requests).toStrictEqual([
      "daemon.status.read",
      "daemon.flush",
      "daemon.stop",
    ]);
    expect(service.endedServices).toStrictEqual(["4001 stopAsked"]);
    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.state.connection).toStrictEqual({ kind: "stopped" });
    expect(service.startTimes).toStrictEqual([0]);
  });

  it("a restart flushes, then restarts, and starts again only once the old service exited", async () => {
    await linkedToStartedService();

    await supervisor.endService("daemon.restart");
    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    expect(service.links[0]?.requests).toStrictEqual([
      "daemon.status.read",
      "daemon.flush",
      "daemon.restart",
    ]);
    expect(service.endedServices).toStrictEqual(["4001 stopAsked"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(service.startTimes).toStrictEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.startTimes).toStrictEqual([0, 1_000]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("a restart ends a service it found running by the process id it read, and starts again once it exited", async () => {
    await linkedToRunningService();

    await supervisor.endService("daemon.restart");
    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    expect(service.endedServices).toStrictEqual([`${String(FOUND_SERVICE_PROCESS_ID)} stopAsked`]);
    // Not at the first backoff's 100 ms, while the found service still holds the data folder.
    await vi.advanceTimersByTimeAsync(999);
    expect(service.startTimes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.startTimes).toStrictEqual([1_000]);
    expect(link.state).toMatchObject({ connection: { kind: "connected" }, startedByApp: true });
  });
});

describe("waiting on the service's answers", () => {
  /** Start the supervisor with no service running, so the app starts one, and link to it. */
  async function linkedToStartedService(): Promise<void> {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("a loss while the stop's flush is unanswered reads as stopped, and nothing starts", async () => {
    await linkedToStartedService();
    service.flushAnswer = "silent";
    const stopping = supervisor.endService("daemon.stop");
    void stopping.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(stopping).rejects.toBeInstanceOf(JsonRpcTransportClosedError);
    expect(link.state.connection).toStrictEqual({ kind: "stopped" });
    expect(service.startTimes).toStrictEqual([0]);
  });

  it("a refused stop leaves the link to be brought back when it is later lost", async () => {
    await linkedToStartedService();
    service.stopAnswer = "refused";

    await expect(supervisor.endService("daemon.stop")).rejects.toBeInstanceOf(JsonRpcRemoteError);
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    expect(link.state.connection.kind).toBe("transient_disconnect");
    expect(service.endedServices).toStrictEqual([]);
  });

  it("a flush that never answers holds the stop for 10 seconds, then the stop goes ahead", async () => {
    await linkedToStartedService();
    service.flushAnswer = "silent";
    const stopping = supervisor.endService("daemon.stop");

    await vi.advanceTimersByTimeAsync(SERVICE_FLUSH_WAIT_MS - 1);
    expect(service.stopsReceivedAt).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(stopping).resolves.toStrictEqual({ accepted: true });
    expect(service.stopsReceivedAt).toStrictEqual([SERVICE_FLUSH_WAIT_MS]);
  });

  it("counts the service's drain from when the stop was sent, not from its answer", async () => {
    await linkedToStartedService();
    service.stopAnswer = { delayMs: 1_000 };
    const stopping = supervisor.endService("daemon.stop");

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(stopping).resolves.toStrictEqual({ accepted: true });
    expect(service.endings).toStrictEqual([{ cause: "stopAsked", askedAt: 0 }]);
  });

  it("ends a service that never answers the stop as one that stopped answering", async () => {
    await linkedToStartedService();
    service.stopAnswer = "silent";
    const stopping = supervisor.endService("daemon.stop");
    void stopping.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(DAEMON_STOP_DRAIN_BOUND_MS - 1);
    expect(service.endedServices).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(stopping).rejects.toThrow(
      "The background service did not answer daemon.stop within 4 seconds; it is being ended.",
    );
    expect(service.endedServices).toStrictEqual(["4001 unanswered"]);
  });
});

describe("the quit", () => {
  it("sends daemon.flush alone, then closes main's connection and signals nothing", async () => {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.flushAtQuit();

    expect(service.links[0]?.requests).toStrictEqual(["daemon.status.read", "daemon.flush"]);
    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(service.endedServices).toStrictEqual([]);
  });

  it("waits for the flush's answer before it lets go", async () => {
    await linkedToRunningService();
    service.flushAnswer = "silent";

    let isSettled = false;
    const quitting = supervisor.flushAtQuit().finally(() => {
      isSettled = true;
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(isSettled).toBe(false);
    expect(service.links[0]?.isClosedByMain()).toBe(false);
    // A link that closes under the flush fails it, which the quit records before it goes ahead.
    await supervisor.dispose();
    await expect(quitting).rejects.toBeInstanceOf(JsonRpcTransportClosedError);
  });

  it("takes a refused flush as its answer, and lets go", async () => {
    await linkedToRunningService();
    service.flushAnswer = "refused";

    await supervisor.flushAtQuit();

    expect(service.links[0]?.isClosedByMain()).toBe(true);
  });

  it("waits for a service a Stop is still ending to exit before it lets go", async () => {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    await supervisor.endService("daemon.stop");
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    let isSettled = false;
    const quitting = supervisor.flushAtQuit().finally(() => {
      isSettled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(isSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await quitting;
    expect(isSettled).toBe(true);
  });

  it("negative control: with no link up there is nothing to flush, and it settles at once", async () => {
    service.afterStart = undefined;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.flushAtQuit();

    expect(service.links).toStrictEqual([]);
  });
});
