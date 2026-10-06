// The Codex leg of the output-speed axis: the carried level reaches the provider on every carrier
// as its service tier, standard as a cleared tier, a level the model does not list runs at
// standard and is never refused, each carrier reads the model's tier list afresh, the thread's
// declared tier is held as the provider said it, and each run reports the tier its turn settled
// at.

import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { CreateSessionParams } from "../../contract.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { CodexTransportError, type CodexModelCatalogExchange } from "../index.js";
import {
  type Harness,
  type JsonRpcAnswer,
  RUN_ID,
  SECOND_RUN_ID,
  SESSION_ID,
  TEST_MODEL,
  THREAD_ID,
  createHarness,
  threadStartResult,
  turnCompletedFrame,
} from "./app-server.test-support.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";

const FAST_TIER = "priority";
/** A model whose catalog row publishes no tier, so it lists no level at all. */
const TIERLESS_MODEL = "gpt-daybreak-blue-latest";
/** A second model publishing the fast tier. */
const SECOND_FAST_MODEL = "gpt-6-sol";
/** A model publishing tiers, but not the fast one. */
const FLEX_ONLY_MODEL = "gpt-6-luna";
/** Read in place of a member a request left out, so an omission never passes for `null`. */
const OMITTED = "<omitted>";

const CATALOG_READ: CodexModelCatalogExchange = () =>
  Promise.resolve({
    data: [
      {
        id: TEST_MODEL,
        displayName: "GPT-5.5",
        serviceTiers: [{ id: FAST_TIER, name: "Fast", description: "1.5x speed, increased usage" }],
      },
      { id: TIERLESS_MODEL, displayName: "Daybreak Blue", serviceTiers: [] },
      {
        id: SECOND_FAST_MODEL,
        displayName: "GPT-6 Sol",
        serviceTiers: [{ id: FAST_TIER, name: "Fast", description: "2x speed" }],
      },
      {
        id: FLEX_ONLY_MODEL,
        displayName: "GPT-6 Luna",
        serviceTiers: [{ id: "flex", name: "Flex", description: "Slower, lower cost" }],
      },
    ],
    nextCursor: null,
  });

function speedHarness(
  onRunOutputSpeedSettled?: (
    sessionId: SessionId,
    runId: RunId,
    state: ProviderOutputSpeedState,
  ) => void,
): Harness {
  const harness = createHarness({ modelCatalogExchange: CATALOG_READ, onRunOutputSpeedSettled });
  // A resume's process must not displace the reader of the one it replaces.
  harness.server.uniqueSpawnSessionIds = true;
  harness.server.on("thread/start", () => threadStartResult());
  harness.server.on("thread/resume", () => threadStartResult(1));
  return harness;
}

function createSpeedSession(harness: Harness, outputSpeed?: string): Promise<unknown> {
  const params: CreateSessionParams =
    outputSpeed === undefined ? CREATE_PARAMS : { ...CREATE_PARAMS, outputSpeed };
  return harness.driver.createSession(params);
}

/** The `member` the newest `method` request carried, or `OMITTED` when it had none. */
function sentMember(harness: Harness, method: string, member: string): unknown {
  const params = harness.server.framesForMethod(method).at(-1)?.["params"];
  if (typeof params !== "object" || params === null) {
    throw new Error(`no ${method} request was written`);
  }
  return Object.hasOwn(params, member) ? (params as Record<string, unknown>)[member] : OMITTED;
}

function sentTier(harness: Harness, method: string): unknown {
  return sentMember(harness, method, "serviceTier");
}

/** A thread establishment reply declaring `serviceTier`. */
function declaringTier(serviceTier: string | null, turnCount = 0): () => JsonRpcAnswer {
  return () => ({ result: { ...(threadStartResult(turnCount).result as object), serviceTier } });
}

let turnSequence = 0;

/** Starts a run whose turn the provider accepts and leaves it running; answers the turn id. */
async function startTurn(
  harness: Harness,
  runId: RunId,
  extra: { outputSpeed?: string; model?: string } = {},
): Promise<string> {
  turnSequence += 1;
  const turnId = `turn-speed-${String(turnSequence)}`;
  harness.server.on("turn/start", () => ({ result: { turn: { id: turnId } } }));
  await harness.driver.startRun({
    runId,
    agentConfig: {
      sessionId: SESSION_ID,
      input: "go",
      ...(extra.model === undefined ? {} : { model: extra.model }),
    },
    ...(extra.outputSpeed === undefined ? {} : { outputSpeed: extra.outputSpeed }),
  });
  return turnId;
}

