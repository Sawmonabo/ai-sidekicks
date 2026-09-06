// The sidebar's state, driven without a renderer.
//
// Four claims live here and nowhere else, because each is a rule stated over the
// whole section set rather than a property of one component's render:
//
//   1. Collapse is an INVERTED set, so a section this build has and the last save
//      did not is open rather than shut.
//   2. Filtering is an override, so clearing the field restores exactly the shape
//      the person left — with no bookkeeping that could get it wrong.
//   3. Attention opens a section once, and stops deciding the moment a person
//      decides for themselves.
//   4. A refused durable write is KEPT, so a store that cannot save the sidebar's
//      shape is visible rather than silently forgetful.
//
// The store is real. A hand-rolled stand-in would pass every case below while the
// actual chokepoint refused the value class, which is the one failure a test of a
// persisted setting exists to catch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consoleTripwires } from "../../core/tripwires.js";
import { MemoryPersistenceAdapter, UiStateStore } from "../../persistence/index.js";
import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from "../../seats/index.js";
import {
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
} from "../../core/index.js";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_WIDTH_KEY } from "./sidebar-constants.js";
import { SidebarModel } from "./sidebar-model.js";

const SESSION_ID = "session-sidebar-model";

function openSections(model: SidebarModel): readonly SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter((id) => model.isSectionOpen(id));
}

/**
 * Every section except the named ones, in the seat's own declaration order.
 *
 * Derived rather than written out, because the section set is closed by
 * `seats/sidebar-sections.ts` and every hand-written list here would be a second
 * copy of it — one that goes stale silently the day the seat gains a section, which
 * is exactly what happened when `goal` and `approvals` landed.
 */
function everySectionExcept(...excluded: readonly SidebarSectionId[]): readonly SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter((id) => !excluded.includes(id));
}

// The refused-write case fires the persistence tripwire on purpose. Tripwires
// throw in development so a breach cannot be ignored; here the breach is the
// subject, so it is recorded instead.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.setThrowOnReport(true);
  consoleTripwires.reset();
});

describe("SidebarModel — collapse as an inverted set", () => {
  it("starts with every section shut and reports the whole set collapsed", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    expect(openSections(model)).toStrictEqual([]);
  });

  it("leaves a section the stored set never named open", async () => {
    // The inverted-set claim, driven as the case it exists for: a save made
    // before `runs` existed names only what was shut THEN, and `runs` comes back
    // open rather than shut by omission.
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    await uiStateStore.write(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY, "expansion", [
      "channels",
      "agents",
    ]);
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    expect(openSections(model)).toStrictEqual(everySectionExcept("channels", "agents"));
  });

  it("negative control: a stored set naming every section leaves none open", async () => {
    // Without this, the case above would pass over a `restore` that ignored the
    // stored value entirely and simply opened everything it did not recognise.
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    await uiStateStore.write(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY, "expansion", [
      ...SIDEBAR_SECTION_IDS,
    ]);
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    expect(openSections(model)).toStrictEqual([]);
  });

  it("writes what a person shut, through the value-class chokepoint", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    model.toggleSection("runs");

    await vi.waitFor(async () => {
      const record = await uiStateStore.read(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY);
      // `runs` is the one NOT in the set: the stored value is what is shut, and
      // toggling opened it. Sorted, which is the order the model writes in.
      expect(record?.value).toStrictEqual([...everySectionExcept("runs")].sort());
      expect(record?.valueClass).toBe("expansion");
    });

    const restored = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await restored.restore();
    expect(openSections(restored)).toStrictEqual(["runs"]);
  });
});

describe("SidebarModel — the durable read fills in, it does not override", () => {
  // The sidebar is on screen and interactive from the first frame, and opening a
  // database and reading two records is not. Everything below is the window
  // between those two facts, where an unconditional restore silently reverses an
  // act the person watched happen.

  it("keeps a width set before the read landed", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    await uiStateStore.writeGlobal(SIDEBAR_WIDTH_KEY, "layout", {
      sidebar: { widthPx: SIDEBAR_MAX_WIDTH_PX },
    });
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });

    // The restore is started and NOT awaited, which is exactly how the hook that
    // owns it calls it; the resize lands while the read is in flight.
    const restoring = model.restore();
    model.setWidth(SIDEBAR_MIN_WIDTH_PX);
    await restoring;

    expect(model.snapshot.widthPx).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(model.snapshot.isRestored).toBe(true);
  });

  it("negative control: with no resize in that window the stored width wins", async () => {
    // Without this the case above would pass over a `restore` that ignored the
    // stored width entirely.
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    await uiStateStore.writeGlobal(SIDEBAR_WIDTH_KEY, "layout", {
      sidebar: { widthPx: SIDEBAR_MAX_WIDTH_PX },
    });
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    expect(model.snapshot.widthPx).toBe(SIDEBAR_MAX_WIDTH_PX);
  });

  it("keeps a section opened in that window, and restores every section beside it", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    // Disk shut two sections last time. Everything is drawn shut until the read
    // lands, so the act available to a person in this window is opening one.
    await uiStateStore.write(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY, "expansion", [
      "runs",
      "members",
    ]);
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });

    const restoring = model.restore();
    model.toggleSection("runs");
    await restoring;

    // `runs` keeps the person's decision, `members` keeps the disk's, and every
    // section nobody touched comes back the way it was left.
    expect(openSections(model)).toStrictEqual(everySectionExcept("members"));
  });

  it("negative control: with no toggle in that window the stored set wins", async () => {
    // Without this the case above would pass over a `restore` that ignored the
    // stored set and opened everything.
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    await uiStateStore.write(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY, "expansion", [
      "runs",
      "members",
    ]);
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    expect(openSections(model)).toStrictEqual(everySectionExcept("runs", "members"));
  });

  it("keeps a section attention opened in that window", async () => {
    // Attention is a decider too, and this is the arm that would go quiet: a
    // section reporting the same level twice moves nothing, so a restore that
    // shut it would leave it shut with nothing left to re-open it.
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    await uiStateStore.write(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY, "expansion", [
      ...SIDEBAR_SECTION_IDS,
    ]);
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    const restoring = model.restore();
    model.reportAttention("runs", "red");
    await restoring;
    expect(openSections(model)).toStrictEqual(["runs"]);
  });
});

