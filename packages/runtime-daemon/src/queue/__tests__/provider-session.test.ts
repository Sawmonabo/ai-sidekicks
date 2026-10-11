// Each run after a session's first gets a binding on the session's current conversation, the one a
// relaunch the driver started on its own moved it to included, so a resume after a daemon restart
// opens that conversation and not the one the relaunch left.

import { afterEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { RuntimeBindingStore, selectSessionLeg } from "../../provider/runtime-binding-store.js";
import {
  openRunEngineFixture,
  TEST_EXECUTION_POSTURE,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { ProviderSessions } from "../provider-session.js";

describe("the binding of a session's later run", () => {
  let fixture: RunEngineFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  // Mutation: copying the binding the session was opened on reads the conversation a relaunch
  // left, which every later run and a resume after a restart then open again.
  it("runs on the conversation a relaunch moved the session to", async () => {
    const engineFixture = await openRunEngineFixture();
    fixture = engineFixture;
    const { database, sessionId } = engineFixture;
    let clockMs = Date.parse("2026-10-11T09:00:00.000Z");
    const runtimeBindings = new RuntimeBindingStore(database, {
      now: () => new Date((clockMs += 1_000)).toISOString(),
    });
    const selectRunIds = database.reader.prepare<[string], { runId: RunId }>(
      "SELECT run_id AS runId FROM runs WHERE session_id = ?",
    );
    const sessions = new ProviderSessions({
      runtimeBindings,
      bindingCursors: runtimeBindings,
      resolveDriver: () => ({
        createSession: () =>
          Promise.resolve({
            providerSessionId: "provider-session",
            resumeHandle: "conversation-opened",
          }),
        resumeSession: () => Promise.reject(new Error("No resume is part of this test")),
      }),
      readContractVersion: () => "1.0.0",
      composeOpening: (openingSessionId) =>
        Promise.resolve({
          driverName: "claude",
          createParams: {
            sessionId: openingSessionId,
            config: {},
            model: "test-model",
            largerWindow: undefined,
            executionPosture: TEST_EXECUTION_POSTURE,
          },
          functionLegsFor: () => ({}),
        }),
      readSessionLeg: (legSessionId) =>
        selectSessionLeg(
          runtimeBindings.findByRuns(selectRunIds.all(legSessionId).map((row) => row.runId)),
        ),
      readSessionMode: () => "build",
    });
    const firstRunId = await engineFixture.runThrough(["starting", "running"]);
    await sessions.open(sessionId, firstRunId);
    const [opened] = runtimeBindings.findByRun(firstRunId);
    if (opened === undefined) {
      throw new Error("The session opened on no binding");
    }

    // The process ended and the driver resumed the session in a new conversation.
    await runtimeBindings.recordRelaunch({
      predecessorId: opened.id,
      bindingId: "relaunched-binding",
      resumeHandle: "conversation-relaunched",
      leftConversations: [],
    });
    const laterRunId = await engineFixture.runThrough(["starting"]);
    const bindingId = await sessions.openRunBinding(laterRunId, sessionId);

    expect(runtimeBindings.findById(bindingId)).toMatchObject({
      runId: laterRunId,
      resumeHandle: "conversation-relaunched",
    });
  });
});
