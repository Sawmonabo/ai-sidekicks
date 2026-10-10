// The version guard on pause and resume: a request at any version but the run's current one is
// refused `run.version_stale` with the run, its log and the provider untouched, and one at the
// current version moves the run and reaches the driver once, and a run that moves between the read
// and the write is refused by the guard inside the write.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { PauseRunParams, ResumeRunParams } from "../../../provider/driver/run-control.js";
import { RunPauseControl } from "../pause.js";
import { openRunEngineFixture, type RunEngineFixture } from "./engine.test-support.js";

describe("RunPauseControl version guard", () => {
  let fixture: RunEngineFixture;
  let control: RunPauseControl;
  let driverCalls: (PauseRunParams | ResumeRunParams)[];
  const driver = {
    pauseRun: (params: PauseRunParams) => {
      driverCalls.push(params);
      return Promise.resolve();
    },
    resumeRun: (params: ResumeRunParams) => {
      driverCalls.push(params);
      return Promise.resolve();
    },
  };

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    control = new RunPauseControl({ runs: fixture.runs, engine: fixture.engine });
    driverCalls = [];
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
      : control.resume(request, driver, []);
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