describe("SidebarModel — the filter is an override, not a mutation", () => {
  it("opens every section while filtering and restores the shape when cleared", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    model.setSectionCollapsed("runs", false);
    expect(openSections(model)).toStrictEqual(["runs"]);

    model.setFilterQuery("worktree");
    expect(openSections(model)).toStrictEqual([...SIDEBAR_SECTION_IDS]);

    model.setFilterQuery("");
    expect(openSections(model)).toStrictEqual(["runs"]);
  });

  it("negative control: a section collapsed mid-filter is collapsed after it clears", () => {
    // The case above would pass over an implementation that expanded by mutation
    // and then restored a snapshot taken when the filter opened — which would put
    // `runs` back OPEN here, losing the person's mid-filter decision.
    const model = new SidebarModel({ sessionId: SESSION_ID });
    model.setSectionCollapsed("runs", false);
    model.setFilterQuery("w");
    model.setSectionCollapsed("runs", true);
    model.setFilterQuery("");
    expect(openSections(model)).toStrictEqual([]);
  });
});

describe("SidebarModel — attention decides until a person does", () => {
  it("opens a section that reports amber or red", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    model.reportAttention("runs", "amber");
    model.reportAttention("repos", "red");
    expect(openSections(model)).toStrictEqual(["runs", "repos"]);
    expect(model.attentionFor("runs")).toBe("amber");
  });

  it("negative control: calm opens nothing and is the answer before any report", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    model.reportAttention("runs", "calm");
    expect(openSections(model)).toStrictEqual([]);
    expect(model.attentionFor("members")).toBe("calm");
  });

  it("stops re-opening a section the person shut", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    model.reportAttention("runs", "amber");
    model.setSectionCollapsed("runs", true);
    // A section under load reports on every read; without the personal-decision
    // record this would fight the person once per event.
    model.reportAttention("runs", "calm");
    model.reportAttention("runs", "red");
    expect(openSections(model)).toStrictEqual([]);
  });
});

describe("SidebarModel — the cursor and the width", () => {
  it("moves the cursor and stops at both ends rather than wrapping", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    model.moveCursor(-1);
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
    model.moveCursor(SIDEBAR_SECTION_IDS.length * 2);
    expect(model.snapshot.cursorSectionId).toBe(
      SIDEBAR_SECTION_IDS[SIDEBAR_SECTION_IDS.length - 1],
    );
  });

  it("clamps the width to the declared bounds and restores it window-wide", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    expect(model.snapshot.widthPx).toBe(SIDEBAR_DEFAULT_WIDTH_PX);

    model.setWidth(SIDEBAR_MAX_WIDTH_PX + 1000);
    expect(model.snapshot.widthPx).toBe(SIDEBAR_MAX_WIDTH_PX);
    model.setWidth(0);
    expect(model.snapshot.widthPx).toBe(SIDEBAR_MIN_WIDTH_PX);

    // Global rather than session-scoped: a second session's sidebar is the same
    // column on the same screen.
    const other = new SidebarModel({ sessionId: "session-somewhere-else", uiStateStore });
    await vi.waitFor(async () => {
      await other.restore();
      expect(other.snapshot.widthPx).toBe(SIDEBAR_MIN_WIDTH_PX);
    });
  });
});

describe("SidebarModel — a refused write is kept", () => {
  it("holds the store's own refusal rather than forgetting silently", async () => {
    // A one-byte ceiling is the smallest way to make the real chokepoint refuse a
    // legitimate value; the refusal is the store's, not one this test invented.
    const uiStateStore = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      recordByteCap: 1,
    });
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    model.toggleSection("runs");

    await vi.waitFor(() => {
      expect(model.snapshot.persistenceRefusal?.code).toBe("value-too-large");
      expect(model.snapshot.persistenceRefusal?.origin).toBe("persistence");
    });
    // The refusal does not undo the change on screen: the section is open, and
    // what the person is told is that it will not be remembered.
    expect(model.isSectionOpen("runs")).toBe(true);
  });

  it("negative control: a store that accepts the write raises no refusal", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    const model = new SidebarModel({ sessionId: SESSION_ID, uiStateStore });
    await model.restore();
    model.toggleSection("runs");
    await vi.waitFor(async () => {
      expect(await uiStateStore.read(SESSION_ID, SIDEBAR_COLLAPSED_SECTIONS_KEY)).toBeDefined();
    });
    expect(model.snapshot.persistenceRefusal).toBeUndefined();
  });
});

describe("SidebarModel — subscribers", () => {
  it("notifies on every change and stops on unsubscribe", () => {
    const model = new SidebarModel({ sessionId: SESSION_ID });
    const seen: number[] = [];
    const unsubscribe = model.subscribe((snapshot) => {
      seen.push(snapshot.widthPx);
    });
    model.setWidth(SIDEBAR_MIN_WIDTH_PX);
    unsubscribe();
    model.setWidth(SIDEBAR_MAX_WIDTH_PX);
    // One notification, not two: the second change lands after the unsubscribe,
    // and a model that notified anyway would keep an unmounted sidebar rendering.
    expect(seen).toStrictEqual([SIDEBAR_MIN_WIDTH_PX]);
  });
});
