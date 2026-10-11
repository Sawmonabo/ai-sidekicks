// The workflow document is written by the builder, by an agent through its tools and by an
// imported file. These cases hold what its readers rely on: a failure disposition from the closed
// three, node ids that each name one node and a named refusal when not, a schema small enough to
// send to a model, a content hash blind to layout, pinned data and tags, trigger inputs with
// distinct names that start on a value their type allows, a tool binding that carries no policy,
// and a step's failure whose details never travel without its code, nor an agent refusal without
// its reason and the definition it names, `null` for the General agent.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  pickWorkflowDocumentHashedBody,
  WorkflowDocumentSchema,
  WorkflowDraftDocumentSchema,
  WorkflowPinnedItemSchema,
  WorkflowStepErrorSchema,
  WorkflowToolBindingSchema,
  type WorkflowDocument,
  type WorkflowStepError,
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
  tags: ["nightly", "team/ci"],
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

  // Edges, expressions and step records address a node by id, so one id must name one node. The
  // refusal's issue carries the named finding a refused call's error hands the builder.
  it("refuses a node id used twice, the trigger's included, with its named finding", () => {
    const { trigger: _trigger, ...draft } = FULL_DOCUMENT;
    const cases = [
      { schema: WorkflowDocumentSchema, document: FULL_DOCUMENT, repeat: "suite", index: 4 },
      { schema: WorkflowDocumentSchema, document: FULL_DOCUMENT, repeat: "schedule", index: 4 },
      {
        schema: WorkflowDraftDocumentSchema,
        document: FULL_DOCUMENT,
        repeat: "schedule",
        index: 4,
      },
      { schema: WorkflowDraftDocumentSchema, document: draft, repeat: "suite", index: 4 },
    ];
    for (const { schema, document, repeat, index } of cases) {
      const nodes = [...document.nodes, { ...SUITE, id: repeat }];
      const parsed = schema.safeParse({ ...document, nodes });
      expect(parsed.success, repeat).toBe(false);
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({
          path: ["nodes", index, "id"],
          message: expect.stringContaining(repeat),
          params: { rule: "node_id_duplicate", nodeIds: [repeat] },
        }),
      ]);
    }
    expect(WorkflowDraftDocumentSchema.safeParse(draft).success).toBe(true);
  });

  // The agent tools send these schemas to a model, whose context holds a schema's whole text once
  // loaded: each must convert, and stay under 100 KB.
  it("converts to a JSON Schema small enough to send to a model", () => {
    for (const schema of [WorkflowDocumentSchema, WorkflowDraftDocumentSchema]) {
      expect(JSON.stringify(z.toJSONSchema(schema)).length).toBeLessThan(100_000);
    }
  });
});

// The content hash reads only the hashed body, so moving nodes, pinning data or tagging a
// workflow must leave that body unchanged, while an edit the engine reads must change it.
describe("pickWorkflowDocumentHashedBody", () => {
  const document = WorkflowDocumentSchema.parse(FULL_DOCUMENT);

  it("ignores geometry, pinned data and tags", () => {
    const moved: WorkflowDocument = {
      ...document,
      layout: {
        nodes: { schedule: { x: 900, y: -40 }, suite: { x: 12, y: 700 } },
        viewport: { x: 300, y: 80, zoom: 0.5 },
        notes: [{ id: "n1", text: "Moved", x: 50, y: 50, width: 320, height: 40 }],
      },
      pinData: { suite: [{ json: { summary: "changed" } }], branch: [{ json: 1 }] },
      tags: ["other"],
    };
    expect(pickWorkflowDocumentHashedBody(moved)).toStrictEqual(
      pickWorkflowDocumentHashedBody(document),
    );
    expect(Object.keys(pickWorkflowDocumentHashedBody(document)).sort()).toStrictEqual([
      "edges",
      "name",
      "nodes",
      "trigger",
    ]);
  });

  it("changes with a node's params and with the trigger's inputs", () => {
    const body = pickWorkflowDocumentHashedBody(document);
    const [suite, ...rest] = document.nodes;
    if (suite === undefined) {
      throw new Error("the fixture holds the suite node");
    }
    const retuned = {
      ...document,
      nodes: [{ ...suite, params: { command: "pnpm lint" } }, ...rest],
    };
    expect(pickWorkflowDocumentHashedBody(retuned)).not.toStrictEqual(body);
    const withInput = {
      ...document,
      trigger: {
        ...document.trigger,
        inputs: [{ name: "dryRun", type: "boolean" as const, default: true }],
      },
    };
    expect(pickWorkflowDocumentHashedBody(withInput)).not.toStrictEqual(body);
  });
});

