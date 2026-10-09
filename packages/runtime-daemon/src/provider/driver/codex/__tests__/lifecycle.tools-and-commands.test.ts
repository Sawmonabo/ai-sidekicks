// The provider's callback-tool asks and the daemon's native commands. A goal is set and cleared as
// the person's own act, a turn Codex starts on it as the session's own run; a tool call must reach
// the host attributed to the run that made it, or be refused before anything runs; compaction
// settles only on the provider's typed evidence; the command list is a live read that never goes
// stale; a side question's copy runs under the daemon's read-only profile, credential denies kept.

import { describe, expect, it } from "vitest";

import { SideQuestionIdSchema } from "@ai-sidekicks/contracts/session/controls/methods";
import { type SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import { bindCallbackToolsForSpawn, CallbackToolHost } from "../../../callback-tool-host.js";
import { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { CallbackToolInvocation } from "../../contract.js";
import { createCallbackToolAskResponder } from "../callback-tool-ask-responder.js";
import {
  createHarness,
  createdSession,
  deliveriesOf,
  type Harness,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  SECOND_TURN_ID,
  SESSION_CWD,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  threadReply,
  turnCompletedFrame,
} from "../__fixtures__/app-server-doubles.js";
import { CREATE_PARAMS } from "./lifecycle.test-support.js";
import { CodexTransportError } from "../session/errors.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";

const BINDING = { sessionId: SESSION_ID, bindingId: "binding-abc" };

describe("Codex session goals", () => {
  // Codex counts a goal as the person's instruction only when the request says so; without
  // `origin: "user"` its automatic reviewer never reads the goal as authorization. A goal Codex
  // leaves alone makes no run; the turn it starts on one is the session's own run.
  it("sets the goal as the person's own act, and its turn is a run once it starts", async () => {
    const harness = createHarness();
    harness.server.on("thread/goal/set", () => ({ result: {} }));
    harness.server.on("thread/goal/clear", () => ({ result: { cleared: true } }));
    await harness.driver.createSession(CREATE_PARAMS);

    await expect(
      harness.driver.setSessionGoal({ ...BINDING, runId: RUN_ID, goalText: "ship the fix" }),
    ).resolves.toStrictEqual({ status: "applied" });
    await drainMicrotasks();
    expect(harness.daemonTurnRunIds).toStrictEqual([]);

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "turn-goal" } },
    });
    await drainMicrotasks();
    // A turn with no run would have its rows dropped.
    expect(harness.daemonTurnRunIds).toHaveLength(1);
    expect(deliveriesOf(harness, "turn_boundary")).toHaveLength(1);

    await expect(
      harness.driver.clearSessionGoal({ ...BINDING, runId: RUN_ID }),
    ).resolves.toStrictEqual({ status: "applied" });
    expect(harness.server.framesForMethod("thread/goal/set")[0]?.["params"]).toStrictEqual({
      threadId: THREAD_ID,
      origin: "user",
      objective: "ship the fix",
    });
    expect(harness.server.framesForMethod("thread/goal/clear")[0]?.["params"]).toStrictEqual({
      threadId: THREAD_ID,
      origin: "user",
    });
  });
});

