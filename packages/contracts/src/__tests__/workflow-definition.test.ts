// The workflow document is written by the builder, by an agent through its tools and by
// an imported file, and read by the daemon's check at save, the run engine and every
// view of a version. These cases hold the rules each of them relies on: one schema
// version, a trigger on every saved document but not on a draft, pinned data with no
// binary value, a tool binding that carries no policy, and the refusal findings.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  WorkflowDefinitionRefusedDetailsSchema,
  WorkflowDocumentSchema,
  WorkflowDraftDocumentSchema,
  WorkflowToolBindingSchema,
} from "../workflow-definition.js";

const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

const TRIGGER = {
  id: "schedule",
  kind: "trigger.schedule",
  kindVersion: 1,
  name: "Every morning",
  order: 0,
  params: { cron: "0 8 * * *", timeZone: "America/New_York" },
};
const SUITE = {
  id: "suite",
  kind: "developer.run-tests",
  kindVersion: 1,
  name: "Run the suite",
  order: 0,
  params: { command: "pnpm test" },
  onError: "continue-error-output",
  retry: { maxTries: 2, waitMs: 1000 },
};

// A full document: the schedule, the suite, the branch, the summary write and the stop,
// with its layout and one pinned item.
const DESIGN_DOCUMENT = {
  schemaVersion: "2",
  name: "Nightly suite",
  trigger: TRIGGER,
  nodes: [
    SUITE,
    { id: "branch", kind: "flow.if", kindVersion: 1, name: "Passed?", order: 0, params: {} },
    {
      id: "summary",
      kind: "output.write-summary",
      kindVersion: 1,
      name: "Write summary",
      order: 0,
      params: { text: "={{ $json.summary }}" },
    },
    { id: "stop", kind: "flow.stop-error", kindVersion: 1, name: "Stop", order: 1, params: {} },
  ],
  edges: [
    {
      id: "e1",
      source: "schedule",
      sourceHandle: "outputs/main/0",
      target: "suite",
      targetHandle: "inputs/main/0",
    },
  ],
  layout: {
    nodes: { schedule: { x: 0, y: 0 }, suite: { x: 240, y: 0 } },
    viewport: { x: 0, y: 0, zoom: 1 },
    notes: [{ id: "n1", text: "Runs at 8", x: 0, y: 120, width: 200, height: 80 }],
  },
  pinData: { suite: [{ json: { summary: "12 passed" }, pairedItem: { item: 0 } }] },
};

describe("WorkflowDocumentSchema", () => {
  it("accepts the design's document with layout and pinned data", () => {
    expect(WorkflowDocumentSchema.safeParse(DESIGN_DOCUMENT).success).toBe(true);
  });

  it("refuses a schema version other than 2", () => {
    expect(
      WorkflowDocumentSchema.safeParse({ ...DESIGN_DOCUMENT, schemaVersion: "1" }).success,
    ).toBe(false);
  });

  it("refuses a saved document with no trigger, and keeps a draft that has none yet", () => {
    const { trigger: _trigger, ...withoutTrigger } = DESIGN_DOCUMENT;
    expect(WorkflowDocumentSchema.safeParse(withoutTrigger).success).toBe(false);
    expect(WorkflowDraftDocumentSchema.safeParse(withoutTrigger).success).toBe(true);
  });

  it("refuses pinned data whose item carries a binary value", () => {
    const pinnedBinary = {
      ...DESIGN_DOCUMENT,
      pinData: {
        suite: [
          {
            json: {},
            binary: {
              patch: {
                artifactId: ARTIFACT_ID,
                mimeType: "text/x-patch",
                fileName: "a.patch",
                size: 1,
              },
            },
          },
        ],
      },
    };
    expect(WorkflowDocumentSchema.safeParse(pinnedBinary).success).toBe(false);
  });

  it("refuses a document-wide settings block", () => {
    expect(
      WorkflowDocumentSchema.safeParse({ ...DESIGN_DOCUMENT, settings: { timeoutMs: 1 } }).success,
    ).toBe(false);
  });

  it("refuses an error disposition outside the three", () => {
    const badNode = { ...SUITE, onError: "continueOnFail" };
    expect(WorkflowDocumentSchema.safeParse({ ...DESIGN_DOCUMENT, nodes: [badNode] }).success).toBe(
      false,
    );
  });

  // The agent tools send this schema to a model: it must convert, and stay far under the
  // size a model's context can hold.
  it("converts to a JSON Schema small enough to send to a model", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(WorkflowDocumentSchema));
    expect(jsonSchema.length).toBeLessThan(100_000);
  });
});

describe("WorkflowToolBindingSchema", () => {
  const BINDING = {
    binding: { provider: "claude", scope: "project", scopeRef: "/repo", serverName: "github" },
    toolName: "search_issues",
  };

  it("accepts a reference to a server's tool", () => {
    expect(WorkflowToolBindingSchema.safeParse(BINDING).success).toBe(true);
  });

  it("refuses a policy on the binding or inside its server reference", () => {
    expect(WorkflowToolBindingSchema.safeParse({ ...BINDING, approvalMode: "never" }).success).toBe(
      false,
    );
    expect(
      WorkflowToolBindingSchema.safeParse({ ...BINDING, idempotencyClass: "idempotent" }).success,
    ).toBe(false);
    expect(
      WorkflowToolBindingSchema.safeParse({
        ...BINDING,
        binding: { ...BINDING.binding, enabled: true },
      }).success,
    ).toBe(false);
  });
});

describe("WorkflowDefinitionRefusedDetailsSchema", () => {
  it("accepts the whole list, with the package error on the lock finding", () => {
    expect(
      WorkflowDefinitionRefusedDetailsSchema.safeParse({
        findings: [
          { rule: "cycle", nodeIds: ["suite", "branch"] },
          { rule: "empty_document", nodeIds: [] },
          {
            rule: "code_packages_unresolved",
            nodeIds: ["code"],
            detail: "error: package lodash-es@99 not found",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses a lock finding without its detail, and a detail on any other rule", () => {
    expect(
      WorkflowDefinitionRefusedDetailsSchema.safeParse({
        findings: [{ rule: "code_packages_unresolved", nodeIds: ["code"] }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowDefinitionRefusedDetailsSchema.safeParse({
        findings: [{ rule: "orphan", nodeIds: ["stop"], detail: "unreachable" }],
      }).success,
    ).toBe(false);
  });

  it("refuses a rule outside the closed list and an empty list", () => {
    expect(
      WorkflowDefinitionRefusedDetailsSchema.safeParse({
        findings: [{ rule: "invalid_phase", nodeIds: [] }],
      }).success,
    ).toBe(false);
    expect(WorkflowDefinitionRefusedDetailsSchema.safeParse({ findings: [] }).success).toBe(false);
  });
});
