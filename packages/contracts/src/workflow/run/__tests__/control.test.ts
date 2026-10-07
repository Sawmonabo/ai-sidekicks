// The acts on a run come from the screen, the command line and an agent's tools. These tests
// hold the rules those acts rely on: the cancel reason's cap counts bytes, not characters, a re-pin
// names both versions or neither, a resumed run says where it picks up, a start's session and
// project are the daemon's to refuse together, a retry is a new run, and a refusal about nodes
// names at least one, and a start fills the workflow's declared inputs or names those it lacks.
import { describe, expect, it } from "vitest";

import type { WorkflowTriggerInput } from "../../definition/document.js";
import {
  fillWorkflowTriggerInputs,
  WorkflowInputRequiredDetailsSchema,
  WorkflowRepositoryRequiredDetailsSchema,
  WorkflowResumedPayloadSchema,
  WorkflowRunCancelRequestSchema,
  WorkflowRunResumeResponseSchema,
  WorkflowRunRetryResponseSchema,
  WorkflowRunStartRequestSchema,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
} from "../control.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("workflow.runCancel reason cap", () => {
  it("accepts a reason whose JSON encoding is exactly the cap in bytes", () => {
    const reason = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP - 2);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(true);
  });

  it("refuses a multibyte reason over the cap in bytes though under it in characters", () => {
    const reason = "é".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP / 2 + 1);
    expect(reason.length).toBeLessThan(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(false);
  });
});

describe("a resume's re-pin", () => {
  const RUN_EVENT = {
    sessionId: SESSION_ID,
    workflowRunId: RUN_ID,
    definitionId: "wfd-1",
    workflowVersionId: "wfv-4",
  };
  const resumptionPoint = {
    activeSteps: [{ nodeId: "tests", attempt: 2, executionIndex: 5 }],
    pendingGates: ["approve"],
  };
  const repin = { repinnedFromWorkflowVersionId: "wfv-4", repinnedToWorkflowVersionId: "wfv-5" };

  it("names both versions or neither, on the reply and on the resumed event", () => {
    const reply = { workflowRunId: RUN_ID, status: "running" };
    const resumed = { ...RUN_EVENT, resumptionPoint };
    for (const [schema, base] of [
      [WorkflowRunResumeResponseSchema, reply],
      [WorkflowResumedPayloadSchema, resumed],
    ] as const) {
      expect(schema.safeParse(base).success).toBe(true);
      expect(schema.safeParse({ ...base, ...repin }).success).toBe(true);
      const { repinnedToWorkflowVersionId: _to, ...onlyFrom } = repin;
      expect(schema.safeParse({ ...base, ...onlyFrom }).success).toBe(false);
      const { repinnedFromWorkflowVersionId: _from, ...onlyTo } = repin;
      expect(schema.safeParse({ ...base, ...onlyTo }).success).toBe(false);
    }
  });

  it("refuses a resumed event that does not say where the run picks up", () => {
    expect(WorkflowResumedPayloadSchema.safeParse({ ...RUN_EVENT, ...repin }).success).toBe(false);
  });
});

describe("workflow.runStart", () => {
  it("accepts a session and a project together, which the daemon refuses on a project session", () => {
    const start = { workflowVersionId: "wfv-5", sessionId: SESSION_ID, projectId: PROJECT_ID };
    expect(WorkflowRunStartRequestSchema.safeParse(start).success).toBe(true);
  });
});

describe("workflow.runRetry", () => {
  it("refuses a retry that answers with its own source run", () => {
    const reply = { workflowRunId: RUN_ID, sourceWorkflowRunId: RUN_ID, status: "new" };
    expect(WorkflowRunRetryResponseSchema.safeParse(reply).success).toBe(false);
  });
});

describe("workflow.repository_required", () => {
  it("names at least one node that needs a repository", () => {
    expect(WorkflowRepositoryRequiredDetailsSchema.safeParse({ nodeIds: ["git"] }).success).toBe(
      true,
    );
    expect(WorkflowRepositoryRequiredDetailsSchema.safeParse({ nodeIds: [] }).success).toBe(false);
  });
});

describe("workflow.runStart inputs", () => {
  const DECLARED: WorkflowTriggerInput[] = [
    { name: "branch", type: "string", required: true, default: "" },
    { name: "dryRun", type: "boolean", default: true },
  ];
  const startOn = (json: unknown) => [{ json }];

  it("names a required input the start left out, and any input given the wrong type", () => {
    expect(fillWorkflowTriggerInputs(DECLARED, startOn({ dryRun: false }))).toEqual({
      kind: "missing",
      details: { inputNames: ["branch"] },
    });
    expect(fillWorkflowTriggerInputs(DECLARED, startOn({ branch: 7 }))).toEqual({
      kind: "missing",
      details: { inputNames: ["branch"] },
    });
    expect(fillWorkflowTriggerInputs(DECLARED, startOn({ branch: "main", dryRun: "yes" }))).toEqual(
      { kind: "missing", details: { inputNames: ["dryRun"] } },
    );
    expect(WorkflowInputRequiredDetailsSchema.safeParse({ inputNames: [] }).success).toBe(false);
  });

  it("gives an optional input left out its default", () => {
    expect(fillWorkflowTriggerInputs(DECLARED, startOn({ branch: "main" }))).toEqual({
      kind: "filled",
      values: { branch: "main", dryRun: true },
    });
  });

  it("takes every input the start filled", () => {
    expect(fillWorkflowTriggerInputs(DECLARED, startOn({ branch: "main", dryRun: false }))).toEqual(
      { kind: "filled", values: { branch: "main", dryRun: false } },
    );
  });

  it("starts a workflow that declares no inputs on an empty start", () => {
    expect(fillWorkflowTriggerInputs(undefined, undefined)).toEqual({ kind: "filled", values: {} });
  });
});
