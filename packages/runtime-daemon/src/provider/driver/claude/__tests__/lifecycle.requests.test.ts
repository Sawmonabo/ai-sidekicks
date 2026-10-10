// `lifecycle.ts` requests: at Reviewed the daemon itself allows only a removal Claude Code's own
// rule sent while it reviews in auto mode, and every other ask, a safety check's included, goes to
// the person, and one Claude Code withdraws is withdrawn from the person; a choice is answered
// once, and a late or second answer finds nothing pending; a refusal names the rows it retracts by
// their event ids, and a message that cancels it starts the session's next turn as its own run;
// a rewound session keeps its helper limit, holding a start past it until the turn ends; a plan
// asking to leave plan mode is recorded from the ask's own text while the ask stays held.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { describe, expect, it, vi } from "vitest";

import type { ProviderPermissionAsk } from "../../../port/permission-ask.js";
import { ClaudeDriver } from "../index.js";
import {
  buildCreateSessionParams,
  buildSteerParams,
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_MODEL,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  daemonTurnRunId,
  rewindTestSession,
  spawnedChannel,
  startLiveRun,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

const REVIEWED_POSTURE: ExecutionPosture = {
  mode: "reviewed",
  credentialPolicyRef: "policy://default",
  writableRoots: ["/workspace"],
};

const REMOVAL = { command: "rm -rf build" };

// Claude Code's refusal choice on the test run, naming `retractedMessageUuids` as streamed already.
function emitRefusal(channel: FakeClaudeProviderProcess, retractedMessageUuids: string[]): void {
  channel.emitInboundRequest({
    kind: "request",
    request: {
      requestId: "dialog-refusal",
      subtype: "request_user_dialog",
      request: {
        subtype: "request_user_dialog",
        dialog_kind: "refusal_fallback_prompt",
        payload: {
          originalModel: "claude-fable-5",
          fallbackModel: "claude-opus-4-1",
          retractedMessageUuids,
        },
      },
    },
  });
}

// A Reviewed session running the test run, its process reporting the auto mode Reviewed runs in,
// with an approval service that records each ask it takes and each one withdrawn.
async function startReviewedRun(harness: LifecycleHarness): Promise<{
  channel: FakeClaudeProviderProcess;
  asks: ProviderPermissionAsk[];
  withdrawals: { sessionId: string; requestId: string }[];
}> {
  const asks: ProviderPermissionAsk[] = [];
  const withdrawals: { sessionId: string; requestId: string }[] = [];
  harness.permissionAsks.register({
    takeAsk: async (ask) => {
      await Promise.resolve();
      asks.push(ask);
    },
    withdrawAsk: async (withdrawal) => {
      await Promise.resolve();
      withdrawals.push(withdrawal);
    },
  });
  harness.transport.initializeAutoModeModels = new Set([TEST_MODEL]);
  const channel = await createLiveSession(harness, { executionPosture: REVIEWED_POSTURE });
  armRunDispatch(harness);
  await harness.lifecycle.startRun(buildStartRunParams());
  channel.emitStreamFrame("system/init", undefined, {
    type: "system",
    subtype: "init",
    permissionMode: "auto",
  });
  return { channel, asks, withdrawals };
}

function emitBashAsk(
  channel: FakeClaudeProviderProcess,
  requestId: string,
  decisionReasonType: string,
): void {
  channel.emitInboundRequest({
    kind: "request",
    request: {
      requestId,
      subtype: "can_use_tool",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: REMOVAL,
        tool_use_id: `toolu_${requestId}`,
        decision_reason_type: decisionReasonType,
        title: "Claude wants to run rm -rf build",
      },
    },
  });
}

