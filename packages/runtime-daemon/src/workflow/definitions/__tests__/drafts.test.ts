// The builder's drafts are the person's unsaved work: one mixed up with another's, or left behind
// after its save, is work lost or a stale document reopened.
import type { WorkflowDraftDocument } from "@ai-sidekicks/contracts/workflow/definition/document";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILDER_AUTHOR,
  buildWorkflowDocument,
  openWorkflowLibraryFixture,
  type WorkflowLibraryFixture,
} from "./store.test-support.js";

let fixture: WorkflowLibraryFixture;

beforeEach(async () => {
  fixture = await openWorkflowLibraryFixture();
});

afterEach(async () => {
  await fixture.close();
});

describe("WorkflowDraftStore", () => {
  it("keeps each draft apart until its own save clears it", async () => {
    const { store, drafts } = fixture;
    const first = await store.create({ document: buildWorkflowDocument("First") }, BUILDER_AUTHOR, {
      isFromNewWorkflowDraft: false,
    });
    const second = await store.create(
      { document: buildWorkflowDocument("Second") },
      BUILDER_AUTHOR,
      { isFromNewWorkflowDraft: false },
    );
    const firstDraft = buildWorkflowDocument("First edited", "first-draft.md");
    const secondDraft = buildWorkflowDocument("Second edited", "second-draft.md");
    // A new workflow's draft may not have its trigger yet.
    const untriggeredDraft: WorkflowDraftDocument = {
      schemaVersion: "2",
      name: "Brand new",
      nodes: [],
      edges: [],
      tags: ["drafts"],
    };

    await drafts.update({
      definitionId: first.definitionId,
      basedOnVersionNumber: 1,
      document: firstDraft,
    });
    await drafts.update({ definitionId: second.definitionId, document: secondDraft });
    await drafts.update({ document: untriggeredDraft });

    const firstRead = drafts.read(first.definitionId).draft;
    const secondRead = drafts.read(second.definitionId).draft;
    const newWorkflowRead = drafts.read().draft;
    expect(firstRead?.basedOnVersionNumber).toBe(1);
    expect(JSON.stringify(firstRead?.document)).toBe(JSON.stringify(firstDraft));
    expect(secondRead?.basedOnVersionNumber).toBeUndefined();
    expect(JSON.stringify(secondRead?.document)).toBe(JSON.stringify(secondDraft));
    expect(newWorkflowRead?.definitionId).toBeUndefined();
    expect(JSON.stringify(newWorkflowRead?.document)).toBe(JSON.stringify(untriggeredDraft));

    await store.update(
      {
        definitionId: first.definitionId,
        expectedVersionNumber: 1,
        document: buildWorkflowDocument("First", "saved.md"),
      },
      BUILDER_AUTHOR,
    );
    expect(drafts.read(first.definitionId).draft).toBeNull();
    expect(JSON.stringify(drafts.read(second.definitionId).draft?.document)).toBe(
      JSON.stringify(secondDraft),
    );
    expect(drafts.read().draft).not.toBeNull();

    await store.create({ document: buildWorkflowDocument("Brand new") }, BUILDER_AUTHOR, {
      isFromNewWorkflowDraft: true,
    });
    expect(drafts.read().draft).toBeNull();
    expect(drafts.read(second.definitionId).draft).not.toBeNull();
  });
});
