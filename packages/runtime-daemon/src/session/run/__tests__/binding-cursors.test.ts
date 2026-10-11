// A run's binding cursors through its end, followed from the committed log: an ended run's drop
// when the session's next binding opens, and an interrupted run a send continued keeps its own; a
// relaunch whose row is not written leaves no cursor.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { DriverDiagnosticsEmitter } from "../../../provider/driver/diagnostics.js";
import { RuntimeBindingStore } from "../../../provider/runtime-binding-store.js";
import { RunBindingCursors } from "../binding-cursors.js";
import { ExecutionEpochs } from "../epochs.js";
import { openRunEngineFixture, type RunEngineFixture } from "./engine.test-support.js";

describe("run binding cursors", () => {
  let fixture: RunEngineFixture;
  let epochs: ExecutionEpochs;
  let cursors: RunBindingCursors;
  let detachFollow: () => void;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    epochs = new ExecutionEpochs({
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: () => undefined },
        counterSink: { increment: () => undefined },
      }),
    });
    cursors = new RunBindingCursors({
      store: new RuntimeBindingStore(fixture.database),
      epochs,
      runs: fixture.runs,
    });
    detachFollow = fixture.sessionEvents.followAll((event) => {
      cursors.observe(event);
    });
  });

  afterEach(async () => {
    detachFollow();
    await fixture.close();
  });

  async function openBinding(runId: RunId): Promise<string> {
    const binding = await cursors.create({
      runId,
      driverName: "claude",
      contractVersion: "1.0.0",
      spawnConfig: {},
    });
    return binding.id;
  }

  // Mutation: leaving a continued run marked ended drops its cursor at the next binding, while
  // its turn still delivers on it.
  it("drops an ended run's cursor at the session's next binding and keeps a continued run's", async () => {
    const ended = await fixture.runThrough(["starting", "running"]);
    const continued = await fixture.runThrough(["starting", "running"]);
    const endedBinding = await openBinding(ended);
    const continuedBinding = await openBinding(continued);
    for (const newState of ["interrupted", "running"] as const) {
      await fixture.engine.transition({ runId: continued, newState });
    }
    await fixture.engine.transition({ runId: ended, newState: "interrupted" });

    await openBinding(await fixture.queueRun());

    expect(() => epochs.bindingFor(endedBinding)).toThrow();
    expect(epochs.bindingFor(continuedBinding)).toMatchObject({ runId: continued });
  });

  // Mutation: keeping the cursor of a relaunch whose row was not written leaves a cursor open for
  // a binding no row records, which no run's end ever drops.
  it("leaves no cursor open for a relaunch whose row the store did not write", async () => {
    const store = new RuntimeBindingStore(fixture.database);
    const failingCursors = new RunBindingCursors({
      store: {
        create: async (input) => await store.create(input),
        findById: (id) => store.findById(id),
        recordRelaunch: async () => {
          throw new Error("the disk is full");
        },
      },
      epochs,
      runs: fixture.runs,
    });
    const predecessor = await failingCursors.create({
      runId: await fixture.runThrough(["starting", "running"]),
      driverName: "claude",
      contractVersion: "1.0.0",
      spawnConfig: {},
    });

    await expect(
      failingCursors.recordRelaunch({
        predecessorId: predecessor.id,
        bindingId: "binding-relaunched",
        resumeHandle: "conversation-2",
        leftConversations: [],
      }),
    ).rejects.toThrow("the disk is full");
    expect(() => epochs.bindingFor("binding-relaunched")).toThrow();
  });
});
