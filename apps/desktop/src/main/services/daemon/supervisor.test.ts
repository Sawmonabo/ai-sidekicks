// The supervisor over a scripted service behind a fake client helper, a fake of the addon's ending
// and a fake clock. It probes once and starts the service only when no socket answers, then hands
// the wait to the client; a found service still writing its token or repairing is waited for and
// never started over. A started service that exits before it answers ends the wait with how it
// exited, and one still running once the client's wait ran out is ended by its identity. A link
// that dies ends its service at once by the identity it reported, and the next start waits for that
// ending. Lost links come back at the backoff's waits, five failed starts give up, `Retry` starts
// afresh, and nothing starts once the quit lets go. The handshake's answer and the status file's
// cannot-start reach the status topic.

import { HANDSHAKE_DEADLINE_MS } from "@ai-sidekicks/client-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import type { DaemonLink } from "./link/status.js";
import type { DaemonSupervisor } from "./supervisor.js";
import {
  ENDING_MS,
  FOUND_SERVICE_PROCESS_ID,
  linkToRunningService,
  linkToStartedService,
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
  it("probes, starts the service when no socket answers, and hands the wait to the client", async () => {
    await linkToStartedService(under);

    expect(service.startTimes).toStrictEqual([0]);
    expect(service.connects).toStrictEqual([
      { at: 0, waitsForStart: false },
      { at: 0, waitsForStart: true },
    ]);
    expect(link.client).toBeDefined();
    expect(link.state).toMatchObject({
      connection: { kind: "connected" },
      startedByApp: true,
      negotiation: { compatible: true, deviceId: "device-1", behind: undefined },
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

  it.each([
    ["still writing its token", { kind: "noToken" } as const],
    ["repairing its database file", { kind: "repairing", fields: {} } as const],
  ])("waits for a found service %s and never starts one over it", async (_case, probeAnswer) => {
    service.connectAnswer = probeAnswer;
    service.waitAnswer = { kind: "answering" };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.startTimes).toStrictEqual([]);
    expect(service.connects.map((connect) => connect.waitsForStart)).toStrictEqual([false, true]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("reports the count each repairing answer carries while the client waits", async () => {
    service.connectAnswer = { kind: "repairing", fields: { progress: { done: 120, total: 400 } } };
    service.waitAnswer = { kind: "silent" };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.state.connection).toStrictEqual({
      kind: "repairing",
      progress: { done: 120, total: 400 },
    });

    service.answerRepairing({ progress: { done: 121, total: 400 } });
    expect(link.state.connection).toStrictEqual({
      kind: "repairing",
      progress: { done: 121, total: 400 },
    });
    service.answerRepairing({});
    expect(link.state.connection).toStrictEqual({ kind: "repairing", progress: undefined });
  });

  it("ends the wait when the started service exits, closes the link and records how it exited", async () => {
    service.afterStart = { kind: "silent" };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    service.exit(4001, { code: 3, signal: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(service.endings).toStrictEqual([]);
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message:
          "The background service did not start: The background service exited before it " +
          "answered its connect (exit code 3)",
      }),
    );
    expect(link.state.connection).toStrictEqual({ kind: "starting" });
  });

  it("ends a started service still running once the client's wait ran out, and waits for it", async () => {
    service.afterStart = { kind: "noToken" };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.endings).toStrictEqual([{ at: 0, ending: "process 4001" }]);
    // The next start waits the backoff's 100 ms, then for the ending to settle.
    service.connectAnswer = { kind: "answering" };
    await vi.advanceTimersByTimeAsync(ENDING_MS - 1);
    expect(service.connects).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.connects.map((connect) => connect.at)).toStrictEqual([0, 0, ENDING_MS]);
  });

  it("fails a start whose status read never answers, and ends the service it started", async () => {
    service.statusReadAnswer = "silent";
    supervisor.start();

    await vi.advanceTimersByTimeAsync(HANDSHAKE_DEADLINE_MS - 1);
    expect(link.state.connection).toStrictEqual({ kind: "starting" });
    await vi.advanceTimersByTimeAsync(1);

    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(service.endings).toStrictEqual([{ at: HANDSHAKE_DEADLINE_MS, ending: "process 4001" }]);
  });

  it("links a service on another version as one that serves reads, naming the side behind", async () => {
    service.connectAnswer = { kind: "answering", isCompatible: false };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state).toMatchObject({
      connection: { kind: "version_incompatible" },
      negotiation: {
        compatible: false,
        daemonProtocolVersion: "2027-01-01",
        daemonSupportedProtocols: ["2027-01-01"],
        reason: "connection.version.floorExceeded",
        behind: "app",
      },
    });
  });

  it("puts the status file's cannot-start on the topic once a start fails", async () => {
    service.afterStart = undefined;
    service.statusFile = { cannotStart: { reason: "savedSessionsFromAnotherVersion" } };
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state.cannotStart).toStrictEqual({ reason: "savedSessionsFromAnotherVersion" });
  });
});

describe("watching the link", () => {
  it("ends the service of a link that died at once, by the identity it reported", async () => {
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };

    service.loseLink();

    expect(service.endings).toStrictEqual([
      { at: 0, ending: `process ${String(FOUND_SERVICE_PROCESS_ID)}` },
    ]);
    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(link.client).toBeUndefined();
    expect(link.state.connection.kind).toBe("transient_disconnect");
    // The start after the loss waits for the ending, not only the backoff's 100 ms.
    await vi.advanceTimersByTimeAsync(ENDING_MS - 1);
    expect(service.startTimes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.startTimes).toStrictEqual([ENDING_MS]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("negative control: a helper that exits ends no service, and reconnects at 100 ms", async () => {
    await linkToRunningService(under);

    service.exitHelper();
    expect(link.state.connection).toStrictEqual({
      kind: "transient_disconnect",
      attempt: 1,
      attemptLimit: 5,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(service.endings).toStrictEqual([]);
    expect(service.connects.map((connect) => connect.at)).toStrictEqual([0, 100]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });
});

describe("bringing the service back", () => {
  it("starts again at 100, 300, 1000, 3000 and 10000 ms, and stops after five failed starts", async () => {
    service.afterStart = undefined;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.startTimes).toStrictEqual([0, 100, 400, 1_400, 4_400]);
    expect(link.state.connection).toStrictEqual({
      kind: "degraded",
      attemptLimit: 5,
      lastError: "spawn sidekicks-daemon ENOENT",
    });
  });

  it("starts at once again on Retry, with a full set of attempts", async () => {
    service.afterStart = undefined;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.state.connection.kind).toBe("degraded");

    service.afterStart = { kind: "answering" };
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.startTimes).toStrictEqual([0, 100, 400, 1_400, 4_400, 60_000]);
    expect(link.state.connection).toStrictEqual({ kind: "connected" });
  });

  it("starts nothing once let go at quit, even with a start pending, and ends the helper", async () => {
    await linkToRunningService(under);
    service.connectAnswer = { kind: "absent" };
    service.exitHelper();

    await supervisor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.isHelperDisposed).toBe(true);
    expect(service.connects).toHaveLength(1);
    expect(service.startTimes).toStrictEqual([]);
  });
});
