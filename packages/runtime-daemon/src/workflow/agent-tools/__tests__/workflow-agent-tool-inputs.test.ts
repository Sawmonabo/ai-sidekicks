// The callback host checks a tool call against the JSON Schema the provider received, and the tool
// checks it against its input schema; these cases hold that the two agree for `workflow_run` and
// that no tool input lets an agent name another session.
import { describe, expect, it } from "vitest";

import { describeArgumentRefusal } from "../../../provider/callback-tool-host.js";
import {
  WORKFLOW_RUN_TOOL,
  WorkflowCreateToolInputSchema,
  WorkflowListToolInputSchema,
  WorkflowRunToolInputSchema,
} from "../workflow-agent-tool-inputs.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("workflow_run", () => {
  it("is refused by the host without a definition name and admitted with one", () => {
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, { scope: "project" })).toContain(
      "definitionName",
    );
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, { definitionName: "Nightly suite" })).toBe(
      null,
    );
  });

  it("tells the provider the members it takes and closes the rest", () => {
    expect(WORKFLOW_RUN_TOOL.inputSchema).toMatchObject({
      type: "object",
      properties: {
        definitionName: { type: "string" },
        scope: { enum: ["session", "project", "shared"] },
      },
      required: ["definitionName"],
      additionalProperties: false,
    });
  });

  it("refuses a scope outside the three", () => {
    expect(
      WorkflowRunToolInputSchema.safeParse({ definitionName: "Nightly suite", scope: "team" })
        .success,
    ).toBe(false);
  });
});

const CREATE_INPUT = {
  scope: "session",
  document: {
    schemaVersion: "2",
    name: "Nightly suite",
    trigger: {
      id: "manual",
      kind: "trigger.manual",
      kindVersion: 1,
      name: "Start",
      order: 0,
      params: {},
    },
    nodes: [],
    edges: [],
  },
};

describe("a session is never an input", () => {
  it("admits the inputs without a session id", () => {
    expect(WorkflowRunToolInputSchema.safeParse({ definitionName: "Nightly suite" }).success).toBe(
      true,
    );
    expect(WorkflowListToolInputSchema.safeParse({}).success).toBe(true);
    expect(WorkflowCreateToolInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
  });

  it("refuses a session id on the run, list and create inputs", () => {
    expect(
      WorkflowRunToolInputSchema.safeParse({
        definitionName: "Nightly suite",
        sessionId: SESSION_ID,
      }).success,
    ).toBe(false);
    expect(WorkflowListToolInputSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
    expect(
      WorkflowCreateToolInputSchema.safeParse({ ...CREATE_INPUT, sessionId: SESSION_ID }).success,
    ).toBe(false);
  });
});