// Through the composed path a production spawn uses: a provider `item/tool/call` frame reaches
// `CallbackToolHost` and the host's answer returns as a `DynamicToolCallResponse`.
describe("Codex callback-tool round trip", () => {
  const SEARCH_TOOL: SessionCallbackTool = {
    name: "search_workspace",
    description: "Searches the session's mounted workspace.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  };

  /** A session with the search tool bound, recording what the host adjudicated and ran. */
  async function roundTripHarness(): Promise<{
    askToolCall: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    startTurn: (runId: typeof RUN_ID, turnId: string) => Promise<void>;
    evaluatedToolNames: string[];
    executedInvocations: CallbackToolInvocation[];
  }> {
    const evaluatedToolNames: string[] = [];
    const executedInvocations: CallbackToolInvocation[] = [];
    const host = new CallbackToolHost({
      provider: "codex",
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: () => undefined },
        counterSink: { increment: () => undefined },
      }),
      executor: {
        execute: async (invocation) => {
          executedInvocations.push(invocation);
          return await Promise.resolve({ status: "completed", output: "2 matches" });
        },
      },
      activitySink: { record: () => undefined },
      approvalSeam: {
        evaluate: async (request) => {
          evaluatedToolNames.push(request.toolName);
          return await Promise.resolve({ decision: "allow", basis: "policy" });
        },
      },
    });
    bindCallbackToolsForSpawn(host, {
      sessionId: SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "never read: registration is available",
    });
    const harness = createHarness({
      answerCallbackToolCall: createCallbackToolAskResponder(host),
    });
    await createdSession(harness);
    return {
      askToolCall: async (params) =>
        await harness.server.askProvider("item/tool/call", {
          tool: SEARCH_TOOL.name,
          arguments: { query: "needle" },
          threadId: THREAD_ID,
          ...params,
        }),
      startTurn: async (runId, turnId) => {
        harness.server.on("turn/start", () => ({ result: { turn: { id: turnId } } }));
        await harness.driver.startRun({
          runId,
          agentConfig: runConfig("search the workspace"),
        });
      },
      evaluatedToolNames,
      executedInvocations,
    };
  }

  it("adjudicates, runs and answers a call, attributed to the run its turn names", async () => {
    // With two live runs the sole-active fallback has no answer; the named turn resolves the run.
    const roundTrip = await roundTripHarness();
    await roundTrip.startTurn(RUN_ID, TURN_ID);
    await roundTrip.startTurn(SECOND_RUN_ID, SECOND_TURN_ID);

    const answer = await roundTrip.askToolCall({ callId: "call-1", turnId: SECOND_TURN_ID });
    await roundTrip.askToolCall({ callId: "call-2", turnId: TURN_ID });

    expect(roundTrip.evaluatedToolNames).toStrictEqual([SEARCH_TOOL.name, SEARCH_TOOL.name]);
    expect(
      roundTrip.executedInvocations.map((invocation) => [invocation.toolCallId, invocation.runId]),
    ).toStrictEqual([
      ["call-1", SECOND_RUN_ID],
      ["call-2", RUN_ID],
    ]);
    expect(answer["result"]).toStrictEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "2 matches" }],
    });
  });

  it.each([
    ["names a tool that is not registered", { tool: "delete_everything", turnId: TURN_ID }],
    // A delayed ask guessed onto the sole live run would run against the wrong run's registry and
    // approval seam.
    ["names no turn", {}],
    ["names a turn with no live route", { turnId: "turn-that-already-retired" }],
  ])("refuses a call that %s before approval or execution", async (_label, params) => {
    const roundTrip = await roundTripHarness();
    await roundTrip.startTurn(RUN_ID, TURN_ID);

    const answer = await roundTrip.askToolCall({ callId: "call-3", ...params });

    expect(answer["result"]).toMatchObject({ success: false });
    expect(roundTrip.evaluatedToolNames).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
  });
});

