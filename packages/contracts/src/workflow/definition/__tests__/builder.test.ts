// The builder keeps its unsaved draft and previews expressions against the last run.
// These cases hold the two cross-member rules the daemon relies on: a draft is based on
// a version only of a named workflow, and a preview reads exactly one of a saved
// workflow or a draft.
import { describe, expect, it } from "vitest";

import {
  WorkflowDraftUpdateRequestSchema,
  WorkflowExpressionPreviewRequestSchema,
} from "../builder.js";

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

describe("workflow.expressionPreview", () => {
  it("previews against exactly one of a definition or a draft", () => {
    const preview = { nodeId: "summary", expression: "={{ $json.summary }}" };
    expect(WorkflowExpressionPreviewRequestSchema.safeParse(preview).success).toBe(false);
    expect(
      WorkflowExpressionPreviewRequestSchema.safeParse({ ...preview, definitionId: "def-1" })
        .success,
    ).toBe(true);
    expect(
      WorkflowExpressionPreviewRequestSchema.safeParse({
        ...preview,
        definitionId: "def-1",
        workflowDraftId: "draft-1",
      }).success,
    ).toBe(false);
  });
});
