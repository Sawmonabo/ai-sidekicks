// The callback host checks a tool call against the JSON Schema the provider received, and the tool
// checks it against its input schema; these cases hold that the two agree for `workflow_run`, that
// no tool input lets an agent name another session, and that only `workflow_run` names a project.
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
    const run = { definitionName: "Nightly suite" };
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, {})).toContain("definitionName");
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, run)).toBe(null);
    expect(describeArgumentRefusal(WORKFLOW_RUN_TOOL, { ...run, project: "Notes app" })).toBe(null);
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

describe("a session is never an input, and only a run names a project", () => {
  it("admits the run, list and create inputs alone, a run's project by name, and no id", () => {
    const run = { definitionName: "Nightly suite" };
    expect(WorkflowRunToolInputSchema.safeParse(run).success).toBe(true);
    expect(WorkflowRunToolInputSchema.safeParse({ ...run, project: "Notes app" }).success).toBe(
      true,
    );
    const refusals = [{ sessionId: SESSION_ID }, { projectId: PROJECT_ID }, { project: "" }];
    for (const refused of refusals) {
      expect(WorkflowRunToolInputSchema.safeParse({ ...run, ...refused }).success).toBe(false);
    }
    expect(WorkflowDefinitionListRequestSchema.safeParse({}).success).toBe(true);
    expect(WorkflowDefinitionCreateRequestSchema.safeParse(CREATE_INPUT).success).toBe(true);

    for (const extra of [{ sessionId: SESSION_ID }, { projectId: PROJECT_ID }]) {
      expect(WorkflowDefinitionListRequestSchema.safeParse(extra).success).toBe(false);
      expect(
        WorkflowDefinitionCreateRequestSchema.safeParse({ ...CREATE_INPUT, ...extra }).success,
      ).toBe(false);
    }
  });
});
