// Each provider's asks through the real approval intake and permission check, on each driver over
// its fake provider: at Reviewed a removal Claude Code's level rule sent is allowed by the
// pipeline, which marks the working folder stale, while one its own check flagged raises the card,
// and the same rule's ask at Ask raises the card too; Codex's approval raises the card, and its ask
// for a background Claude Code command is refused by the daemon's designed answer. An ask the
// check could not decide is refused at the provider on both drivers, and the driver records the
// failure, so no call hangs on a check that failed.

import { describe, expect, it, vi } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { PermissionAsks } from "../../../approvals/permission-asks.js";
import type { ApprovalRequestCreateRequest } from "../../../approvals/request-create.js";
import { PermissionCheckService } from "../../../policy/permission-check.js";
import { drainMicrotasks } from "../../__fixtures__/drain-microtasks.js";
import type { RespondToRequestParams } from "../contract.js";
import {
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_MODEL,
} from "../claude/__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  type LifecycleHarness,
} from "../claude/__tests__/lifecycle.test-support.js";
import {
  createdSession,
  createHarness,
  RUN_ID,
  runConfig,
  THREAD_ID,
  TURN_ID,
} from "../codex/__fixtures__/app-server-doubles.js";

const CHECK_FAILED_REFUSAL = "This call could not be checked, so it did not run.";

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return { mode, credentialPolicyRef: "policy://default", writableRoots: ["/workspace"] };
}

// The approval intake over a real permission check whose cards are recorded rather than stored,
// answering through `respondToRequest`; a card's raising throws while `failCards` is set.
function buildPipeline(respondToRequest: (params: RespondToRequestParams) => Promise<void>): {
  asks: PermissionAsks;
  cards: ApprovalRequestCreateRequest[];
  staleSessions: SessionId[];
  failCards: () => void;
} {
  const cards: ApprovalRequestCreateRequest[] = [];
  const staleSessions: SessionId[] = [];
  let cardFailure: Error | undefined;
  const permissionCheck = new PermissionCheckService({
    authorizer: {
      decide: () => {
        throw new Error("a provider ask takes no rule evaluation");
      },
    },
    approvals: {
      create: (card) => {
        if (cardFailure !== undefined) {
          return Promise.reject(cardFailure);
        }
        cards.push(card);
        return Promise.resolve({ approvalRequestId: `card-${String(cards.length)}` as never });
      },
      takeCorrection: () => Promise.resolve(false),
    },
    rules: { findRule: () => undefined },
    agentMemoryFolder: "/data/agent-memory",
    readRunAgent: () => "agent-1",
    readOwner: () => undefined,
    readPosture: () => undefined,
  });
  const asks = new PermissionAsks({
    approvals: {
      resolve: () => Promise.reject(new Error("no card is answered here")),
      withdraw: () => Promise.resolve(),
      readRequest: () => undefined,
      readAskRequest: () => undefined,
      markWorkingFolderStale: (sessionId) => {
        staleSessions.push(sessionId);
        return Promise.resolve();
      },
    },
    permissionCheck,
    rules: {
      record: () => Promise.reject(new Error("no rule is made here")),
      readProjectFolders: () => [],
    },
    respondToRequest,
  });
  return {
    asks,
    cards,
    staleSessions,
    failCards: () => {
      cardFailure = new Error("the log is full");
    },
  };
}

// A Claude Code session at `level` running the test run, its process reporting the mode that
// level runs in, with its asks taken by the pipeline.
async function startClaudeRun(
  harness: LifecycleHarness,
  level: "ask" | "reviewed",
): Promise<{ channel: FakeClaudeProviderProcess; pipeline: ReturnType<typeof buildPipeline> }> {
  const pipeline = buildPipeline((params) => harness.lifecycle.respondToRequest(params));
  harness.permissionAsks.register(pipeline.asks);
  harness.transport.initializeAutoModeModels = new Set([TEST_MODEL]);
  const channel = await createLiveSession(harness, { executionPosture: postureAt(level) });
  armRunDispatch(harness);
  await harness.lifecycle.startRun(buildStartRunParams());
  channel.emitStreamFrame("system/init", undefined, {
    type: "system",
    subtype: "init",
    permissionMode: level === "reviewed" ? "auto" : "acceptEdits",
  });
  return { channel, pipeline };
}

function emitClaudeRemoval(
  channel: FakeClaudeProviderProcess,
  requestId: string,
  decisionReasonType: "rule" | "safetyCheck",
): void {
  channel.emitInboundRequest({
    kind: "request",
    request: {
      requestId,
      subtype: "can_use_tool",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -f build.log" },
        tool_use_id: `toolu_${requestId}`,
        decision_reason_type: decisionReasonType,
      },
    },
  });
}

