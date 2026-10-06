// The supervisor over a scripted service and a fake clock: it starts the service when none
// answers and waits 10 seconds for the handshake, through a token not written yet and no longer
// once the started service exits, and ends a started service that never answers the handshake or
// the status read after it. A service found on its socket is waited for while its token is not
// written yet. It asks a quiet link to answer after 5 seconds and counts it dead after 20, brings a
// lost link back at the backoff's waits and stops after five failed starts, reads an unrecognized
// loss as `unknown`, starts again on `Retry` as a fresh start, and starts nothing once it is let go
// at quit. It reads the service's process as each link comes up, on another protocol too, so a
// hung service is ended whether this app started it or found it running, and a failed ending is
// recorded.

import {
  JsonRpcRemoteError,
  JsonRpcTransportPeerClosedError,
  JsonRpcTransportUnavailableError,
} from "@ai-sidekicks/client-sdk";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import type { DaemonLink } from "./link/status.js";
import { SERVICE_HELLO_WAIT_MS, type DaemonSupervisor } from "./supervisor.js";
import {
  COMPATIBLE_HELLO,
  FOUND_SERVICE_PROCESS_ID,
  INCOMPATIBLE_HELLO,
  linkToRunningService,
  supervisorOverScriptedService,
  type ScriptedService,
  type SupervisorUnderTest,
} from "./supervisor.test-support.js";

let under: SupervisorUnderTest;
let service: ScriptedService;
let link: DaemonLink;
let log: Pick<MainDiagnosticLog, "write">;
let supervisor: DaemonSupervisor;
let connections: DaemonConnection[];

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  under = supervisorOverScriptedService();
  ({ service, link, log, supervisor, connections } = under);
});

afterEach(async () => {
  await supervisor.dispose();
  vi.useRealTimers();
});

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
    await linkToRunningService(under);

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

  it.each([
    [
      "no token file yet",
      Object.assign(new Error("ENOENT: no such file, open '/run/daemon.token'"), {
        code: "ENOENT",
      }),
    ],
    [
      "the last start's token",
      new JsonRpcRemoteError(JsonRpcErrorCode.InvalidRequest, "token invalid", {
        type: "auth.token_invalid",
      }),
    ],
  ])("waits for a found service with %s rather than starting another", async (_case, failure) => {
    service.connectFailures.push(failure);
    service.connectAnswer = { kind: "answering", hello: COMPATIBLE_HELLO, answersPing: true };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.startTimes).toStrictEqual([]);
    expect(service.connectTimes).toStrictEqual([0, 50]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("ends a started service that never answers the handshake, and waits for it to exit", async () => {
    service.afterStart = { kind: "silent" };
    supervisor.start();

    await vi.advanceTimersByTimeAsync(SERVICE_HELLO_WAIT_MS);
    expect(service.endedServices).toStrictEqual(["4001 unanswered"]);
    // The next attempt waits out the ended service, which exits a second later.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.connectTimes).toStrictEqual([0, 0, SERVICE_HELLO_WAIT_MS + 1_000]);
  });

  it("fails a start whose status read never answers, and ends the service it started", async () => {
    service.statusReadAnswer = "silent";
    supervisor.start();

    await vi.advanceTimersByTimeAsync(SERVICE_HELLO_WAIT_MS - 1);
    expect(link.state.connection).toStrictEqual({ kind: "starting" });
    await vi.advanceTimersByTimeAsync(1);

    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(service.endedServices).toStrictEqual(["4001 unanswered"]);
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "The background service did not start: The background service did not answer " +
          "daemon.status.read within 10 seconds",
      }),
    );
  });
});

describe("watching the link", () => {
  it("asks a quiet link to answer at 5 seconds, and an answer of any kind keeps it", async () => {
    await linkToRunningService(under);
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
        await linkToRunningService(under, false);
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
    await linkToRunningService(under, false);
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
    await linkToRunningService(under);
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
    await linkToRunningService(under);
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
    await linkToRunningService(under);
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
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    await supervisor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.connectTimes).toStrictEqual([0]);
    expect(service.startTimes).toStrictEqual([]);
  });

  it("closes main's connection at quit and signals nothing", async () => {
    await linkToRunningService(under);

    await supervisor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(service.endedServices).toStrictEqual([]);
    expect(service.connectTimes).toStrictEqual([0]);
  });

  it("reads Retry after a lost link gave up as a fresh start, not the link's return", async () => {
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };
    service.afterStart = undefined;
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.state.connection.kind).toBe("degraded");
    connections.length = 0;

    service.afterStart = { kind: "silent" };
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(connections.map((connection) => connection.kind)).toStrictEqual([
      "connecting",
      "starting",
    ]);
  });
});