// Compaction settles on the provider's typed evidence, never on the request being accepted, and
// its wait never swallows the boundary record.
describe("Codex native compaction", () => {
  const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000002";

  async function compactionHarness(): Promise<Harness> {
    const harness = createHarness();
    harness.server.on("thread/compact/start", () => ({ result: {} }));
    await harness.driver.createSession(CREATE_PARAMS);
    return harness;
  }

  function emitCompactionBoundary(harness: Harness, threadId = THREAD_ID): void {
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/compacted",
      params: { threadId, turnId: TURN_ID },
    });
  }

  it(
    "compacts the session's own thread and settles applied on the typed frame, not the " +
      "acknowledgement",
    async () => {
      const harness = await compactionHarness();
      let observed: DriverCompactionResult | "still-waiting" = "still-waiting";

      const compaction = harness.driver.compactContext(BINDING);
      void compaction.then((result) => {
        observed = result;
      });
      await drainMicrotasks();

      expect(harness.server.framesForMethod("thread/compact/start")[0]?.["params"]).toStrictEqual({
        threadId: THREAD_ID,
      });
      // The empty acknowledgement has resolved and the operation is still open.
      expect(observed).toBe("still-waiting");

      emitCompactionBoundary(harness);
      await expect(compaction).resolves.toStrictEqual({
        status: "applied",
        boundaryPosition: null,
      });
    },
  );

  it("settles provider_error on a refused trigger", async () => {
    const harness = createHarness();
    harness.server.on("thread/compact/start", () => ({
      error: { code: -32603, message: "compaction unavailable" },
    }));
    await harness.driver.createSession(CREATE_PARAMS);

    await expect(harness.driver.compactContext(BINDING)).resolves.toStrictEqual({
      status: "failed",
      reason: "provider_error",
    });
  });

  it("settles `not_compacted` when its own turn ends with no frame, never on a run's turn", async () => {
    const harness = await compactionHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    let observed: DriverCompactionResult | "still-waiting" = "still-waiting";
    const compaction = harness.driver.compactContext(BINDING);
    void compaction.then((result) => {
      observed = result;
    });
    await drainMicrotasks();

    // Codex replaces the run's turn with the compaction's, whose end alone says it did not compact.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "interrupted"));
    await drainMicrotasks();
    expect(observed).toBe("still-waiting");
    harness.server.emitFrame(turnCompletedFrame("compaction-turn", "failed"));

    await expect(compaction).resolves.toStrictEqual({ status: "failed", reason: "not_compacted" });
  });

  it("never settles the user's wait on a provider-internal child's compaction", async () => {
    // The child is itself a compaction, so only the thread its frame names tells it apart.
    const harness = await compactionHarness();
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: { id: CHILD_THREAD_ID, parentThreadId: THREAD_ID, threadSourceKind: "compaction" },
      },
    });
    let observed: DriverCompactionResult | "still-waiting" = "still-waiting";
    const compaction = harness.driver.compactContext(BINDING);
    void compaction.then((result) => {
      observed = result;
    });
    await drainMicrotasks();

    emitCompactionBoundary(harness, CHILD_THREAD_ID);
    await drainMicrotasks();
    expect(observed).toBe("still-waiting");

    // The wait has no limit of its own; the session's close is what ends it.
    await harness.driver.closeSession({ sessionId: SESSION_ID });
    await expect(compaction).resolves.toStrictEqual({ status: "failed", reason: "binding_lost" });
  });
});