describe("ClaudeSessionLifecycle requests at Reviewed", () => {
  it("allows a removal Claude Code's own rule sent, with no card", async () => {
    const harness = buildHarness();
    const { channel, asks } = await startReviewedRun(harness);

    emitBashAsk(channel, "ask-rule", "rule");

    await vi.waitFor(() => {
      expect(channel.answeredRequests).toStrictEqual([
        { requestId: "ask-rule", response: { behavior: "allow", updatedInput: REMOVAL } },
      ]);
    });
    expect(harness.deliveries.filter((delivery) => delivery.kind === "permission_ask")).toEqual([]);
    expect(asks).toStrictEqual([]);
  });

  it("hands a safety check's ask to the person, never answers it, and withdraws it", async () => {
    const harness = buildHarness();
    const { channel, asks, withdrawals } = await startReviewedRun(harness);

    emitBashAsk(channel, "ask-safety", "safetyCheck");

    await vi.waitFor(() => {
      expect(asks).toStrictEqual([
        {
          sessionId: TEST_SESSION_ID,
          runId: TEST_RUN_ID,
          requestId: "ask-safety",
          toolName: "Bash",
          input: REMOVAL,
          prompt: "Claude wants to run rm -rf build",
        },
      ]);
    });
    expect(channel.answeredRequests).toStrictEqual([]);

    channel.emitInboundRequest({ kind: "cancel", requestId: "ask-safety" });

    await vi.waitFor(() => {
      expect(withdrawals).toStrictEqual([{ sessionId: TEST_SESSION_ID, requestId: "ask-safety" }]);
    });
  });
});

describe("ClaudeSessionLifecycle choices", () => {
  it("answers the usage-credits choice once and refuses a late second answer", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.emitInboundRequest({
      kind: "request",
      request: {
        requestId: "dialog-credits",
        subtype: "request_user_dialog",
        request: {
          subtype: "request_user_dialog",
          dialog_kind: "fable_overage_consent_prompt",
          payload: { overagesEnabled: true, modelName: "claude-fable-5" },
        },
      },
    });
    const answer = {
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
      answer: { dialog: "usage_credits", choice: "consent" },
    } as const;

    const [first, second] = await Promise.all([
      harness.lifecycle.answerProviderChoice(answer),
      harness.lifecycle.answerProviderChoice(answer),
    ]);

    expect([first, second]).toStrictEqual([{ status: "answered" }, { status: "not_pending" }]);
    expect(channel.answeredRequests).toStrictEqual([
      { requestId: "dialog-credits", response: { behavior: "completed", result: "consent" } },
    ]);
    await expect(
      harness.lifecycle.answerProviderChoice({
        ...answer,
        answer: { dialog: "refusal", choice: "retry_fallback" },
      }),
    ).resolves.toStrictEqual({ status: "not_pending" });
  });

  it("names the rows a refusal retracts by the ids of their written events", async () => {
    const harness = buildHarness();
    harness.answerDelivery = async (delivery) => {
      await Promise.resolve();
      return delivery.kind === "session_row"
        ? { disposition: "appended", eventId: `event-${String(delivery.content?.body)}` }
        : { disposition: "published" };
    };
    const channel = await startLiveRun(harness);
    channel.emitStreamFrame("system/status");
    for (const [uuid, text] of [
      ["wire-1", "first"],
      ["wire-2", "second"],
      ["wire-3", "kept"],
    ] as const) {
      channel.emitStreamFrame("assistant", undefined, {
        type: "assistant",
        uuid,
        message: { id: `msg_${uuid}`, content: [{ type: "text", text }] },
      });
    }

    emitRefusal(channel, ["wire-1", "wire-2", "wire-never-streamed"]);

    await vi.waitFor(() => {
      const requested = harness.deliveries.flatMap((delivery) =>
        delivery.kind === "unstamped_row" && delivery.row.type === "run.refusal_choice_requested"
          ? [delivery.row.payload]
          : [],
      );
      expect(requested).toMatchObject([{ retractedMessageIds: ["event-first", "event-second"] }]);
    });
  });

  it("sends a steer that cancels a refusal as the next turn, its own run", async () => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readBuild: () => Promise.reject(new Error("no build is read here")),
    });
    // A turn the daemon starts runs at the session's level, so the session holds one, on a model
    // with the auto mode Reviewed runs in.
    harness.transport.initializeAutoModeModels = new Set([TEST_MODEL]);
    await driver.createSession({
      ...buildCreateSessionParams(),
      executionPosture: REVIEWED_POSTURE,
    });
    const channel = spawnedChannel(harness);
    armRunDispatch(harness);
    await driver.startRun(buildStartRunParams());
    channel.emitStreamFrame("system/status");
    emitRefusal(channel, []);
    const steer = buildSteerParams("try it this way");

    const steered = driver.applyIntervention(steer);
    await vi.waitFor(() => {
      expect(channel.answeredRequests).toStrictEqual([
        { requestId: "dialog-refusal", response: { behavior: "cancelled" } },
      ]);
    });
    // Nothing is written into the refused turn before it ends.
    expect(channel.sentTexts).toStrictEqual(["review the diff"]);
    channel.emitStreamFrame("result/error_during_execution", undefined, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });

    await expect(steered).resolves.toStrictEqual({
      status: "applied",
      deliveredRunId: daemonTurnRunId(1),
    });
    expect(harness.daemonTurnRuns).toStrictEqual([
      { runId: daemonTurnRunId(1), sessionId: TEST_SESSION_ID },
    ]);
    expect(channel.sentUserFrames.at(-1)).toStrictEqual({
      type: "user",
      uuid: steer.clientIdempotencyKey,
      message: { role: "user", content: "try it this way" },
    });
  });
});