/** Starts a run whose turn the provider accepts, then completes that turn. */
async function runTurn(
  harness: Harness,
  runId: RunId,
  extra: { outputSpeed?: string; model?: string } = {},
): Promise<void> {
  const turnId = await startTurn(harness, runId, extra);
  harness.server.emitFrame(turnCompletedFrame(turnId, "completed"));
  await drainMicrotasks();
}

function emitItemStarted(harness: Harness, turnId: string): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "item/started",
    params: { threadId: THREAD_ID, turnId, item: { type: "agentMessage", id: "item-1" } },
  });
}

function emitThreadSettings(harness: Harness, threadId: string, serviceTier: unknown): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "thread/settings/updated",
    params: { threadId, threadSettings: { model: TEST_MODEL, serviceTier } },
  });
}

describe("Codex output speed carriers", () => {
  it("sends the requested level on establishment, every turn, a fork and a resume", async () => {
    const harness = speedHarness();
    await createSpeedSession(harness, FAST_TIER);
    expect(sentTier(harness, "thread/start")).toBe(FAST_TIER);

    // A run carrying no level gets the thread's.
    await runTurn(harness, RUN_ID);
    expect(sentTier(harness, "turn/start")).toBe(FAST_TIER);

    harness.server.on("thread/fork", () => ({
      result: { thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [] } },
    }));
    await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
    expect(sentTier(harness, "thread/fork")).toBe(FAST_TIER);

    // The level the spawn record rebuilt for the resume.
    await harness.driver.resumeSession({ ...RESUME_PARAMS, outputSpeed: FAST_TIER });
    expect(sentTier(harness, "thread/resume")).toBe(FAST_TIER);
  });

  it("sends standard as a cleared tier, and a run's level in place of the thread's", async () => {
    const harness = speedHarness();
    await createSpeedSession(harness, "default");
    expect(sentTier(harness, "thread/start")).toBeNull();

    await runTurn(harness, RUN_ID, { outputSpeed: FAST_TIER });
    expect(sentTier(harness, "turn/start")).toBe(FAST_TIER);
    // The run's level is the thread's now, so a run carrying none keeps it.
    await runTurn(harness, SECOND_RUN_ID);
    expect(sentTier(harness, "turn/start")).toBe(FAST_TIER);
    await runTurn(harness, "44444444-4444-4444-8444-444444444444" as RunId, {
      outputSpeed: "default",
    });
    expect(sentTier(harness, "turn/start")).toBeNull();

    harness.server.on("thread/fork", () => ({
      result: { thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [] } },
    }));
    await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
    expect(sentTier(harness, "thread/fork")).toBeNull();

    await harness.driver.resumeSession({ ...RESUME_PARAMS, outputSpeed: "default" });
    expect(sentTier(harness, "thread/resume")).toBeNull();
  });

  it("leaves the provider's own tier alone when no level was ever requested", async () => {
    const harness = speedHarness();
    await createSpeedSession(harness);
    await runTurn(harness, RUN_ID);

    expect(sentTier(harness, "thread/start")).toBe(OMITTED);
    expect(sentTier(harness, "turn/start")).toBe(OMITTED);
  });
});

describe("Codex session model", () => {
  it("starts, resumes and forks the thread on the session's model", async () => {
    const harness = speedHarness();
    await createSpeedSession(harness);
    expect(sentMember(harness, "thread/start", "model")).toBe(TEST_MODEL);

    // A run's model is the thread's from then on, so the fork carries it.
    await runTurn(harness, RUN_ID, { model: TIERLESS_MODEL });
    harness.server.on("thread/fork", () => ({
      result: { thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [] } },
    }));
    await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
    expect(sentMember(harness, "thread/fork", "model")).toBe(TIERLESS_MODEL);

    await harness.driver.resumeSession({ ...RESUME_PARAMS, model: TIERLESS_MODEL });
    expect(sentMember(harness, "thread/resume", "model")).toBe(TIERLESS_MODEL);
  });
});

const THIRD_RUN_ID = "44444444-4444-4444-8444-444444444444" as RunId;

