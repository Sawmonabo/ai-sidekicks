// The workflow document is written by the builder, by an agent through its tools and by an
// imported file. These cases hold what its readers rely on: a failure disposition from the closed
// three, a schema small enough to send to a model, a tool binding that carries no policy, and a
// step's failure whose details never travel without its code.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  WorkflowDocumentSchema,
  WorkflowStepErrorSchema,
  WorkflowToolBindingSchema,
} from "../document.js";

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
  name: "Run tests",
  order: 0,
  params: { command: "pnpm test" },
  onError: "continue-error-output",
  retry: { maxTries: 2, waitMs: 1000 },
};

// A full document: the schedule, the suite, the branch, the summary write and the stop, with its
// layout and one pinned item.
const FULL_DOCUMENT = {
  schemaVersion: "2",
  name: "Test workflow",
  trigger: TRIGGER,
  nodes: [
    SUITE,
    { id: "branch", kind: "flow.if", kindVersion: 1, name: "Check result", order: 0, params: {} },
    {
      id: "summary",
      kind: "output.write-summary",
      kindVersion: 1,
      name: "Save the notes",
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
  pinData: { suite: [{ json: { summary: "ok" }, pairedItem: { item: 0 } }] },
};

describe("WorkflowDocumentSchema", () => {
  it("accepts a document with layout and pinned data", () => {
    expect(WorkflowDocumentSchema.safeParse(FULL_DOCUMENT).success).toBe(true);
  });

  it("refuses an error disposition outside the three", () => {
    const badNode = { ...SUITE, onError: "continueOnFail" };
    expect(WorkflowDocumentSchema.safeParse({ ...FULL_DOCUMENT, nodes: [badNode] }).success).toBe(
      false,
    );
  });

  // The agent tools send this schema to a model, whose context holds its whole text once loaded:
  // it must convert, and stay under 100 KB.
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

  // A tool's policy lives in the MCP server settings, so a facet on the binding fails the parse
  // rather than being ignored at launch.
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

describe("WorkflowStepErrorSchema", () => {
  it("accepts a coded failure with its details", () => {
    const timedOut = {
      message: "The approval step timed out",
      code: "workflow.step_timed_out",
      details: { cause: "step_timeout", limitMs: 3_600_000 },
    };
    expect(WorkflowStepErrorSchema.safeParse(timedOut).success).toBe(true);
  });

  it("refuses details with no code", () => {
    const uncoded = { message: "failed", details: { cause: "step_timeout" } };
    expect(WorkflowStepErrorSchema.safeParse(uncoded).success).toBe(false);
  });

  it("carries the failing item's index from 0, and no negative one", () => {
    const itemFailure = { message: "The summary came back empty", itemIndex: 0 };
    expect(WorkflowStepErrorSchema.safeParse(itemFailure).success).toBe(true);
    expect(WorkflowStepErrorSchema.safeParse({ ...itemFailure, itemIndex: -1 }).success).toBe(
      false,
    );
  });
});
