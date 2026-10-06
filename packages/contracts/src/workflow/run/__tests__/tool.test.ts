// The `workflow_run` tool an agent calls from a session: it names a workflow and, from a chat, a
// project by name, so an agent cannot start a run in another session or by a raw id.
import { describe, expect, it } from "vitest";

import { WorkflowRunToolInputSchema } from "../tool.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("WorkflowRunToolInputSchema", () => {
  it("admits a definition name, alone or with a project name, and refuses any id", () => {
    const run = { definitionName: "Nightly suite" };
    expect(WorkflowRunToolInputSchema.safeParse(run).success).toBe(true);
    expect(WorkflowRunToolInputSchema.safeParse({ ...run, project: "Notes app" }).success).toBe(
      true,
    );
    const refusals = [{ sessionId: SESSION_ID }, { projectId: PROJECT_ID }, { project: "" }];
    for (const refused of refusals) {
      expect(WorkflowRunToolInputSchema.safeParse({ ...run, ...refused }).success).toBe(false);
    }
  });
});