// The command list is a live read held as session state, not a stored registry.
describe("Codex provider command list", () => {
  interface SkillFixture {
    name: string;
    description?: string;
    scope?: string;
    enabled?: boolean;
  }

  async function enumerationHarness(initial: readonly SkillFixture[]): Promise<{
    harness: Harness;
    setSkills: (next: readonly SkillFixture[]) => void;
  }> {
    const harness = createHarness();
    let current = initial;
    harness.server.on("skills/list", () => ({
      result: { data: [{ cwd: SESSION_CWD, skills: [...current], errors: [] }] },
    }));
    await harness.driver.createSession(CREATE_PARAMS);
    return {
      harness,
      setSkills: (next) => {
        current = next;
      },
    };
  }

  async function entryNames(harness: Harness): Promise<string[] | undefined> {
    const result = await harness.driver.listProviderCommands(BINDING);
    return result.bindings[0]?.entries.map((entry) => entry.name);
  }

  it("keeps disabled and blank-description skills rather than dropping real commands", async () => {
    const { harness } = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
      { name: "retired", description: "Not offerable", scope: "user", enabled: false },
      // The provider requires the string and a skill file may leave it blank; the wire refuses
      // blank text, so carrying it through would refuse the whole entry.
      { name: "blank", description: "", scope: "repo", enabled: true },
      { name: "whitespace", description: "   ", scope: "repo", enabled: true },
    ]);

    const result = await harness.driver.listProviderCommands(BINDING);
    const entries = result.bindings[0]?.entries ?? [];

    expect(entries.map((entry) => [entry.name, entry.enabled])).toEqual([
      ["review", true],
      ["retired", false],
      ["blank", true],
      ["whitespace", true],
    ]);
    expect(Object.hasOwn(entries[2] as object, "description")).toBe(false);
    expect(Object.hasOwn(entries[3] as object, "description")).toBe(false);
  });

  it("refuses a reply with no skill list rather than holding it as no commands", async () => {
    const harness = createHarness();
    let reply: unknown = { data: "not a list" };
    harness.server.on("skills/list", () => ({ result: reply }));
    await harness.driver.createSession(CREATE_PARAMS);

    await expect(harness.driver.listProviderCommands(BINDING)).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { method: "skills/list" },
    });

    // Nothing was held, so the next read asks the provider again.
    reply = { data: [{ cwd: SESSION_CWD, skills: [{ name: "review" }], errors: [] }] };
    expect(await entryNames(harness)).toEqual(["review"]);
  });

  it("re-reads fully on skills/changed, never serving one session's list to the next", async () => {
    const { harness, setSkills } = await enumerationHarness([{ name: "alpha" }, { name: "beta" }]);
    expect(await entryNames(harness)).toEqual(["alpha", "beta"]);
    await entryNames(harness);
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);

    // The notification carries no payload, so a patch would leave the deleted `beta` behind.
    setSkills([{ name: "alpha" }, { name: "gamma" }]);
    harness.server.emitFrame({ jsonrpc: "2.0", method: "skills/changed", params: {} });
    await drainMicrotasks();
    expect(await entryNames(harness)).toEqual(["alpha", "gamma"]);

    await harness.driver.closeSession({ sessionId: SESSION_ID });
    await harness.driver.createSession(CREATE_PARAMS);
    await entryNames(harness);
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(3);
  });
});

describe("Codex side questions", () => {
  // A fork keeps none of the thread's inline profiles, and Codex's own `:read-only` reads the
  // credential paths the daemon's profiles deny.
  it("asks on a copy under the daemon's read-only profile, and lets a copy that is not go", async () => {
    const harness = createHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await createdSession(harness);
    const ask = () =>
      harness.driver.askSideQuestion({
        sessionId: SESSION_ID,
        sideQuestionId: SideQuestionIdSchema.parse("6d1f6a3e-2b0c-4c47-9d1e-0f3b7c2a9e51"),
        question: "what does this module do?",
      });
    const configOf = (params: Record<string, unknown> | undefined) =>
      params?.["config"] as Record<string, unknown> | undefined;

    await ask();
    const [fork] = harness.server.paramsFor("thread/fork");
    const [start] = harness.server.paramsFor("thread/start");
    expect(fork).toMatchObject({
      ephemeral: true,
      excludeTurns: true,
      permissions: expect.stringMatching(/^sidekicks-readonly-/),
      approvalPolicy: "never",
    });
    // The copy defines the same profiles, denies included, and reaches no tool server.
    expect(configOf(fork)?.["permissions"]).toStrictEqual(configOf(start)?.["permissions"]);
    expect(configOf(fork)?.["mcp_servers"]).toStrictEqual({});

    harness.server.on("thread/fork", () =>
      threadReply("thread-copy", { permissions: ":read-only" }),
    );
    await expect(ask()).rejects.toBeInstanceOf(CodexTransportError);
    expect(harness.server.paramsFor("thread/unsubscribe")).toContainEqual({
      threadId: "thread-copy",
    });
  });
});
