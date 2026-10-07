// The builder keeps its unsaved draft in the daemon and saves its tags beside the definition.
// These cases hold what the daemon relies on: a draft is based on a version only of a named
// workflow, and a tag reaches the daemon's own space check rather than being refused at parse.
import { describe, expect, it } from "vitest";

import { WorkflowDraftUpdateRequestSchema, WorkflowTagsSetRequestSchema } from "../builder.js";

const DRAFT_DOCUMENT = { schemaVersion: "2", name: "Test workflow", nodes: [], edges: [] };

describe("workflow.draftUpdate", () => {
  it("bases a draft on a version only of a named definition", () => {
    const draft = { document: DRAFT_DOCUMENT, basedOnVersionNumber: 7 };
    expect(WorkflowDraftUpdateRequestSchema.safeParse(draft).success).toBe(false);
    expect(
      WorkflowDraftUpdateRequestSchema.safeParse({ ...draft, definitionId: "def-1" }).success,
    ).toBe(true);
  });
});

describe("workflow.tagsSet", () => {
  it("refuses a tag holding a NUL byte and passes one holding a space to the daemon", () => {
    const write = (tag: string) => ({ definitionId: "def-1", tags: ["team/infra", tag] });
    expect(WorkflowTagsSetRequestSchema.safeParse(write("night\u0000ly")).success).toBe(false);
    expect(WorkflowTagsSetRequestSchema.safeParse(write("night ly")).success).toBe(true);
  });
});