describe("Claude Code asks through the approval pipeline", () => {
  it("allows at Reviewed a removal its rule sent, and cards one its check flagged", async () => {
    const harness = buildHarness();
    const { channel, pipeline } = await startClaudeRun(harness, "reviewed");

    emitClaudeRemoval(channel, "ask-rule", "rule");
    emitClaudeRemoval(channel, "ask-safety", "safetyCheck");

    await vi.waitFor(() => {
      expect(pipeline.cards).toHaveLength(1);
      expect(channel.answeredRequests).toHaveLength(1);
    });
    expect(channel.answeredRequests).toMatchObject([
      { requestId: "ask-rule", response: { behavior: "allow" } },
    ]);
    expect(pipeline.cards).toMatchObject([{ scope: "rm -f build.log" }]);
    // The pipeline's allow marked the working folder stale, as an approved card does.
    expect(pipeline.staleSessions).toHaveLength(1);
  });

  it("brings the same rule's removal to the card at Ask, which adds no such rule", async () => {
    const harness = buildHarness();
    const { channel, pipeline } = await startClaudeRun(harness, "ask");

    emitClaudeRemoval(channel, "ask-rule", "rule");

    await vi.waitFor(() => {
      expect(pipeline.cards).toHaveLength(1);
    });
    expect(channel.answeredRequests).toEqual([]);
    expect(pipeline.staleSessions).toEqual([]);
  });

  it("refuses an ask the check could not decide, and records the failure", async () => {
    const harness = buildHarness();
    const { channel, pipeline } = await startClaudeRun(harness, "ask");
    pipeline.failCards();

    emitClaudeRemoval(channel, "ask-failed", "rule");

    await vi.waitFor(() => {
      expect(channel.answeredRequests).toStrictEqual([
        {
          requestId: "ask-failed",
          response: { behavior: "deny", message: CHECK_FAILED_REFUSAL },
        },
      ]);
    });
    await vi.waitFor(() => {
      expect(harness.diagnostics.recentRecordsOfKind("delivery_dispatch_failed")).toHaveLength(1);
    });
  });
});

// A Codex session running the test run, with its asks taken by the pipeline.
async function startCodexRun(): Promise<{
  harness: ReturnType<typeof createHarness>;
  pipeline: ReturnType<typeof buildPipeline>;
  askCommand: (itemId: string, command: string) => void;
  answerOf: (itemId: string) => unknown;
}> {
  const harness = createHarness();
  await createdSession(harness);
  harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
  harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
  const pipeline = buildPipeline((params) => harness.driver.respondToRequest(params));
  // The request id Codex sent each ask under, by its item, read as the pipeline takes it.
  const requestIdByItem = new Map<string, string>();
  harness.ports.permissionAsks.register({
    takeAsk: async (ask) => {
      requestIdByItem.set(ask.toolCallId ?? "", ask.requestId);
      await pipeline.asks.takeAsk(ask);
    },
    withdrawAsk: async (withdrawal) => {
      await pipeline.asks.withdrawAsk(withdrawal);
    },
  });
  await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("tidy up") });
  return {
    harness,
    pipeline,
    // Held, the ask outlasts the fake's wait for its answer, which arrives in the written frames.
    askCommand: (itemId, command) => {
      harness.server
        .askProvider("item/commandExecution/requestApproval", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId,
          command,
        })
        .catch(() => undefined);
    },
    answerOf: (itemId) =>
      harness.server
        .writtenFrames()
        .find(
          (frame) =>
            requestIdByItem.has(itemId) &&
            String(frame["id"]) === requestIdByItem.get(itemId) &&
            "result" in frame,
        )?.["result"],
  };
}

describe("Codex asks through the approval pipeline", () => {
  it("cards a command, and declines a background Claude Code command", async () => {
    const { pipeline, askCommand, answerOf } = await startCodexRun();

    askCommand("item-1", "/bin/zsh -lc 'npm test'");
    askCommand("item-2", "/bin/zsh -lc 'claude --bg fix the build'");

    await vi.waitFor(() => {
      expect(pipeline.cards).toMatchObject([{ scope: "npm test" }]);
      expect(answerOf("item-2")).toStrictEqual({ decision: "decline" });
    });
    expect(answerOf("item-1")).toBeUndefined();
  });

  it("refuses an ask the check could not decide, and records the failure", async () => {
    const { harness, pipeline, askCommand, answerOf } = await startCodexRun();
    pipeline.failCards();

    askCommand("item-1", "/bin/zsh -lc 'npm test'");
    await drainMicrotasks();

    await vi.waitFor(() => {
      expect(answerOf("item-1")).toStrictEqual({ decision: "decline" });
      expect(
        harness.diagnostics.filter((diagnostic) => diagnostic.kind === "port-delivery-failed"),
      ).toHaveLength(1);
    });
  });
});
