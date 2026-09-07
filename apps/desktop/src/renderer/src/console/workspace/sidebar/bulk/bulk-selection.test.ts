// The shared selection: what it holds, what it scopes, and what survives a clear.

import { BulkSelectionModel, bulkItemKey, bulkSelectionFaceOf } from "./bulk-selection.js";
import { type SidebarBulkItem } from "../../../seats/index.js";

const QUEUED_ITEM: SidebarBulkItem = {
  sectionId: "runs",
  act: "cancel-queue-item",
  itemId: "queue-1",
  label: "Draft the migration",
};
const SECOND_QUEUED_ITEM: SidebarBulkItem = { ...QUEUED_ITEM, itemId: "queue-2", label: "Rebase" };
const INVITE: SidebarBulkItem = {
  sectionId: "members",
  act: "revoke-invite",
  itemId: "invite-1",
  label: "ada@example.test",
};

describe("the sidebar's bulk selection", () => {
  it("holds rows from more than one section at once", () => {
    const model = new BulkSelectionModel();

    model.toggle(QUEUED_ITEM);
    model.toggle(INVITE);

    expect(model.snapshot.selectedItems).toHaveLength(2);
    expect(model.selectedActs()).toStrictEqual(["cancel-queue-item", "revoke-invite"]);
  });

  it("offers each act only the rows that admit it", () => {
    // The reason the selection is act-scoped rather than section-scoped: running the
    // cancel over the invite would send a queue-cancel for an invite id.
    const model = new BulkSelectionModel();
    model.toggle(QUEUED_ITEM);
    model.toggle(SECOND_QUEUED_ITEM);
    model.toggle(INVITE);

    expect(model.selectedFor("cancel-queue-item")).toStrictEqual([QUEUED_ITEM, SECOND_QUEUED_ITEM]);
    expect(model.selectedFor("retire-worktree")).toStrictEqual([]);
  });

  it("keys a row on its section and its act, not on its id alone", () => {
    // One entity reachable from two sections is two rows, and ticking one must not
    // tick the other.
    expect(bulkItemKey(QUEUED_ITEM)).not.toBe(
      bulkItemKey({ ...QUEUED_ITEM, sectionId: "channels" }),
    );
  });

  it("takes a row back out when it is toggled again", () => {
    const model = new BulkSelectionModel();
    model.toggle(QUEUED_ITEM);
    model.toggle(QUEUED_ITEM);

    expect(model.isSelected(QUEUED_ITEM)).toBe(false);
  });

  it("takes a row out of the selection the moment it is in flight", () => {
    // A row still selected while its call is in the air is a row the bar would offer
    // the act for a second time.
    const model = new BulkSelectionModel();
    model.toggle(QUEUED_ITEM);
    model.markRunning(QUEUED_ITEM);

    expect(model.isSelected(QUEUED_ITEM)).toBe(false);
    expect(model.outcomeFor(QUEUED_ITEM)).toStrictEqual({ state: "running" });
  });

  it("keeps a refusal on screen after the selection is cleared", () => {
    // "A failed item renders its own refusal and never hides the others' success" is a
    // claim about what is on screen AFTER the run, so clearing the selection must not
    // clear the record of what it did.
    const model = new BulkSelectionModel();
    model.toggle(QUEUED_ITEM);
    model.markRunning(QUEUED_ITEM);
    model.markRefused(QUEUED_ITEM, {
      code: "queue.item_not_cancelable",
      detail: "The item has already been admitted.",
      origin: "daemon",
    });
    model.clearSelection();

    expect(model.outcomeFor(QUEUED_ITEM)).toStrictEqual({
      state: "refused",
      refusal: {
        code: "queue.item_not_cancelable",
        detail: "The item has already been admitted.",
        origin: "daemon",
      },
    });
  });

  it("negative control: dismissing the results is what drops them", () => {
    // Without this the case above would pass over a model that never dropped an
    // outcome at all, which would leave every refusal on screen forever.
    const model = new BulkSelectionModel();
    model.markDone(QUEUED_ITEM);
    model.clearOutcomes();

    expect(model.outcomeFor(QUEUED_ITEM)).toBeUndefined();
  });

  it("publishes on every change, so the bar re-reads it", () => {
    const model = new BulkSelectionModel();
    const snapshots: number[] = [];
    const stop = model.subscribe((snapshot) => snapshots.push(snapshot.selectedItems.length));

    model.toggle(QUEUED_ITEM);
    model.toggle(INVITE);
    stop();
    model.toggle(SECOND_QUEUED_ITEM);

    expect(snapshots).toStrictEqual([1, 2]);
  });
});

describe("the face a section row drives the selection through", () => {
  it("carries the three acts a row needs and no way to enumerate the set", () => {
    const model = new BulkSelectionModel();
    const face = bulkSelectionFaceOf(model);

    face.toggle(QUEUED_ITEM);

    expect(face.isSelected(QUEUED_ITEM)).toBe(true);
    expect(face.outcomeFor(QUEUED_ITEM)).toBeUndefined();
    // A section that could read the whole selection could run it, and the confirm
    // names a set no section can see.
    expect(Object.keys(face).toSorted()).toStrictEqual(["isSelected", "outcomeFor", "toggle"]);
  });
});