describe("Codex output speed resolution", () => {
  it("runs a level the model does not list at standard on every carrier, refusing none", async () => {
    const harness = speedHarness();
    await createSpeedSession(harness, "flex");
    expect(sentTier(harness, "thread/start")).toBeNull();
    // The request is kept and resolved again on each turn, so a run carrying none sends standard.
    await runTurn(harness, RUN_ID);
    expect(sentTier(harness, "turn/start")).toBeNull();
    await runTurn(harness, SECOND_RUN_ID, { outputSpeed: "flex" });
    expect(sentTier(harness, "turn/start")).toBeNull();

    harness.server.on("thread/resume", declaringTier(null, 1));
    const resumed = await harness.driver.resumeSession({ ...RESUME_PARAMS, outputSpeed: "flex" });
    expect(resumed.status).toBe("resumed");
    expect(sentTier(harness, "thread/resume")).toBeNull();
    expect(harness.driver.observedOutputSpeedFor(SESSION_ID)).toStrictEqual({
      declared: "default",
    });

    // A model with no tier at all runs at standard too.
    await harness.driver.createSession({
      ...CREATE_PARAMS,
      sessionId: "session-tierless" as SessionId,
      model: TIERLESS_MODEL,
      outputSpeed: FAST_TIER,
    });
    expect(sentTier(harness, "thread/start")).toBeNull();
  });

  it("re-resolves the carried level on each model switch, so standard never sticks", async () => {
    const harness = speedHarness();
    await createSpeedSession(harness, FAST_TIER);

    await runTurn(harness, RUN_ID, { model: FLEX_ONLY_MODEL });
    expect(sentTier(harness, "turn/start")).toBeNull();
    await runTurn(harness, SECOND_RUN_ID);
    expect(sentTier(harness, "turn/start")).toBeNull();
    await runTurn(harness, THIRD_RUN_ID, { model: TIERLESS_MODEL });
    expect(sentTier(harness, "turn/start")).toBeNull();

    // A model listing the level again runs at it: the request was kept, not the fallback.
    await runTurn(harness, "55555555-5555-4555-8555-555555555555" as RunId, {
      model: SECOND_FAST_MODEL,
    });
    expect(sentTier(harness, "turn/start")).toBe(FAST_TIER);
  });

  it("reads the tier list afresh on an unchanged turn and a fork", async () => {
    let testModelTiers = [{ id: FAST_TIER, name: "Fast", description: "1.5x speed" }];
    const harness = createHarness({
      modelCatalogExchange: () =>
        Promise.resolve({
          data: [{ id: TEST_MODEL, displayName: "GPT-5.5", serviceTiers: testModelTiers }],
          nextCursor: null,
        }),
    });
    harness.server.on("thread/start", () => threadStartResult());
    await createSpeedSession(harness, FAST_TIER);
    await runTurn(harness, RUN_ID);
    expect(sentTier(harness, "turn/start")).toBe(FAST_TIER);

    // The provider stops offering the fast tier on this model; the session's request is unchanged.
    testModelTiers = [];
    await runTurn(harness, SECOND_RUN_ID);
    expect(sentTier(harness, "turn/start")).toBeNull();
    harness.server.on("thread/fork", () => ({
      result: { thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [] } },
    }));
    await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
    expect(sentTier(harness, "thread/fork")).toBeNull();
  });

  it("sends no turn on a thread re-established while its level was being resolved", async () => {
    let releaseCatalog = (): void => undefined;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let gateNextRead = false;
    const harness = createHarness({
      modelCatalogExchange: async () => {
        if (gateNextRead) {
          await catalogGate;
        }
        return await CATALOG_READ();
      },
    });
    harness.server.on("thread/start", () => threadStartResult());
    harness.server.on("thread/resume", () => threadStartResult(1));
    await createSpeedSession(harness);

    gateNextRead = true;
    const starting = runTurn(harness, RUN_ID, { outputSpeed: FAST_TIER });
    await drainMicrotasks();
    // The resume is mid-flight when the read settles, so the turn would reach a leg being
    // replaced.
    const releaseResume = harness.server.holdAnswers("thread/resume");
    const resuming = harness.driver.resumeSession(RESUME_PARAMS);
    await drainMicrotasks();
    releaseCatalog();

    await expect(starting).rejects.toBeInstanceOf(CodexTransportError);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
    releaseResume();
    expect((await resuming).status).toBe("resumed");
  });
});

