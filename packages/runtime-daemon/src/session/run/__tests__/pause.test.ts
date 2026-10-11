// The version guard on pause and resume: a request at any version but the run's current one is
// refused `run.version_stale` with the run, its log, its waiting messages and the provider
// untouched, and one at the current version moves the run and reaches the driver once, and a run
// that moves between the read and the write is refused by the guard inside the write. A resume's
// messages are taken only once the driver continued the run, and given back when it did not.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { QueueItemIdSchema } from "@ai-sidekicks/contracts/run/queue";

import type {
  PauseRunParams,
  ResumeRunParams,
  WaitingMessage,
} from "../../../provider/driver/run-control.js";
import { type ContinuedMessages, RunPauseControl } from "../pause.js";
import { openRunEngineFixture, type RunEngineFixture } from "./engine.test-support.js";

describe("RunPauseControl version guard", () => {
  let fixture: RunEngineFixture;
  let control: RunPauseControl;
  let driverCalls: (PauseRunParams | ResumeRunParams)[];
  // What became of a resume's messages, in order, beside each driver call.
  let steps: string[];
  const waiting: WaitingMessage[] = [
    { id: QueueItemIdSchema.parse(randomUUID()), content: "Then the docs" },
  ];
  const continued: ContinuedMessages = {
    read: () => {
      steps.push("read");
      return waiting;
    },
    admit: () => {
      steps.push("admit");
      return Promise.resolve();
    },
    release: () => {
      steps.push("release");
      return Promise.resolve();
    },
  };
  const driver = {
    pauseRun: (params: PauseRunParams) => {
      driverCalls.push(params);
      return Promise.resolve();
    },
    resumeRun: (params: ResumeRunParams) => {
      driverCalls.push(params);
      steps.push("resume");
      return Promise.resolve();
    },
  };

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    control = new RunPauseControl({ runs: fixture.runs, engine: fixture.engine });
    driverCalls = [];
    steps = [];
  });

  afterEach(async () => {
    await fixture.close();
  });

  const cases = [
    { operation: "pause", path: ["starting", "running"] },
    { operation: "resume", path: ["starting", "running", "pausing", "paused"] },
  ] as const;

  function send(operation: "pause" | "resume", targetRunId: RunId, expectedRunVersion: number) {
    const request = { targetRunId, expectedRunVersion };
    return operation === "pause"
      ? control.pause(request, driver)
      : control.resume(request, driver, continued);
  }

  it.each(
    cases.flatMap((testCase) => [
      { ...testCase, label: "older", offset: -1 },
      { ...testCase, label: "newer", offset: 1 },
    ]),
  )("refuses a $operation at a $label version and leaves the run untouched", async (testCase) => {
    const runId = await fixture.runThrough(testCase.path);
    const before = fixture.runs.getRun(runId)!;
    const eventsBefore = fixture.readRunEvents(runId);

    await expect(
      send(testCase.operation, runId, before.version + testCase.offset),
    ).rejects.toMatchObject({ code: "run.version_stale" });

    expect(fixture.runs.getRun(runId)).toEqual(before);
    expect(fixture.readRunEvents(runId)).toEqual(eventsBefore);
    expect(driverCalls).toEqual([]);
    expect(steps).toEqual([]);
  });

  // Mutations: reading the messages before the version check lets a refused resume give back the
  // ones a resume that went delivered, so they are sent twice; taking them before the driver
  // continued the run, or keeping them when it refused, loses them.
  it("takes a resume's messages once the driver continued the run, and gives them back when it refused", async () => {
    const runId = await fixture.runThrough(["starting", "running", "pausing", "paused"]);
    const refused = fixture.runs.getRun(runId)!;
    const refusing = {
      resumeRun: () => Promise.reject(new Error("the process stopped answering")),
    };

    await expect(
      control.resume(
        { targetRunId: runId, expectedRunVersion: refused.version },
        refusing,
        continued,
      ),
    ).rejects.toThrow("the process stopped answering");
    expect(steps).toEqual(["read", "release"]);

    steps = [];
    await fixture.engine.transition({ runId, newState: "pausing" });
    const { version } = fixture.runs.getRun(runId)!;
    await control.resume({ targetRunId: runId, expectedRunVersion: version }, driver, continued);
    expect(steps).toEqual(["read", "resume", "admit"]);
    expect(driverCalls).toEqual([{ sessionId: fixture.sessionId, runId, messages: waiting }]);
  });

  it.each(cases)("admits a $operation at the run's current version", async (testCase) => {
    const runId = await fixture.runThrough(testCase.path);
    const { version } = fixture.runs.getRun(runId)!;

    const ack = await send(testCase.operation, runId, version);

    expect(ack).toEqual({
      runId,
      newState: testCase.operation === "pause" ? "pausing" : "running",
      runVersion: version + 1,
    });
    expect(driverCalls).toHaveLength(1);
  });

  it("refuses a pause whose run moved after it was read, at the guard inside the write", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const read = fixture.runs.getRun(runId)!;
    // The run pauses and comes back after the control read it: running again, at a newer version.
    await fixture.engine.transition({ runId, newState: "pausing" });
    await fixture.engine.transition({ runId, newState: "running" });
    const moved = fixture.runs.getRun(runId)!;
    const eventsBefore = fixture.readRunEvents(runId);
    let readCount = 0;
    const racing = new RunPauseControl({
      runs: { getRun: (id) => (readCount++ === 0 ? read : fixture.runs.getRun(id)) },
      engine: fixture.engine,
    });

    await expect(
      racing.pause({ targetRunId: runId, expectedRunVersion: read.version }, driver),
    ).rejects.toMatchObject({ code: "run.version_stale" });

    expect(fixture.runs.getRun(runId)).toEqual(moved);
    expect(fixture.readRunEvents(runId)).toEqual(eventsBefore);
    expect(driverCalls).toEqual([]);
  });
});