// Run now draws one field per declared input and seeds it from the input's starting value, so the
// value must fit the input's type, and only the trigger may declare inputs.
describe("trigger inputs", () => {
  const withInputs = (inputs: unknown[]) =>
    WorkflowDocumentSchema.safeParse({ ...FULL_DOCUMENT, trigger: { ...TRIGGER, inputs } });

  it("accepts each input type starting on a value of that type", () => {
    expect(
      withInputs([
        { name: "dryRun", type: "boolean", default: false },
        { name: "branch", type: "string", required: true, default: "" },
        { name: "folder", type: "path", default: "/repo/docs" },
        { name: "tone", type: "select", options: ["short", "long"], default: "long" },
      ]).success,
    ).toBe(true);
  });

  it("refuses a starting value its type does not allow, or one missing", () => {
    expect(withInputs([{ name: "dryRun", type: "boolean", default: "yes" }]).success).toBe(false);
    expect(withInputs([{ name: "branch", type: "string" }]).success).toBe(false);
    expect(
      withInputs([{ name: "tone", type: "select", options: ["short"], default: "long" }]).success,
    ).toBe(false);
    expect(withInputs([{ name: "count", type: "number", default: 3 }]).success).toBe(false);
    expect(withInputs([{ name: "tone", type: "select", options: [], default: "" }]).success).toBe(
      false,
    );
  });

  // A start fills inputs by name, so two inputs with one name could not both be filled.
  it("refuses two inputs with one name, naming it", () => {
    const parsed = withInputs([
      { name: "dryRun", type: "boolean", default: false },
      { name: "dryRun", type: "string", default: "" },
    ]);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["trigger", "inputs", 1, "name"],
        message: expect.stringContaining("dryRun"),
      }),
    ]);
  });

  it("refuses inputs on a node that is not the trigger", () => {
    const suiteWithInputs = {
      ...SUITE,
      inputs: [{ name: "dryRun", type: "boolean", default: false }],
    };
    expect(
      WorkflowDocumentSchema.safeParse({ ...FULL_DOCUMENT, nodes: [suiteWithInputs] }).success,
    ).toBe(false);
  });
});

// A node whose items carry a binary value cannot be pinned.
describe("WorkflowPinnedItemSchema", () => {
  it("refuses a binary value", () => {
    const binary = {
      file: { artifactId: "a1", mimeType: "image/png", fileName: "shot.png", size: 10 },
    };
    expect(WorkflowPinnedItemSchema.safeParse({ json: {} }).success).toBe(true);
    expect(WorkflowPinnedItemSchema.safeParse({ json: {}, binary }).success).toBe(false);
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

  it("refuses details with no code, in the type and in the schema", () => {
    // @ts-expect-error -- an uncoded failure carries no details.
    const uncoded: WorkflowStepError = { message: "failed", details: { cause: "step_timeout" } };
    expect(WorkflowStepErrorSchema.safeParse(uncoded).success).toBe(false);
    expect(WorkflowStepErrorSchema.safeParse({ message: "failed" }).success).toBe(true);
  });

  it("fails a step whose agent could not resolve with that refusal, its reason and its definition, none for the General agent", () => {
    const parkRefused = {
      message: "The account this step waited on was removed",
      code: "agent.resolution_refused",
      details: {
        definitionId: "0b9f6c2e-4d1a-4c3b-9e8f-7a6b5c4d3e2f",
        reason: "account_unavailable",
        providerAccountId: "acct_work",
      },
    };
    expect(WorkflowStepErrorSchema.safeParse(parkRefused).success).toBe(true);
    // A step running the General agent runs no definition, and its refusal says so.
    const generalStepRefused = {
      ...parkRefused,
      details: { ...parkRefused.details, definitionId: null },
    };
    expect(WorkflowStepErrorSchema.safeParse(generalStepRefused).success).toBe(true);
    const { definitionId: _definitionId, ...definitionless } = parkRefused.details;
    expect(
      WorkflowStepErrorSchema.safeParse({ ...parkRefused, details: definitionless }).success,
    ).toBe(false);
    const { details: _details, ...reasonless } = parkRefused;
    expect(WorkflowStepErrorSchema.safeParse(reasonless).success).toBe(false);
    expect(
      WorkflowStepErrorSchema.safeParse({ ...parkRefused, details: { reason: "out_of_luck" } })
        .success,
    ).toBe(false);
  });

  it("carries the failing item's index from 0, and no negative one", () => {
    const itemFailure = { message: "The summary came back empty", itemIndex: 0 };
    expect(WorkflowStepErrorSchema.safeParse(itemFailure).success).toBe(true);
    expect(WorkflowStepErrorSchema.safeParse({ ...itemFailure, itemIndex: -1 }).success).toBe(
      false,
    );
  });
});