// Claude Code's pre-tool callback on its helper tool, for the helper call `toolUseId`.
function emitHelperStart(channel: FakeClaudeProviderProcess, toolUseId: string): void {
  channel.emitInboundRequest({
    kind: "request",
    request: {
      requestId: `helper-${toolUseId}`,
      subtype: "hook_callback",
      request: {
        subtype: "hook_callback",
        callback_id: "sidekicks-helper-limit",
        tool_use_id: toolUseId,
        input: {},
      },
    },
  });
}

describe("ClaudeSessionLifecycle helper limit", () => {
  it("holds a helper past the limit on a rewound process and lets it go when the turn ends", async () => {
    const harness = buildHarness();
    await createLiveSession(harness, {
      subagentPolicy: { enabled: true, helpersAtOnce: 1, definitions: [] },
    });
    await rewindTestSession(harness);
    const forked = spawnedChannel(harness, -1);

    emitHelperStart(forked, "tool-a");
    emitHelperStart(forked, "tool-b");

    await vi.waitFor(() => {
      expect(forked.answeredRequests).toStrictEqual([{ requestId: "helper-tool-a", response: {} }]);
    });
    forked.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    await vi.waitFor(() => {
      expect(forked.answeredRequests.map((answer) => answer.requestId)).toStrictEqual([
        "helper-tool-a",
        "helper-tool-b",
      ]);
    });
  });
});

describe("ClaudeSessionLifecycle plan exit", () => {
  it("records the plan from the held plan-exit ask, which still waits for its answer", async () => {
    const harness = buildHarness();
    const asks: ProviderPermissionAsk[] = [];
    harness.permissionAsks.register({
      takeAsk: async (ask) => {
        await Promise.resolve();
        asks.push(ask);
      },
      withdrawAsk: async () => {
        await Promise.resolve();
      },
    });
    const channel = await startLiveRun(harness);
    const plan = "# Add the flag\n\n1. Read it in `src/cli.ts`\n2. Test `src/cli.test.ts`\n";

    channel.emitInboundRequest({
      kind: "request",
      request: {
        requestId: "plan-exit",
        subtype: "can_use_tool",
        request: {
          subtype: "can_use_tool",
          tool_name: "ExitPlanMode",
          input: { plan, planFilePath: "/config/plans/add-the-flag.md" },
          tool_use_id: "toolu_plan",
        },
      },
    });

    await vi.waitFor(() => {
      expect(asks.map((ask) => ask.toolName)).toStrictEqual(["ExitPlanMode"]);
    });
    const records = harness.deliveries.flatMap((delivery) =>
      delivery.kind === "unstamped_row" && delivery.row.type === "plan.proposed"
        ? [delivery.row.payload]
        : [],
    );
    expect(records).toMatchObject([
      {
        runId: TEST_RUN_ID,
        title: "Add the flag",
        text: plan,
        stepCount: 2,
        fileCount: 2,
        planFilePath: "/config/plans/add-the-flag.md",
      },
    ]);
    expect(channel.answeredRequests).toStrictEqual([]);
  });
});