describe("Codex declared output speed", () => {
  it("holds the declared tier verbatim from establishment and each settings notice", async () => {
    const harness = speedHarness();
    // The provider took the request and declared standard: that is a reading, not a failure.
    harness.server.on("thread/start", declaringTier(null));
    await createSpeedSession(harness, FAST_TIER);
    expect(harness.driver.observedOutputSpeedFor(SESSION_ID)).toStrictEqual({
      declared: "default",
    });

    emitThreadSettings(harness, THREAD_ID, FAST_TIER);
    await drainMicrotasks();
    expect(harness.driver.observedOutputSpeedFor(SESSION_ID)).toStrictEqual({
      declared: FAST_TIER,
    });

    // A child thread's settings are not this thread's declaration.
    emitThreadSettings(harness, "thread-child", null);
    await drainMicrotasks();
    expect(harness.driver.observedOutputSpeedFor(SESSION_ID)).toStrictEqual({
      declared: FAST_TIER,
    });

    // A tier no catalog lists is a real state under version skew, carried as declared.
    emitThreadSettings(harness, THREAD_ID, "flex");
    await drainMicrotasks();
    expect(harness.driver.observedOutputSpeedFor(SESSION_ID)).toStrictEqual({ declared: "flex" });

    // The declaration never rewrites the request: the next turn still asks for the fast tier.
    await runTurn(harness, RUN_ID);
    expect(sentTier(harness, "turn/start")).toBe(FAST_TIER);
  });
});

describe("Codex output speed per run", () => {
  function settledHarness(): { harness: Harness; settled: unknown[] } {
    const settled: unknown[] = [];
    const harness = speedHarness((sessionId, runId, state) => {
      expect(sessionId).toBe(SESSION_ID);
      settled.push({ runId, state });
    });
    harness.server.on("thread/start", declaringTier(null));
    return { harness, settled };
  }

  it("settles a turn that changes the tier on its notice, and any other on its first item", async () => {
    const { harness, settled } = settledHarness();
    await createSpeedSession(harness);

    // The turn asks for the fast tier on a thread declaring standard: its first item is too early.
    const changing = await startTurn(harness, RUN_ID, { outputSpeed: FAST_TIER });
    emitItemStarted(harness, changing);
    await drainMicrotasks();
    expect(settled).toStrictEqual([]);
    emitThreadSettings(harness, THREAD_ID, FAST_TIER);
    await drainMicrotasks();
    expect(settled).toStrictEqual([{ runId: RUN_ID, state: { declared: FAST_TIER } }]);
    emitThreadSettings(harness, THREAD_ID, FAST_TIER);
    harness.server.emitFrame(turnCompletedFrame(changing, "completed"));
    await drainMicrotasks();
    expect(settled).toHaveLength(1);

    // The same tier again changes nothing, so the first item settles it.
    const steady = await startTurn(harness, SECOND_RUN_ID);
    emitItemStarted(harness, steady);
    await drainMicrotasks();
    const bothSettled = [
      { runId: RUN_ID, state: { declared: FAST_TIER } },
      { runId: SECOND_RUN_ID, state: { declared: FAST_TIER } },
    ];
    expect(settled).toStrictEqual(bothSettled);
    emitItemStarted(harness, steady);
    harness.server.emitFrame(turnCompletedFrame(steady, "completed"));
    await drainMicrotasks();
    expect(settled).toStrictEqual(bothSettled);
  });

  it("settles at the turn's end when no notice came, and at once for a turn already ended", async () => {
    const { harness, settled } = settledHarness();
    await createSpeedSession(harness);

    // The provider never declared the asked-for tier, so the run ran at the one it holds.
    const unanswered = await startTurn(harness, RUN_ID, { outputSpeed: FAST_TIER });
    emitItemStarted(harness, unanswered);
    harness.server.emitFrame(turnCompletedFrame(unanswered, "completed"));
    await drainMicrotasks();
    expect(settled).toStrictEqual([{ runId: RUN_ID, state: { declared: "default" } }]);

    // A turn whose end arrived before its acceptance was read.
    harness.server.on("turn/start", () => {
      harness.server.emitFrame(turnCompletedFrame("turn-already-ended", "completed"));
      return { result: { turn: { id: "turn-already-ended" } } };
    });
    await harness.driver.startRun({
      runId: SECOND_RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(settled.at(-1)).toStrictEqual({
      runId: SECOND_RUN_ID,
      state: { declared: "default" },
    });
  });
});
