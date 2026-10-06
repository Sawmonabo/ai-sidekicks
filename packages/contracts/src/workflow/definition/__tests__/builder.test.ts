// The builder keeps its unsaved draft in the daemon. This case holds the cross-member rule the
// daemon relies on: a draft is based on a version only of a named workflow.
import { describe, expect, it } from "vitest";

import { WorkflowDraftUpdateRequestSchema } from "../builder.js";

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
