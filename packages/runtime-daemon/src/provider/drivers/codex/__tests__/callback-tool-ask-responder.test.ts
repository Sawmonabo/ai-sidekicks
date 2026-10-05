// The Codex ask responder: a routed `item/tool/call` becomes an adjudicated callback-tool
// invocation answered with content items, an approval ask with no responder is refused by name,
// and the content items always match the provider's declared union.

import { describe, expect, it } from "vitest";

import {
  bindSpawn,
  buildCallbackToolHostHarness,
  SEARCH_TOOL,
  TEST_RUN_ID,
  TEST_SESSION_ID,
  type CallbackToolHostHarness,
} from "../../../__tests__/callback-tool-host.test-support.js";
import {
  composeCallbackToolContentItems,
  createCallbackToolAskResponder,
} from "../callback-tool-ask-responder.js";
import type { CodexSessionServerRequest } from "../server-requests.js";

/** The wire method name of a dynamic tool-call ask. */
const TOOL_CALL_METHOD = "item/tool/call";

function buildAskResponder(harness: CallbackToolHostHarness) {
  return createCallbackToolAskResponder({ host: harness.host, approvalAskResponder: null });
}

function makeToolCallAsk(
  overrides?: Partial<CodexSessionServerRequest>,
): CodexSessionServerRequest {
  return {
    method: TOOL_CALL_METHOD,
    askKind: "callback-tool",
    params: {
      tool: SEARCH_TOOL.name,
      callId: "call-1",
      arguments: { query: "needle" },
      threadId: "thread-1",
      turnId: "turn-1",
    },
    sessionId: TEST_SESSION_ID,
    runId: TEST_RUN_ID,
    ...overrides,
  };
}

describe("createCallbackToolAskResponder — the callback-tool arm", () => {
  it("turns a routed ask into an adjudicated invocation, answered with content items", async () => {
    const harness = buildCallbackToolHostHarness();
    bindSpawn(harness);

    const decision = await buildAskResponder(harness).answer(makeToolCallAsk());

    expect(decision).toStrictEqual({
      decision: "allow",
      payload: { contentItems: [{ type: "inputText", text: '{"hits":0}' }] },
    });
    // `tool` is the registry name and `callId` is copied verbatim for tool pairing.
    expect(harness.executedInvocations[0]?.toolName).toBe(SEARCH_TOOL.name);
    expect(harness.executedInvocations[0]?.toolCallId).toBe("call-1");
  });

  it("refuses and RECORDS a legal non-object `arguments` payload from the provider", async () => {
    const harness = buildCallbackToolHostHarness();
    bindSpawn(harness);

    // The provider's schema allows any JSON value for `arguments`, so this shape can arrive.
    const decision = await buildAskResponder(harness).answer(
      makeToolCallAsk({
        params: { tool: SEARCH_TOOL.name, callId: "call-2", arguments: "needle" },
      }),
    );

    expect(decision.decision).toBe("refuse");
    const refusals = harness.emittedDiagnostics.filter(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(refusals[0]?.details["toolCallId"]).toBe("call-2");
    expect(harness.evaluatedRequests).toHaveLength(0);
  });

  it("relays the host's own refusal reason rather than inventing one", async () => {
    const harness = buildCallbackToolHostHarness({
      outcome: { decision: "deny", basis: "policy", reason: "workspace search is not permitted" },
    });
    bindSpawn(harness);

    const decision = await buildAskResponder(harness).answer(makeToolCallAsk());

    expect(decision).toStrictEqual({
      decision: "refuse",
      reason: "workspace search is not permitted",
    });
  });
});

describe("createCallbackToolAskResponder — the approval arm", () => {
  it("refuses an approval ask with no responder bound, naming the method", async () => {
    const harness = buildCallbackToolHostHarness();

    const decision = await buildAskResponder(harness).answer({
      method: "item/fileChange/requestApproval",
      askKind: "approval",
      params: {},
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    });

    expect(decision.decision).toBe("refuse");
    expect(decision.decision === "refuse" && decision.reason).toContain(
      "item/fileChange/requestApproval",
    );
    // Not a callback-tool diagnostic: those kinds name this host's conditions.
    expect(harness.emittedDiagnostics).toHaveLength(0);
  });
});

describe("composeCallbackToolContentItems — the silent-loss guard", () => {
  it("renders an un-serializable output as a visible item rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const contentItems = composeCallbackToolContentItems(cyclic);

    expect(contentItems).toHaveLength(1);
    expect((contentItems[0] as { text: string }).text).toContain("could not render");
  });
});

