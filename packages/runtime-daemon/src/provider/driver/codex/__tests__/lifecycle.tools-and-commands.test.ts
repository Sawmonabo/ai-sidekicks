// The provider's callback-tool asks and the daemon's native commands. A tool call must reach the
// host attributed to the run that made it, or be refused before anything runs; compaction settles
// only on the provider's typed evidence; the command list is a live read that never goes stale.

import { describe, expect, it } from "vitest";

import { type SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import { DRIVER_PROVIDER_COMMAND_ENTRIES_MAX } from "@ai-sidekicks/contracts/provider/driver/length-limits";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import { bindCallbackToolsForSpawn, CallbackToolHost } from "../../../callback-tool-host.js";
import { COMPACTION_WAIT_MS } from "../../../compaction-wait.js";
import { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { CallbackToolInvocation } from "../../contract.js";
import { createCallbackToolAskResponder } from "../callback-tool-ask-responder.js";
import { CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL } from "../server-requests.js";
import {
  type ManagerHarness,
  RUN_ID,
  SECOND_RUN_ID,
  SECOND_TURN_ID,
  SESSION_CWD,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  createManagerHarness,
  routedAskHarness,
} from "../__fixtures__/app-server-doubles.js";
import { CREATE_PARAMS } from "./lifecycle.test-support.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";

const BINDING = { sessionId: SESSION_ID, bindingId: "binding-abc" };

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
      providerRegistrationUnavailableDetail: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
    });
    const { harness, askProvider } = await routedAskHarness(
      createCallbackToolAskResponder({ host, approvalAskResponder: null }),
    );
    return {
      askToolCall: (params) =>
        askProvider("item/tool/call", {
          tool: SEARCH_TOOL.name,
          arguments: { query: "needle" },
          threadId: THREAD_ID,
          ...params,
        }),
      startTurn: async (runId, turnId) => {
        harness.server.on("turn/start", () => ({ result: { turn: { id: turnId } } }));
        await harness.driver.startRun({
          runId,
          agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
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
// its bounded wait never swallows the boundary record.
describe("Codex native compaction", () => {
  const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000002";

  async function compactionHarness(): Promise<ManagerHarness> {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({ result: {} }));
    await harness.manager.createSession(CREATE_PARAMS);
    return harness;
  }

  function emitCompactionBoundary(harness: ManagerHarness, threadId = THREAD_ID): void {
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

      const compaction = harness.manager.compactContext(BINDING);
      void compaction.then((result) => {
        observed = result;
      });
      await drainMicrotasks();

      expect(harness.server.framesForMethod("thread/compact/start")[0]?.["params"]).toStrictEqual({
        threadId: THREAD_ID,
      });
      // The empty acknowledgement has resolved and the operation is still open, waiting at its
      // bound.
      expect(observed).toBe("still-waiting");
      expect(harness.scheduler.pendingDelays()).toContain(COMPACTION_WAIT_MS);

      emitCompactionBoundary(harness);
      await expect(compaction).resolves.toStrictEqual({
        status: "applied",
        boundaryPosition: null,
      });
    },
  );

  it(
    "settles wait_expired at its bound, and a late " +
      "boundary frame still reaches the transcript",
    async () => {
      const harness = await compactionHarness();
      const compaction = harness.manager.compactContext(BINDING);
      await drainMicrotasks();

      // Only the compaction bound: firing the transport deadline too would fail for the wrong
      // reason.
      expect(harness.scheduler.fireDelay(COMPACTION_WAIT_MS)).toBe(1);
      await expect(compaction).resolves.toStrictEqual({ status: "failed", reason: "wait_expired" });

      const before = harness.notifications.length;
      emitCompactionBoundary(harness);
      await drainMicrotasks();
      expect(harness.notifications.slice(before).map((entry) => entry.method)).toEqual([
        "thread/compacted",
      ]);
    },
  );

  it("settles provider_error on a refused trigger and withdraws its wait", async () => {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({
      error: { code: -32603, message: "compaction unavailable" },
    }));
    await harness.manager.createSession(CREATE_PARAMS);

    await expect(harness.manager.compactContext(BINDING)).resolves.toStrictEqual({
      status: "failed",
      reason: "provider_error",
    });
    // A leftover wait would outlive its caller and could settle the operation a second time.
    expect(harness.scheduler.pendingDelays()).not.toContain(COMPACTION_WAIT_MS);
    expect(harness.scheduler.fireDelay(COMPACTION_WAIT_MS)).toBe(0);
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
    const compaction = harness.manager.compactContext(BINDING);
    await drainMicrotasks();

    emitCompactionBoundary(harness, CHILD_THREAD_ID);
    await drainMicrotasks();

    expect(harness.notifications).toStrictEqual([]);
    expect(harness.scheduler.fireDelay(COMPACTION_WAIT_MS)).toBe(1);
    await expect(compaction).resolves.toStrictEqual({ status: "failed", reason: "wait_expired" });
  });

  it("settles binding_lost the moment the session closes, with no timer firing", async () => {
    const harness = await compactionHarness();
    const compaction = harness.manager.compactContext(BINDING);
    await drainMicrotasks();

    await harness.manager.closeSession({ sessionId: SESSION_ID });

    await expect(compaction).resolves.toStrictEqual({ status: "failed", reason: "binding_lost" });
    expect(harness.scheduler.firedDelays()).not.toContain(COMPACTION_WAIT_MS);
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
    harness: ManagerHarness;
    setSkills: (next: readonly SkillFixture[]) => void;
  }> {
    const harness = createManagerHarness({ onServerNotification: true });
    let current = initial;
    harness.server.on("skills/list", () => ({
      result: { data: [{ cwd: SESSION_CWD, skills: [...current], errors: [] }] },
    }));
    await harness.manager.createSession(CREATE_PARAMS);
    return {
      harness,
      setSkills: (next) => {
        current = next;
      },
    };
  }

  async function entryNames(harness: ManagerHarness): Promise<string[] | undefined> {
    const result = await harness.manager.listProviderCommands(BINDING);
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

    const result = await harness.manager.listProviderCommands(BINDING);
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
    const harness = createManagerHarness({ onServerNotification: true });
    let reply: unknown = { data: "not a list" };
    harness.server.on("skills/list", () => ({ result: reply }));
    await harness.manager.createSession(CREATE_PARAMS);

    await expect(harness.manager.listProviderCommands(BINDING)).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { method: "skills/list" },
    });

    // Nothing was held, so the next read asks the provider again.
    reply = { data: [{ cwd: SESSION_CWD, skills: [{ name: "review" }], errors: [] }] };
    expect(await entryNames(harness)).toEqual(["review"]);
  });

  it("caps the reply at the wire bound and marks it incomplete", async () => {
    const { harness } = await enumerationHarness(
      Array.from({ length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 3 }, (_unused, index) => ({
        name: `skill-${index}`,
      })),
    );

    const result = await harness.manager.listProviderCommands(BINDING);

    expect(result.bindings[0]?.complete).toBe(false);
    expect(result.bindings[0]?.entries).toHaveLength(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
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

    await harness.manager.closeSession({ sessionId: SESSION_ID });
    await harness.manager.createSession(CREATE_PARAMS);
    await entryNames(harness);
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(3);
  });
});
