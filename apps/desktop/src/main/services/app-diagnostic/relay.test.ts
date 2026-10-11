// The relay of app diagnostics to the service's diagnostic log: a repeated error is written three
// times a minute and thirty errors in all, the rest told as one count once the minute ends, and a
// count held back again keeps every record it counted; main's own error is also written to main's
// log; while the service cannot be reached, nothing throws, the first thirty-two records wait and
// go when a link comes up, and the records past them go as a count; the records the service did
// not take go as a count with the next one it takes, and main's own log says once per outage that
// the service is not taking them.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  linkOver,
  scriptedConnection,
  type ScriptedAnswer,
  type ScriptedConnection,
} from "../../bridge/daemon.test-support.js";
import { DaemonLink } from "../daemon/link/status.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { APP_DIAGNOSTIC_RATE_BOUNDS } from "#shared/app-diagnostic/rate-limit.js";

import { AppDiagnosticRelay, APP_DIAGNOSTIC_RECORDS_HELD_WHILE_UNREACHABLE } from "./relay.js";

const NOW = new Date("2026-10-11T16:00:00.000Z");

const { all, perRecord, windowMs } = APP_DIAGNOSTIC_RATE_BOUNDS;

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

/** What main's own log was handed at `level`. */
function logLinesAt(level: string): string[] {
  return log.write.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.level === level)
    .map((entry) => `${entry.source} ${entry.message}`);
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
    for (let error = 0; error < all; error++) {
      relay.reportFromMain(new Error(`error ${String(error)}`), "uncaught-error");
    }
    await settle();
    const written = [
      ...Array<string>(perRecord).fill("the row is gone"),
      ...Array.from({ length: all - perRecord }, (_unused, error) => `error ${String(error)}`),
    ];
    expect(recordsOn(connection)).toStrictEqual(written);
    // Main's log keeps what the service was sent of main's own errors, and only that.
    expect(logLinesAt("error")).toHaveLength(all);
    expect(logLinesAt("error")[0]).toMatch(
      /^main\/app-diagnostic uncaught-error: Error: the row is gone\n\s+at /,
    );

    vi.advanceTimersByTime(windowMs);
    await settle();
    // Two repeats and three errors past the thirty.
    expect(recordsOn(connection).slice(all)).toStrictEqual(["5 past-rate"]);
    relay.reportFromMain(new Error("the row is gone"), "uncaught-error");
    await settle();
    expect(recordsOn(connection).slice(all + 1)).toStrictEqual(["the row is gone"]);
  });

  it("keeps every record a count stood for when the count is held back again", async () => {
    const connection = scriptedConnection(() => TAKEN);
    const relay = new AppDiagnosticRelay({
      link: await linkOver(connection),
      log,
      now: () => new Date(),
    });

    for (let time = 0; time <= perRecord; time++) {
      relay.reportFromWindow([{ kind: "held-back", cause: "window-buffer-full", count: 5 }]);
    }
    vi.advanceTimersByTime(windowMs);
    await settle();

    expect(recordsOn(connection)).toStrictEqual([
      ...Array<string>(perRecord).fill("5 window-buffer-full"),
      "5 past-rate",
    ]);
  });

  it("never throws while the service is away, and sends what waited and a count once it is back", async () => {
    const link = new DaemonLink();
    const relay = new AppDiagnosticRelay({ link, log, now: () => new Date() });

    // Two minutes of errors with no link: thirty, then one past the thirty-two that wait.
    const secondMinuteCount = APP_DIAGNOSTIC_RECORDS_HELD_WHILE_UNREACHABLE - all + 1;
    for (let error = 0; error < all; error++) {
      relay.reportFromMain(new Error(`first minute ${String(error)}`), "uncaught-error");
    }
    vi.advanceTimersByTime(windowMs);
    for (let error = 0; error < secondMinuteCount; error++) {
      relay.reportFromMain(new Error(`second minute ${String(error)}`), "uncaught-error");
    }

    let answer: ScriptedAnswer = TAKEN;
    const connection = scriptedConnection(() => answer);
    const back = await linkOver(connection);
    link.attach(back.client!, back.state);
    await settle();
    expect(recordsOn(connection)).toStrictEqual([
      ...Array.from({ length: all }, (_unused, error) => `first minute ${String(error)}`),
      ...Array.from(
        { length: secondMinuteCount - 1 },
        (_unused, error) => `second minute ${String(error)}`,
      ),
      "1 service-unreachable",
    ]);

    // The service stops taking records: each one is counted, and main's log says so once.
    answer = REFUSED;
    relay.reportFromMain(new Error("refused 1"), "uncaught-error");
    relay.reportFromMain(new Error("refused 2"), "uncaught-error");
    await settle();
    expect(logLinesAt("warning")).toHaveLength(1);
    expect(logLinesAt("warning")[0]).toMatch(/^main\/app-diagnostic The background service/);

    // The next record it takes brings the count with it.
    answer = TAKEN;
    relay.reportFromMain(new Error("taken"), "uncaught-error");
    await settle();
    expect(recordsOn(connection).slice(-2)).toStrictEqual(["taken", "2 service-refused"]);
  });
});
