// The supervisor's ending of the service over a scripted service, a fake of the addon's ending and
// a fake clock. The person's `Stop` and `Restart` go through the client's one ending; a stop leaves
// the service stopped, a restart starts it again only once the ending settled, and a stop that did
// not happen puts why on the status topic, from the status file or from the ending's own error.
// The link's loss while an ending runs ends nothing more. A quit sends `daemon.flush` alone,
// signals nothing, and waits for an ending under way.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonRefusal } from "./client/process.js";
import type { DaemonLink } from "./link/status.js";
import type { DaemonSupervisor } from "./supervisor.js";
import {
  ENDING_MS,
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
  it("a stop goes through the client's ending, and the loss that follows leaves it stopped", async () => {
    await linkToStartedService(under);

    const stopping = supervisor.endService("daemon.stop");
    // The service drains and closes its link before its process ends.
    service.connectAnswer = { kind: "absent" };
    service.loseLink();
    await vi.advanceTimersByTimeAsync(ENDING_MS);

    await expect(stopping).resolves.toBe("exited");
    // The ending under way is the only one: the loss ends nothing more.
    expect(service.endings).toStrictEqual([{ at: 0, ending: "stop" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.state.connection).toStrictEqual({ kind: "stopped" });
    expect(link.state.cannotStop).toBeUndefined();
    expect(service.startTimes).toStrictEqual([0]);
  });

  it("a restart starts the service again only once the client's ending settled", async () => {
    await linkToRunningService(under);

    const restarting = supervisor.endService("daemon.restart");
    service.connectAnswer = { kind: "absent" };
    service.loseLink();
    await vi.advanceTimersByTimeAsync(ENDING_MS - 1);
    expect(service.startTimes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await restarting;

    expect(service.endings).toStrictEqual([{ at: 0, ending: "restart" }]);
    expect(service.startTimes).toStrictEqual([ENDING_MS]);
    expect(link.state).toMatchObject({ connection: { kind: "connected" }, startedByApp: true });
  });

  it("puts the status file's cannotStop on the topic after a stop", async () => {
    await linkToRunningService(under);
    service.statusFile = { cannotStop: { reason: "stopIntent" } };

    const stopping = supervisor.endService("daemon.stop");
    service.loseLink();
    await vi.advanceTimersByTimeAsync(ENDING_MS);
    await stopping;

    expect(link.state).toMatchObject({
      connection: { kind: "stopped" },
      cannotStop: { reason: "stopIntent" },
    });
  });

  it("a stop whose ending failed rejects, leaves the link up and says it did not end", async () => {
    await linkToRunningService(under);
    const refusal = {
      code: JsonRpcErrorCode.InternalError,
      message: "The background service took the request but still answered 30000 ms later",
    };
    service.endingOutcome = { error: refusal };

    const stopping = supervisor.endService("daemon.stop");
    const outcome = expect(stopping).rejects.toBeInstanceOf(DaemonRefusal);
    await vi.advanceTimersByTimeAsync(ENDING_MS);
    await outcome;

    expect(link.state).toMatchObject({
      connection: { kind: "connected" },
      cannotStop: { reason: "notEnded", error: refusal.message },
    });
    // A later loss is brought back, as the stop did not happen.
    service.connectAnswer = { kind: "absent" };
    service.loseLink();
    expect(link.state.connection.kind).toBe("transient_disconnect");
  });
});

describe("the quit", () => {
  it("sends daemon.flush alone, then closes main's connection and ends nothing", async () => {
    await linkToStartedService(under);

    await supervisor.flushAtQuit();

    expect(service.links[0]?.requests).toStrictEqual(["daemon.status.read", "daemon.flush"]);
    expect(service.links[0]?.isClosedByMain()).toBe(true);
    expect(service.endings).toStrictEqual([]);
  });

  it("waits for an ending under way before it lets go, and starts nothing after it", async () => {
    await linkToRunningService(under);
    void supervisor.endService("daemon.restart");
    service.connectAnswer = { kind: "absent" };
    service.loseLink();

    let isSettled = false;
    const quitting = supervisor.flushAtQuit().finally(() => {
      isSettled = true;
    });
    await vi.advanceTimersByTimeAsync(ENDING_MS - 1);
    expect(isSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await quitting;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(isSettled).toBe(true);
    expect(service.startTimes).toStrictEqual([]);
  });

  it("negative control: with no link up there is nothing to flush, and it settles at once", async () => {
    service.afterStart = undefined;
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.flushAtQuit();

    expect(service.links).toStrictEqual([]);
  });
});
