// The supervisor over a scripted service behind a fake client helper and a fake clock: it starts
// the service when none answers and waits 10 seconds for the connect, through a token not written
// yet and no longer once the started service exits, and ends a started service that never answers
// the connect or the status read after it. A service found on its socket is waited for while its
// token is not written yet, and a started or found one for as long as it answers it is repairing
// its database file, reporting the count each answer carries, and while it binds its socket again
// after. It brings a link the client reports lost, or a helper that exited, back at the backoff's
// waits and stops after five failed starts, starts again on `Retry` as a fresh start, and starts
// nothing once it is let go at quit. It reads the service's process as each link comes up, so a
// hung service is ended whether this app started it or found it running, and a failed ending is
// recorded.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { AUTH_TOKEN_INVALID_CODE } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import type { DaemonLink } from "./link/status.js";
import { SERVICE_HELLO_WAIT_MS, type DaemonSupervisor } from "./supervisor.js";
import {
  NO_SOCKET,
  linkToRunningService,
  supervisorOverScriptedService,
  type ScriptedService,
  type SupervisorUnderTest,
} from "./supervisor.test-support.js";

/** The connect's failure while the token file is not written yet, which carries no refusal code. */
const NO_TOKEN_FILE = {
  code: JsonRpcErrorCode.InternalError,
  message: "the token file could not be read: No such file or directory",
};

/** The connect's refusal of the last start's token. */
const STALE_TOKEN = {
  code: JsonRpcErrorCode.DomainRefusal,
  message: "token invalid",
  data: { type: AUTH_TOKEN_INVALID_CODE, category: "unauthenticated" },
};

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
    expect(link.state).toMatchObject({ connection: { kind: "connected" }, startedByApp: true });
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

  it("waits 10 seconds for the connect, and tries again", async () => {
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

  it("still links to a service that does not name its process", async () => {
    service.connectAnswer = { kind: "answering" };
    service.isIdentityReported = false;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state.connection).toStrictEqual({ kind: "connected" });
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("The background service did not name its process"),
      }),
    );
  });

  it("keeps trying a just-started service with no token file yet, or the last start's token", async () => {
    service.connectFailures.push(NO_SOCKET, NO_TOKEN_FILE, STALE_TOKEN);
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
          "answered its connect (exit code 1)",
      }),
    );
    // The next attempt comes at the backoff's first 100 ms, not after the hello wait.
    await vi.advanceTimersByTimeAsync(100);
    expect(service.connectTimes).toStrictEqual([0, 0, 100]);
  });

  it.each([
    ["no token file yet", NO_TOKEN_FILE],
    ["the last start's token", STALE_TOKEN],
  ])("waits for a found service with %s rather than starting another", async (_case, failure) => {
    service.connectFailures.push(failure);
    service.connectAnswer = { kind: "answering" };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.startTimes).toStrictEqual([]);
    expect(service.connectTimes).toStrictEqual([0, 50]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("ends a started service that never answers the connect, and waits for it to exit", async () => {
    service.afterStart = { kind: "silent" };
    supervisor.start();

    await vi.advanceTimersByTimeAsync(SERVICE_HELLO_WAIT_MS);
    expect(service.endedServices).toStrictEqual(["4001 unanswered"]);
    // The next attempt waits out the ended service, which exits a second later.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.connectTimes).toStrictEqual([0, 0, SERVICE_HELLO_WAIT_MS + 1_000]);
  });

  it.each([
    ["started", [0]],
    ["found running", []],
  ])(
    "waits for a service it %s for as long as it answers it is repairing, and through its new bind",
    async (way, startTimes) => {
      if (way === "started") {
        service.afterStart = { kind: "repairing", fields: {} };
      } else {
        service.connectAnswer = { kind: "repairing", fields: {} };
      }
      supervisor.start();

      await vi.advanceTimersByTimeAsync(3 * SERVICE_HELLO_WAIT_MS);
      expect(service.endedServices).toStrictEqual([]);
      expect(link.state.connection).toStrictEqual({ kind: "repairing", progress: undefined });
      // The repair is done and the socket is gone until the service binds it again.
      service.connectAnswer = { kind: "absent" };
      await vi.advanceTimersByTimeAsync(SERVICE_HELLO_WAIT_MS / 2);
      service.connectAnswer = { kind: "answering" };
      await vi.advanceTimersByTimeAsync(1_000);

      expect(service.endedServices).toStrictEqual([]);
      expect(service.startTimes).toStrictEqual(startTimes);
      expect(link.state.connection).toStrictEqual({ kind: "connected" });
    },
  );

  it("reports the count each repairing answer carries, and none once an answer carries none", async () => {
    service.connectAnswer = { kind: "repairing", fields: { progress: { done: 120, total: 400 } } };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.state.connection).toStrictEqual({
      kind: "repairing",
      progress: { done: 120, total: 400 },
    });

    // The supervisor asks again within a second while the service repairs.
    service.connectAnswer = { kind: "repairing", fields: { progress: { done: 121, total: 400 } } };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(link.state.connection).toStrictEqual({
      kind: "repairing",
      progress: { done: 121, total: 400 },
    });

    service.connectAnswer = { kind: "repairing", fields: {} };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(link.state.connection).toStrictEqual({ kind: "repairing", progress: undefined });
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
  it("records an ending that fails, as a failed look at the system would", async () => {
    service.statusReadAnswer = "silent";
    service.isEndingFailing = true;
    supervisor.start();

    await vi.advanceTimersByTimeAsync(SERVICE_HELLO_WAIT_MS);

    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "Ending the background service failed: ps could not run",
      }),
    );
  });

  it("brings back a link the client reports lost, closing it and starting again after 100 ms", async () => {
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };

    service.loseLink();
    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(link.client).toBeUndefined();
    expect(link.state.connection.kind).toBe("transient_disconnect");
    await vi.advanceTimersByTimeAsync(99);
    expect(service.startTimes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(service.startTimes).toStrictEqual([100]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("reconnects at the backoff's first wait when the client helper exits", async () => {
    await linkToRunningService(under);

    service.exitHelper();
    expect(link.client).toBeUndefined();
    expect(link.state.connection).toStrictEqual({
      kind: "transient_disconnect",
      attempt: 1,
      attemptLimit: 5,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(service.connectTimes).toStrictEqual([0, 100]);
    expect(service.startTimes).toStrictEqual([]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });
});

describe("bringing the service back", () => {
  it("starts again at 100, 300, 1000, 3000 and 10000 ms, and stops after five failed starts", async () => {
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };
    service.afterStart = undefined;

    service.loseLink();
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

    service.afterStart = { kind: "answering" };
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.startTimes).toStrictEqual([0, 100, 400, 1_400, 4_400, 60_000]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.startTimes).toHaveLength(6);
  });

  it("starts nothing once let go at quit, even with a start pending, and ends the helper", async () => {
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };
    service.loseLink();

    await supervisor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.isHelperDisposed).toBe(true);
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
    service.loseLink();
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
