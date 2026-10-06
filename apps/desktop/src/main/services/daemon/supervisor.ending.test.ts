// The supervisor's ending of the service over a scripted service and a fake clock. A quit sends
// `daemon.flush` alone, signals nothing, waits for a service a `Stop` is ending and starts nothing
// while it waits, a restart's new service included. The person's `Stop` and `Restart` flush first,
// at most 10 seconds and taking a refusal as the answer, then ask, then end the service of either
// kind, counting its drain from the request, and a restart's next start waits for it to exit. A
// loss before the stop's answer reads as stopped and ends a service that fell silent, and a refusal
// of the stop does not.

import {
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTransportPeerClosedError,
} from "@ai-sidekicks/client-sdk";
import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonLink } from "./link/status.js";
import { SERVICE_FLUSH_WAIT_MS, type DaemonSupervisor } from "./supervisor.js";
import {
  COMPATIBLE_HELLO,
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
let supervisor: DaemonSupervisor;

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  under = supervisorOverScriptedService();
  ({ service, link, supervisor } = under);
});

afterEach(async () => {
  await supervisor.dispose();
  vi.useRealTimers();
});

describe("the person's Stop and Restart", () => {
  it("a stop flushes, then stops, ends the service the app started, and leaves it stopped", async () => {
    await linkToStartedService(under);

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
    await linkToStartedService(under);

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
    await linkToRunningService(under);

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
  it("a loss while the stop's flush is unanswered reads as stopped, and nothing starts", async () => {
    await linkToStartedService(under);
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
    await linkToStartedService(under);
    service.stopAnswer = "refused";

    await expect(supervisor.endService("daemon.stop")).rejects.toBeInstanceOf(JsonRpcRemoteError);
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());

    expect(link.state.connection.kind).toBe("transient_disconnect");
    expect(service.endedServices).toStrictEqual([]);
  });

  it("a flush that never answers holds the stop for 10 seconds, then the stop goes ahead", async () => {
    await linkToStartedService(under);
    service.flushAnswer = "silent";
    const stopping = supervisor.endService("daemon.stop");

    await vi.advanceTimersByTimeAsync(SERVICE_FLUSH_WAIT_MS - 1);
    expect(service.stopsReceivedAt).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(stopping).resolves.toStrictEqual({ accepted: true });
    expect(service.stopsReceivedAt).toStrictEqual([SERVICE_FLUSH_WAIT_MS]);
  });

  it("counts the service's drain from when the stop was sent, not from its answer", async () => {
    await linkToStartedService(under);
    service.stopAnswer = { delayMs: 1_000 };
    const stopping = supervisor.endService("daemon.stop");

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(stopping).resolves.toStrictEqual({ accepted: true });
    expect(service.endings).toStrictEqual([{ cause: "stopAsked", askedAt: 0 }]);
  });

  it("ends a service that never answers the stop as one that stopped answering", async () => {
    await linkToStartedService(under);
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

  it("takes a refused flush as its answer, and the stop goes ahead", async () => {
    await linkToStartedService(under);
    service.flushAnswer = "refused";

    await expect(supervisor.endService("daemon.stop")).resolves.toStrictEqual({ accepted: true });
    expect(service.links[0]?.requests).toStrictEqual([
      "daemon.status.read",
      "daemon.flush",
      "daemon.stop",
    ]);
    expect(service.endedServices).toStrictEqual(["4001 stopAsked"]);
  });

  it("ends a service that falls silent under the stop's flush, and reads it stopped", async () => {
    service.afterStart = { kind: "answering", hello: COMPATIBLE_HELLO, answersPing: false };
    await linkToStartedService(under);
    await vi.advanceTimersByTimeAsync(15_000);
    service.flushAnswer = "silent";
    service.connectAnswer = { kind: "absent" };
    const stopping = supervisor.endService("daemon.stop");
    void stopping.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(link.state.connection).toStrictEqual({ kind: "stopped" });
    expect(service.endedServices).toStrictEqual(["4001 unanswered"]);
    await expect(stopping).rejects.toBeInstanceOf(JsonRpcTransportClosedError);
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
    await linkToRunningService(under);
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
    await linkToRunningService(under);
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

  it("starts no new service when the quit comes during a restart", async () => {
    await linkToStartedService(under);
    await supervisor.endService("daemon.restart");
    service.connectAnswer = { kind: "absent" };
    service.links[0]?.closeWith(new JsonRpcTransportPeerClosedError());
    // The new start is already waiting for the old service to exit when the quit comes.
    await vi.advanceTimersByTimeAsync(500);

    const quitting = supervisor.flushAtQuit();
    await vi.advanceTimersByTimeAsync(60_000);
    await quitting;

    expect(service.startTimes).toStrictEqual([0]);
  });
});
