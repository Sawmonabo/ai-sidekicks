// Each run after a session's first gets a binding on the session's current conversation, the one a
// relaunch the driver started on its own moved it to included, so a resume after a daemon restart
// opens that conversation and not the one the relaunch left. A level move stores the level of a
// session not open, which its process opens at, and moves an open one's process before storing it,
// one move or open at a time, so the process never runs at a level other than the stored one; at
// Sandboxed the repository's git folder is writable.

import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";

import { composeExecutionPosture } from "../../policy/execution-posture-service.js";
import { RuntimeBindingStore, selectSessionLeg } from "../../provider/runtime-binding-store.js";
import {
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { ProviderSessions } from "../provider-session.js";

const GIT_FOLDER = "/work/repo/.git";

// The level a session stands at, each move and store in the order it ran, and the hooks a test
// holds a create or fails a store with.
interface LevelStore {
  level: PermissionLevel;
  readonly steps: string[];
  createGate?: Promise<void>;
  storeFailure?: Error;
}

// The provider sessions of the fixture's session, opened at the stored level on a driver that
// creates every session and resumes none.
function buildProviderSessions(
  engineFixture: RunEngineFixture,
  store: LevelStore,
): { sessions: ProviderSessions; runtimeBindings: RuntimeBindingStore } {
  const { database } = engineFixture;
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
      createSession: async (params) => {
        await store.createGate;
        store.steps.push(`opened ${params.executionPosture?.mode ?? "no level"}`);
        return { providerSessionId: "provider-session", resumeHandle: "conversation-opened" };
      },
      resumeSession: () => Promise.reject(new Error("No resume is part of this test")),
    }),
    readContractVersion: () => "1.0.0",
    readPermissionLevel: () => store.level,
    recordPermissionLevel: async (_sessionId, level) => {
      if (store.storeFailure !== undefined) {
        throw store.storeFailure;
      }
      store.level = level;
      store.steps.push(`stored ${level}`);
    },
    composeOpening: (openingSessionId) =>
      Promise.resolve({
        driverName: "claude",
        gitFolder: GIT_FOLDER,
        createParams: {
          sessionId: openingSessionId,
          config: {},
          model: "test-model",
          largerWindow: undefined,
          executionPosture: composeExecutionPosture(store.level, GIT_FOLDER),
        },
        functionLegsFor: () => ({}),
      }),
    readSessionLeg: (legSessionId) =>
      selectSessionLeg(
        runtimeBindings.findByRuns(selectRunIds.all(legSessionId).map((row) => row.runId)),
      ),
    readSessionMode: () => "build",
  });
  return { sessions, runtimeBindings };
}

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
    const { sessionId } = engineFixture;
    const { sessions, runtimeBindings } = buildProviderSessions(engineFixture, {
      level: "yolo",
      steps: [],
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

describe("a session's level move", () => {
  let fixture: RunEngineFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  async function openFixture(level: PermissionLevel): Promise<{
    engineFixture: RunEngineFixture;
    sessions: ProviderSessions;
    store: LevelStore;
  }> {
    const engineFixture = await openRunEngineFixture();
    fixture = engineFixture;
    const store: LevelStore = { level, steps: [] };
    return { engineFixture, sessions: buildProviderSessions(engineFixture, store).sessions, store };
  }

  // The process move a level change hands its session, recorded among the steps.
  function moveProcess(store: LevelStore): (posture: ExecutionPosture) => Promise<void> {
    return async (posture) => {
      await Promise.resolve();
      store.steps.push(`moved ${posture.mode}`);
    };
  }

  it("stores the level of a session not open, which its process opens at", async () => {
    const { engineFixture, sessions, store } = await openFixture("ask");
    const { sessionId } = engineFixture;

    await sessions.changeLevel(sessionId, "sandboxed", moveProcess(store));
    await sessions.open(sessionId, await engineFixture.runThrough(["starting", "running"]));

    expect(store.steps).toStrictEqual(["stored sandboxed", "opened sandboxed"]);
    expect(await sessions.readExecutionPosture(sessionId)).toMatchObject({
      mode: "sandboxed",
      writableRoots: [GIT_FOLDER],
    });
  });

  it("moves an open session's process first, stores nothing it refused, and skips its own level", async () => {
    const { engineFixture, sessions, store } = await openFixture("sandboxed");
    const { sessionId } = engineFixture;
    await sessions.open(sessionId, await engineFixture.runThrough(["starting", "running"]));

    await sessions.changeLevel(sessionId, "ask", moveProcess(store));
    await expect(
      sessions.changeLevel(sessionId, "reviewed", () => Promise.reject(new Error("refused"))),
    ).rejects.toThrow("refused");
    await sessions.changeLevel(sessionId, "ask", moveProcess(store));

    expect(store.steps).toStrictEqual(["opened sandboxed", "moved ask", "stored ask"]);
    expect(await sessions.readExecutionPosture(sessionId)).toMatchObject({
      mode: "ask",
      writableRoots: [],
    });
  });

  // Mutation: reading whether the session is open outside the open's lock stores the level alone
  // while the open, which read the old level, starts the process at it.
  it("waits for an open under way, then moves the process it started", async () => {
    const { engineFixture, sessions, store } = await openFixture("ask");
    const { sessionId } = engineFixture;
    let releaseCreate = (): void => {};
    store.createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    const opening = sessions.open(sessionId, await engineFixture.runThrough(["starting"]));
    const changing = sessions.changeLevel(sessionId, "yolo", moveProcess(store));
    releaseCreate();
    await Promise.all([opening, changing]);

    expect(store.steps).toStrictEqual(["opened ask", "moved yolo", "stored yolo"]);
    expect((await sessions.readExecutionPosture(sessionId)).mode).toBe("yolo");
  });

  it("stores the level the process was moved to last when two moves come at once", async () => {
    const { engineFixture, sessions, store } = await openFixture("ask");
    const { sessionId } = engineFixture;
    await sessions.open(sessionId, await engineFixture.runThrough(["starting", "running"]));

    await Promise.all([
      sessions.changeLevel(sessionId, "sandboxed", moveProcess(store)),
      sessions.changeLevel(sessionId, "yolo", moveProcess(store)),
    ]);

    expect(store.steps).toStrictEqual([
      "opened ask",
      "moved sandboxed",
      "stored sandboxed",
      "moved yolo",
      "stored yolo",
    ]);
  });

  it("moves the process back when its level could not be stored", async () => {
    const { engineFixture, sessions, store } = await openFixture("ask");
    const { sessionId } = engineFixture;
    await sessions.open(sessionId, await engineFixture.runThrough(["starting", "running"]));
    store.storeFailure = new Error("the disk is full");

    await expect(sessions.changeLevel(sessionId, "yolo", moveProcess(store))).rejects.toThrow(
      "the disk is full",
    );

    expect(store.steps).toStrictEqual(["opened ask", "moved yolo", "moved ask"]);
    expect((await sessions.readExecutionPosture(sessionId)).mode).toBe("ask");
  });
});
