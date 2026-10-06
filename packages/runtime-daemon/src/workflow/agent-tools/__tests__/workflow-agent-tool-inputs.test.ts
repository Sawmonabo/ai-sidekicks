// The callback host checks a tool call against the JSON Schema the provider received, and the tool
// checks it against its input schema; these cases hold that the two agree for `workflow_run` and
// that no tool input lets an agent name another session or a repository.
import { describe, expect, it } from "vitest";

import {
  WorkflowDefinitionCreateRequestSchema,
  WorkflowDefinitionListRequestSchema,
} from "@ai-sidekicks/contracts/workflow/definition/methods";
import {
  WORKFLOW_RUN_TOOL,
  WorkflowRunToolInputSchema,
} from "@ai-sidekicks/contracts/workflow/run-tool";

import { describeArgumentRefusal } from "../../../provider/callback-tool-host.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("workflow_run", () => {
  it("is refused by the host without a definition name and admitted with one", () => {
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, {})).toContain("definitionName");
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, { definitionName: "Nightly suite" })).toBe(
      null,
    );
  });
});

const CREATE_INPUT = {
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

describe("a session or a repository is never an input", () => {
  it("admits the run, list and create inputs alone and refuses a session id or a project id", () => {
    const run = { definitionName: "Nightly suite" };
    expect(WorkflowRunToolInputSchema.safeParse(run).success).toBe(true);
    expect(WorkflowDefinitionListRequestSchema.safeParse({}).success).toBe(true);
    expect(WorkflowDefinitionCreateRequestSchema.safeParse(CREATE_INPUT).success).toBe(true);

    for (const extra of [{ sessionId: SESSION_ID }, { projectId: PROJECT_ID }]) {
      expect(WorkflowRunToolInputSchema.safeParse({ ...run, ...extra }).success).toBe(false);
      expect(WorkflowDefinitionListRequestSchema.safeParse(extra).success).toBe(false);
      expect(
        WorkflowDefinitionCreateRequestSchema.safeParse({ ...CREATE_INPUT, ...extra }).success,
      ).toBe(false);
    }
  });
});