describe("composeCallbackToolContentItems — per-arm required members", () => {
  // `DynamicToolCallOutputContentItem` is a closed union whose arms each carry one required
  // member beside the discriminator. A check on the discriminator alone would ship
  // `{ type: "inputImage" }` as a success the model reads as an empty answer.
  it("passes each arm through when its required member is present", () => {
    const composed = [
      { type: "inputText", text: "found 2 matches" },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png" },
      { type: "inputAudio", audioUrl: "https://example.invalid/a.wav" },
    ];

    expect(composeCallbackToolContentItems(composed)).toStrictEqual(composed);
  });

  it.each([
    ["inputText missing `text`", [{ type: "inputText" }]],
    ["inputText with a non-string `text`", [{ type: "inputText", text: 7 }]],
    ["inputImage with an EMPTY `imageUrl`", [{ type: "inputImage", imageUrl: "" }]],
    ["an unknown discriminator", [{ type: "inputVideo", videoUrl: "https://example.invalid/a" }]],
    [
      "one malformed item beside two well-formed ones",
      [
        { type: "inputText", text: "alpha" },
        { type: "inputImage" },
        { type: "inputText", text: "beta" },
      ],
    ],
  ])("renders %s as text rather than shipping it as a malformed success", (_label, output) => {
    const contentItems = composeCallbackToolContentItems(output);

    // Fall back for the whole value, never per item: dropping items would silently lose content.
    expect(contentItems).toHaveLength(1);
    expect(contentItems[0]).toMatchObject({ type: "inputText" });
    expect((contentItems[0] as { text: string }).text).toContain("type");
  });

  it("REBUILDS an admitted item, dropping siblings the provider's union does not declare", () => {
    // A well-formed item may carry executor-supplied siblings, and the provider frame is
    // serialized after this function returns. A sibling the union does not declare (a `BigInt`,
    // say) must not reach the provider frame, where JSON serialization would throw and leave the
    // ask unanswered.
    const contentItems = composeCallbackToolContentItems([
      { type: "inputText", text: "found 2 matches", metadata: 1n },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png", cache: { hit: true } },
    ]);

    expect(contentItems).toStrictEqual([
      { type: "inputText", text: "found 2 matches" },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png" },
    ]);
    expect(() => JSON.stringify(contentItems)).not.toThrow();
  });
});

describe(
  "createCallbackToolAskResponder — untrusted " +
    "identifiers are bounded before they are recorded",
  () => {
    it("truncates an oversized tool name and marks the truncation explicitly", async () => {
      const harness = buildCallbackToolHostHarness();
      bindSpawn(harness);
      const oversizedToolName = "z".repeat(4096);

      const decision = await buildAskResponder(harness).answer(
        makeToolCallAsk({ params: { tool: oversizedToolName, callId: "call-1", arguments: {} } }),
      );

      expect(decision.decision).toBe("refuse");
      const refusal = harness.emittedDiagnostics.find(
        (record) => record.kind === "callback_tool_invocation_refused",
      );
      // 128 is `DRIVER_TOOL_NAME_MAX_LEN`, so an unbounded identifier cannot reach the record
      // buffer or the log sink.
      expect(refusal?.details["toolName"]).toBe("z".repeat(128));
      expect(refusal?.details["toolNameTruncated"]).toBe(true);
      // The original length is kept beside the truncation.
      expect(refusal?.details["toolNameOriginalLength"]).toBe(4096);
    });
  },
);
