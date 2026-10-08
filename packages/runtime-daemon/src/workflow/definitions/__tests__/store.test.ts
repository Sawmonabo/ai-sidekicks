// The workflow library's writes over a real database: a setting beside a version mints none, a
// save keeps the settings it carries, a stale save writes nothing, a delete keeps what runs pin
// and drops the rest, and a name is held once in the library ignoring case.
import type { WorkflowNodeId } from "@ai-sidekicks/contracts/workflow/definition/document";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureRun } from "../../runs/__fixtures__/rows.js";
import { WorkflowKeptValueStore } from "../kept-values.js";
import { WorkflowLibrary } from "../library.js";
import { WorkflowDefinitionStore } from "../store.js";
import {
  BUILDER_AUTHOR,
  buildWorkflowDocument,
  openWorkflowLibraryFixture,
  type WorkflowLibraryFixture,
} from "./store.test-support.js";

const CREATE_OPTIONS = { isFromNewWorkflowDraft: false };
const NAME_TAKEN_REFUSAL = {
  code: "workflow.definition_refused",
  findings: [{ rule: "name_taken", nodeIds: [] }],
};

// A library that never sees a held name, standing in for a save that raced another past the check.
class NameBlindLibrary extends WorkflowLibrary {
  override isNameHeld(): boolean {
    return false;
  }
}

let fixture: WorkflowLibraryFixture;

beforeEach(async () => {
  fixture = await openWorkflowLibraryFixture();
});

afterEach(async () => {
  await fixture.close();
});

