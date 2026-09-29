// Run admission and the child tree are what the bridge, a workflow and the Sidekicks
// badge rely on. These cases hold that a run names exactly one target, that no run is
// its own parent, and that the badge's figures never exceed the total.
import { describe, expect, it } from "vitest";

import {
  ChildRunLinkReadResponseSchema,
  OrchestrationRunCreateRequestSchema,
} from "../orchestration.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const LEAD_AGENT_ID = "77777777-7777-4777-8777-777777777777";
const PARENT_RUN_ID = "66666666-6666-4666-8666-666666666666";
const CHILD_RUN_ID = "88888888-8888-4888-8888-888888888888";

const HEAD = {
  modelId: "gpt-5.5",
  effort: "medium",
  tokens: 1200,
  spendUsdMicros: 4300,
  startedAt: "2026-09-29T10:00:00Z",
  ancestry: [{ kind: "agent", agentId: LEAD_AGENT_ID }],
} as const;

const RUN_LINK = {
  kind: "run",
  childRunId: CHILD_RUN_ID,
  parentRunId: PARENT_RUN_ID,
  agentId: AGENT_ID,
  internalHelper: false,
  state: "running",
  head: { ...HEAD, viaAgentName: "reviewer" },
} as const;

const TREE = {
  children: [
    RUN_LINK,
    {
      kind: "providerChild",
      runId: PARENT_RUN_ID,
      childHandle: "child-1",
      state: "waiting_for_approval",
      head: HEAD,
    },
  ],
  counts: { live: 2, total: 2, waiting: 1 },
  rejectedCreates: [
    {
      parentRunId: PARENT_RUN_ID,
      targetDefinitionId: DEFINITION_ID,
      reason: "agent.resolution_refused",
      occurredAt: "2026-09-29T10:01:00Z",
    },
  ],
} as const;

describe("orchestration.runCreate", () => {
  it("accepts a live agent or a saved definition as the target", () => {
    expect(
      OrchestrationRunCreateRequestSchema.safeParse({
        sessionId: SESSION_ID,
        targetAgentId: AGENT_ID,
        parentRunId: PARENT_RUN_ID,
      }).success,
    ).toBe(true);
    expect(
      OrchestrationRunCreateRequestSchema.safeParse({
        sessionId: SESSION_ID,
        targetDefinitionId: DEFINITION_ID,
        internalHelper: true,
      }).success,
    ).toBe(true);
  });

  it("refuses both targets, and no target", () => {
    expect(
      OrchestrationRunCreateRequestSchema.safeParse({
        sessionId: SESSION_ID,
        targetAgentId: AGENT_ID,
        targetDefinitionId: DEFINITION_ID,
      }).success,
    ).toBe(false);
    expect(OrchestrationRunCreateRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      false,
    );
  });

  it("refuses a node to run on", () => {
    const request = {
      sessionId: SESSION_ID,
      targetAgentId: AGENT_ID,
      targetNodeId: "node-1",
    };
    expect(OrchestrationRunCreateRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("orchestration.childRunLinkRead", () => {
  it("accepts a tree with a run, a provider's helper and a refused create", () => {
    expect(ChildRunLinkReadResponseSchema.safeParse(TREE).success).toBe(true);
  });

  it("refuses a run linked as its own parent", () => {
    const tree = { ...TREE, children: [{ ...RUN_LINK, parentRunId: CHILD_RUN_ID }] };
    expect(ChildRunLinkReadResponseSchema.safeParse(tree).success).toBe(false);
  });

  it("refuses badge figures above the total", () => {
    expect(
      ChildRunLinkReadResponseSchema.safeParse({
        ...TREE,
        counts: { live: 3, total: 2, waiting: 0 },
      }).success,
    ).toBe(false);
    expect(
      ChildRunLinkReadResponseSchema.safeParse({
        ...TREE,
        counts: { live: 0, total: 2, waiting: 3 },
      }).success,
    ).toBe(false);
  });

  it("refuses a mechanism word on a child", () => {
    const tree = { ...TREE, children: [{ ...RUN_LINK, reachedBy: "peer_call" }] };
    expect(ChildRunLinkReadResponseSchema.safeParse(tree).success).toBe(false);
  });
});
