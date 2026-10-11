// The relay of app diagnostics to the service's diagnostic log: a repeated error is written three
// times a minute and thirty errors in all, the rest told as one count once the minute ends; while
// the service cannot be reached, nothing throws, the first thirty-two records wait and go when a
// link comes up, and every record past them or the service did not take is sent as a count, with
// main's own log saying once per outage that the service is not taking them.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  linkOver,
  scriptedConnection,
  type ScriptedAnswer,
  type ScriptedConnection,
} from "../../bridge/daemon.test-support.js";
import { DaemonLink, unlinkedState } from "../daemon/link/status.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { AppDiagnosticRelay } from "./relay.js";
import { APP_DIAGNOSTIC_RATE_BOUNDS } from "./repeat-limit.js";

const NOW = new Date("2026-10-11T16:00:00.000Z");

const TAKEN: ScriptedAnswer = { result: {} };

const REFUSED: ScriptedAnswer = {
  error: { code: JsonRpcErrorCode.InternalError, message: "The service log is closed" },
};

/** What the service was handed, in order: each error's message, or a count and its cause. */
function recordsOn(connection: ScriptedConnection): string[] {
  return connection.requests.map(({ params }) => {
    const record = params as { kind: string; message?: string; count?: number; cause?: string };
    return record.kind === "held-back"
      ? `${String(record.count)} ${String(record.cause)}`
      : String(record.message);
  });
}

/** Settles the calls under way and the scripted answers to them. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) {
    await Promise.resolve();
  }
}

let log: { readonly write: Mock<MainDiagnosticLog["write"]> };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  log = { write: vi.fn<MainDiagnosticLog["write"]>() };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the app diagnostic relay", () => {
  it("writes a repeat three times and thirty errors a minute, and counts the rest", async () => {
    const connection = scriptedConnection(() => TAKEN);
    const relay = new AppDiagnosticRelay({
      link: await linkOver(connection),
      log,
      now: () => new Date(),
    });

    for (let time = 0; time < 5; time++) {
      relay.reportFromMain(new Error("the row is gone"), "uncaught-error");
    }
    for (let error = 0; error < APP_DIAGNOSTIC_RATE_BOUNDS.all; error++) {
      relay.reportFromMain(new Error(`error ${String(error)}`), "uncaught-error");
    }
    await settle();
    expect(recordsOn(connection)).toStrictEqual([
      ...Array<string>(APP_DIAGNOSTIC_RATE_BOUNDS.perRecord).fill("the row is gone"),
      ...Array.from({ length: 27 }, (_unused, error) => `error ${String(error)}`),
    ]);

    vi.advanceTimersByTime(APP_DIAGNOSTIC_RATE_BOUNDS.windowMs);
    await settle();
    // Two repeats and three errors past the thirty.
    expect(recordsOn(connection).slice(30)).toStrictEqual(["5 repeated"]);
    relay.reportFromMain(new Error("the row is gone"), "uncaught-error");
    await settle();
    expect(recordsOn(connection).slice(31)).toStrictEqual(["the row is gone"]);
  });

  it("never throws while the service is away, and sends what waited and a count once it is back", async () => {
    const link = new DaemonLink();
    const relay = new AppDiagnosticRelay({ link, log, now: () => new Date() });

    // Two minutes of errors with no link: thirty, then three more, past the thirty-two that wait.
    for (let error = 0; error < 30; error++) {
      relay.reportFromMain(new Error(`first minute ${String(error)}`), "uncaught-error");
    }
    vi.advanceTimersByTime(APP_DIAGNOSTIC_RATE_BOUNDS.windowMs);
    for (let error = 0; error < 3; error++) {
      relay.reportFromMain(new Error(`second minute ${String(error)}`), "uncaught-error");
    }

    let answer: ScriptedAnswer = TAKEN;
    const connection = scriptedConnection(() => answer);
    const back = await linkOver(connection);
    link.attach(back.client!, back.state);
    await settle();
    expect(recordsOn(connection)).toStrictEqual([
      ...Array.from({ length: 30 }, (_unused, error) => `first minute ${String(error)}`),
      "second minute 0",
      "second minute 1",
      "1 service-unreachable",
    ]);

    // The service stops taking records: each one is counted, and main's log says so once.
    answer = REFUSED;
    relay.reportFromMain(new Error("refused 1"), "uncaught-error");
    relay.reportFromMain(new Error("refused 2"), "uncaught-error");
    await settle();
    expect(log.write).toHaveBeenCalledTimes(1);
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning", source: "main/app-diagnostics" }),
    );

    answer = TAKEN;
    link.detach(unlinkedState({ kind: "connecting" }));
    link.attach(back.client!, back.state);
    await settle();
    expect(recordsOn(connection).slice(-1)).toStrictEqual(["2 service-unreachable"]);
  });
});