describe("WorkflowDefinitionStore settings", () => {
  it("stores layout, pins, tags and the permission level without a version", async () => {
    const { store, library } = fixture;
    const { definitionId, contentHash } = await store.create(
      { document: buildWorkflowDocument("Nightly") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    expect(library.read({ definitionId }).permissionLevel).toBe("yolo");
    const layout = { nodes: { trigger: { x: 0, y: 0 }, read: { x: 300, y: 40 } } };
    const pinnedItems = [{ json: { text: "pinned" } }];

    await store.setLayout({ definitionId, layout });
    await store.setPinData({ definitionId, nodeId: "read" as WorkflowNodeId, items: pinnedItems });
    await store.setPinData({
      definitionId,
      nodeId: "trigger" as WorkflowNodeId,
      items: [{ json: {} }],
    });
    await store.setPinData({ definitionId, nodeId: "trigger" as WorkflowNodeId, items: null });
    await store.setTags({ definitionId, tags: ["ops/nightly"] });
    await store.updatePermissionLevel({ definitionId, level: "ask" });

    const read = library.read({ definitionId });
    expect(read.document.layout).toEqual(layout);
    expect(read.document.pinData).toEqual({ read: pinnedItems });
    expect(read.document.tags).toEqual(["ops/nightly"]);
    expect(read.permissionLevel).toBe("ask");
    expect(read.versionNumber).toBe(1);
    expect(read.contentHash).toBe(contentHash);
    expect(fixture.countVersions(definitionId)).toBe(1);
  });
});

describe("WorkflowDefinitionStore.update", () => {
  it("adds exactly one version on the latest and refuses a stale one with no row", async () => {
    const { store, library } = fixture;
    const { definitionId } = await store.create(
      { document: buildWorkflowDocument("Nightly") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );

    const saved = await store.update(
      {
        definitionId,
        expectedVersionNumber: 1,
        document: buildWorkflowDocument("Nightly", "second.md"),
      },
      BUILDER_AUTHOR,
    );
    expect(saved.versionNumber).toBe(2);
    expect(fixture.countVersions(definitionId)).toBe(2);

    await expect(
      store.update(
        {
          definitionId,
          expectedVersionNumber: 1,
          document: buildWorkflowDocument("Nightly", "third.md"),
        },
        BUILDER_AUTHOR,
      ),
    ).rejects.toMatchObject({
      code: "workflow.version_stale",
      detail: { expectedVersionNumber: 1, latestVersionNumber: 2 },
    });
    expect(fixture.countVersions(definitionId)).toBe(2);
    const read = library.read({ definitionId });
    expect(read.workflowVersionId).toBe(saved.workflowVersionId);
    expect(read.contentHash).toBe(saved.contentHash);
    expect(read.document.nodes[0]?.params).toEqual({ path: "second.md" });
  });

  it("stores a save's layout and tags and keeps them past a save without them", async () => {
    const { store, library } = fixture;
    const { definitionId } = await store.create(
      { document: buildWorkflowDocument("Nightly") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    const layout = { nodes: { trigger: { x: 0, y: 0 }, read: { x: 480, y: 120 } } };

    await store.update(
      {
        definitionId,
        expectedVersionNumber: 1,
        document: { ...buildWorkflowDocument("Nightly", "second.md"), layout, tags: ["ops"] },
      },
      BUILDER_AUTHOR,
    );
    const saved = library.read({ definitionId });
    expect(saved.document.layout).toEqual(layout);
    expect(saved.document.tags).toEqual(["ops"]);

    await store.update(
      {
        definitionId,
        expectedVersionNumber: 2,
        document: buildWorkflowDocument("Nightly", "third.md"),
      },
      BUILDER_AUTHOR,
    );
    const resaved = library.read({ definitionId });
    expect(resaved.versionNumber).toBe(3);
    expect(resaved.document.layout).toEqual(layout);
    expect(resaved.document.tags).toEqual(["ops"]);
  });
});

describe("WorkflowDefinitionStore.delete", () => {
  it("keeps versions and their pinned runs, and drops kept values and the draft", async () => {
    const { store, drafts, library, scratch } = fixture;
    const keptValues = new WorkflowKeptValueStore(scratch);
    const created = await store.create(
      { document: buildWorkflowDocument("Nightly") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    const { definitionId } = created;
    const saved = await store.update(
      {
        definitionId,
        expectedVersionNumber: 1,
        document: buildWorkflowDocument("Nightly", "second.md"),
      },
      BUILDER_AUTHOR,
    );
    const firstRun = await createFixtureRun(scratch.writer, created.workflowVersionId);
    const secondRun = await createFixtureRun(scratch.writer, saved.workflowVersionId);
    await keptValues.keep(definitionId, secondRun, { cursor: 42 });
    await drafts.update({
      definitionId,
      basedOnVersionNumber: 2,
      document: buildWorkflowDocument("Nightly", "draft.md"),
    });
    const storedRuns = scratch.reader.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM workflow_runs WHERE id IN (?, ?)",
    );

    await expect(store.delete(definitionId)).resolves.toEqual({
      definitionId,
      deleted: true,
      retainedRunCount: 2,
    });

    expect(fixture.countVersions(definitionId)).toBe(2);
    expect(library.read({ definitionId, version: 1 }).workflowVersionId).toBe(
      created.workflowVersionId,
    );
    expect(storedRuns.get(firstRun, secondRun)?.count).toBe(2);
    expect(keptValues.read(definitionId)).toEqual([]);
    expect(drafts.read(definitionId).draft).toBeNull();
  });
});

describe("one name per workflow in the library", () => {
  it("refuses a name held in another case, writing nothing", async () => {
    const { store, library } = fixture;
    const nightly = await store.create(
      { document: buildWorkflowDocument("Nightly") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    const other = await store.create(
      { document: buildWorkflowDocument("Other") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    await store.create(
      { document: buildWorkflowDocument("NIGHTLY COPY") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    const definitionCount = fixture.countDefinitions();
    const versionCount = fixture.countVersions();

    await expect(
      store.create({ document: buildWorkflowDocument("nightly") }, BUILDER_AUTHOR, CREATE_OPTIONS),
    ).rejects.toMatchObject(NAME_TAKEN_REFUSAL);
    await expect(
      store.update(
        {
          definitionId: other.definitionId,
          expectedVersionNumber: 1,
          document: buildWorkflowDocument("nightly", "renamed.md"),
        },
        BUILDER_AUTHOR,
      ),
    ).rejects.toMatchObject(NAME_TAKEN_REFUSAL);
    // Past the check, the write itself refuses the held name.
    const raceStore = new WorkflowDefinitionStore(
      fixture.scratch,
      new NameBlindLibrary(fixture.scratch),
      () => undefined,
    );
    await expect(
      raceStore.create(
        { document: buildWorkflowDocument("nIGHTLY") },
        BUILDER_AUTHOR,
        CREATE_OPTIONS,
      ),
    ).rejects.toMatchObject(NAME_TAKEN_REFUSAL);
    expect(fixture.countDefinitions()).toBe(definitionCount);
    expect(fixture.countVersions()).toBe(versionCount);
    expect(library.read({ definitionId: other.definitionId }).name).toBe("Other");

    const duplicate = await store.duplicate(nightly.definitionId, BUILDER_AUTHOR);
    expect(library.read({ definitionId: duplicate.definitionId }).name).toBe("Nightly copy 2");
  });

  it("lets a deleted workflow's name be used again", async () => {
    const { store, library } = fixture;
    const nightly = await store.create(
      { document: buildWorkflowDocument("Nightly") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    await store.delete(nightly.definitionId);

    const reused = await store.create(
      { document: buildWorkflowDocument("NIGHTLY") },
      BUILDER_AUTHOR,
      CREATE_OPTIONS,
    );
    expect(library.read({ definitionId: reused.definitionId }).name).toBe("NIGHTLY");
  });
});
