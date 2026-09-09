// The sidebar's state, driven without a renderer and without a store.
//
// Four claims live here and nowhere else, because each is a rule stated over the whole
// section set rather than a property of one component's render:
//
//   1. Collapse is an INVERTED set, so a section this build has and the last save did
//      not is open rather than shut.
//   2. Filtering is an override, so clearing the field restores exactly the shape the
//      person left — with no bookkeeping that could get it wrong.
//   3. Attention opens a section once, and stops deciding the moment a person decides
//      for themselves.
//   4. The durable read fills in what nothing has decided and overrides nothing, so an
//      act made while the record was in flight is not reversed under the person.
//
// NO STORE HERE, and that is the point of the split: this class holds state and emits.
// What it does with a `UiStateStore` is `persistence/use-sidebar-layout.test.tsx`'s
// subject, driven against the real chokepoint.

import { describe, expect, it } from "vitest";

import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from "../../../seats/index.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  SIDEBAR_LAYOUT_REFUSAL_ORIGIN,
  type DecodedSidebarLayout,
} from "./sidebar-layout-record.js";
import { SIDEBAR_SECTION_LABELS } from "./sidebar-labels.js";
import { SidebarModel } from "./sidebar-model.js";
import {
  SIDEBAR_DEFAULT_WIDTH_PERCENT,
  SIDEBAR_MINIMUM_WIDTH_PERCENT,
} from "../../workspace-bounds.js";
import { SIDEBAR_MAXIMUM_WIDTH_PERCENT } from "../../../core/index.js";

function openSections(model: SidebarModel): readonly SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter((sectionId) => model.isSectionOpen(sectionId));
}

/**
 * Every section except the named ones, in the seat's own declaration order.
 *
 * Derived rather than written out, because the section set is closed by
 * `seats/slots/sidebar-sections.ts` and every hand-written list here would be a second copy
 * of it — one that goes stale silently the day the seat gains a section.
 */
function everySectionExcept(...excluded: readonly SidebarSectionId[]): readonly SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter((sectionId) => !excluded.includes(sectionId));
}

/** A decoded record naming exactly the sections a person shut, and nothing dropped. */
function decodedWithShut(
  shut: readonly SidebarSectionId[],
  overrides: { readonly widthPercent?: number; readonly isCollapsed?: boolean } = {},
): DecodedSidebarLayout {
  return {
    state: {
      widthPercent: overrides.widthPercent ?? SIDEBAR_DEFAULT_WIDTH_PERCENT,
      isCollapsed: overrides.isCollapsed ?? false,
      collapsedSectionIds: new Set(shut),
    },
    refusals: [],
  };
}

describe("SidebarModel — collapse as an inverted set", () => {
  it("starts with every section shut, so an unrestored column runs no reads", () => {
    const model = new SidebarModel();
    expect(openSections(model)).toStrictEqual([]);
  });

  it("leaves a section the stored set never named open", () => {
    // The inverted-set claim, driven as the case it exists for: a save made before
    // `runs` existed names only what was shut THEN, and `runs` comes back open rather
    // than shut by omission.
    const model = new SidebarModel();
    model.restore(decodedWithShut(["channels", "agents"]));
    expect(openSections(model)).toStrictEqual(everySectionExcept("channels", "agents"));
  });

  it("negative control: a stored set naming every section leaves none open", () => {
    // Without this, the case above would pass over a restore that ignored the stored
    // value entirely and simply opened everything it did not recognise.
    const model = new SidebarModel();
    model.restore(decodedWithShut([...SIDEBAR_SECTION_IDS]));
    expect(openSections(model)).toStrictEqual([]);
  });

  it("toggles one section without touching the rest", () => {
    const model = new SidebarModel();
    model.restore(decodedWithShut([...SIDEBAR_SECTION_IDS]));
    model.toggleSection("runs");
    expect(openSections(model)).toStrictEqual(["runs"]);
    model.toggleSection("runs");
    expect(openSections(model)).toStrictEqual([]);
  });
});

describe("SidebarModel — the durable read fills in, it does not override", () => {
  // The sidebar is on screen and interactive from the first frame, and opening a
  // database and reading a record is not. Everything below is the window between those
  // two facts, where an unconditional restore silently reverses an act the person
  // watched happen.

  it("keeps a width settled before the read landed", () => {
    const model = new SidebarModel();
    model.recordWidthPercent(SIDEBAR_MINIMUM_WIDTH_PERCENT);
    const differs = model.restore(
      decodedWithShut([], { widthPercent: SIDEBAR_MAXIMUM_WIDTH_PERCENT }),
    );
    expect(model.snapshot.state.widthPercent).toBe(SIDEBAR_MINIMUM_WIDTH_PERCENT);
    // And the caller is told, so the person's width is filed rather than left behind
    // the record that lost to it.
    expect(differs).toBe(true);
  });

  it("negative control: with no resize in that window the stored width wins", () => {
    // Without this the case above would pass over a restore that ignored the stored
    // width entirely.
    const model = new SidebarModel();
    const differs = model.restore(
      decodedWithShut([], { widthPercent: SIDEBAR_MAXIMUM_WIDTH_PERCENT }),
    );
    expect(model.snapshot.state.widthPercent).toBe(SIDEBAR_MAXIMUM_WIDTH_PERCENT);
    // Nothing to write back: what is on screen is exactly what the record held.
    expect(differs).toBe(false);
  });

  it("keeps a section opened in that window, and restores every section beside it", () => {
    const model = new SidebarModel();
    // Everything is drawn shut until the read lands, so the act available to a person
    // in this window is opening one.
    model.setSectionCollapsed("runs", false);
    model.restore(decodedWithShut(["runs", "members"]));
    // `runs` keeps the person's decision, `members` keeps the disk's, and every section
    // nobody touched comes back the way it was left.
    expect(openSections(model)).toStrictEqual(everySectionExcept("members"));
  });

  it("negative control: with no toggle in that window the stored set wins", () => {
    const model = new SidebarModel();
    model.restore(decodedWithShut(["runs", "members"]));
    expect(openSections(model)).toStrictEqual(everySectionExcept("runs", "members"));
  });

  it("keeps a section attention opened in that window", () => {
    // Attention is a decider too, and this is the arm that would go quiet: a section
    // reporting the same level twice moves nothing, so a restore that shut it would
    // leave it shut with nothing left to re-open it.
    const model = new SidebarModel();
    model.syncAttention({ runs: "failure" });
    model.restore(decodedWithShut([...SIDEBAR_SECTION_IDS]));
    expect(openSections(model)).toStrictEqual(["runs"]);
  });

  it("keeps a column collapse made in that window", () => {
    const model = new SidebarModel();
    model.setColumnCollapsed(true);
    model.restore(decodedWithShut([], { isCollapsed: false }));
    expect(model.snapshot.state.isCollapsed).toBe(true);
  });

  it("settles even where the record held nothing, so the column can announce", () => {
    const model = new SidebarModel();
    expect(model.snapshot.hasSettled).toBe(false);
    model.restore({ state: INITIAL_SIDEBAR_LAYOUT_STATE, refusals: [] });
    expect(model.snapshot.hasSettled).toBe(true);
  });

  it("carries what the decode dropped, rather than swallowing it", () => {
    const model = new SidebarModel();
    const differs = model.restore({
      state: INITIAL_SIDEBAR_LAYOUT_STATE,
      refusals: [
        {
          origin: SIDEBAR_LAYOUT_REFUSAL_ORIGIN,
          code: "section-unknown",
          detail: "A section this build does not have.",
        },
      ],
    });
    expect(model.snapshot.restoreRefusals).toHaveLength(1);
    // Nothing was decided in that window, so the narrowed state is not written back
    // over the record a later build could still read.
    expect(differs).toBe(false);
  });
});

describe("SidebarModel — the filter is an override, not a mutation", () => {
  it("opens every section while filtering and restores the shape when cleared", () => {
    const model = new SidebarModel();
    model.setSectionCollapsed("runs", false);
    expect(openSections(model)).toStrictEqual(["runs"]);

    model.setFilterQuery("worktree");
    expect(openSections(model)).toStrictEqual([...SIDEBAR_SECTION_IDS]);

    model.setFilterQuery("");
    expect(openSections(model)).toStrictEqual(["runs"]);
  });

  it("negative control: a section collapsed mid-filter is collapsed after it clears", () => {
    // The case above would pass over an implementation that expanded by mutation and
    // then restored a snapshot taken when the filter opened — which would put `runs`
    // back OPEN here, losing the person's mid-filter decision.
    const model = new SidebarModel();
    model.setSectionCollapsed("runs", false);
    model.setFilterQuery("w");
    model.setSectionCollapsed("runs", true);
    model.setFilterQuery("");
    expect(openSections(model)).toStrictEqual([]);
  });
});

describe("SidebarModel — attention decides until a person does", () => {
  it("opens a section that starts calling, and holds what it answered", () => {
    const model = new SidebarModel();
    model.syncAttention({ runs: "attention", repos: "failure" });
    expect(openSections(model)).toStrictEqual(["runs", "repos"]);
    expect(model.attentionFor("runs")).toBe("attention");
  });

  it("negative control: a reading with no callers opens nothing and marks nothing", () => {
    const model = new SidebarModel();
    model.syncAttention({});
    expect(openSections(model)).toStrictEqual([]);
    expect(model.attentionFor("members")).toBeUndefined();
  });

  it("stops re-opening a section the person shut", () => {
    const model = new SidebarModel();
    model.syncAttention({ runs: "attention" });
    model.setSectionCollapsed("runs", true);
    // A section under load answers on every read; without the personal-decision record
    // this would fight the person once per projection transition.
    model.syncAttention({});
    model.syncAttention({ runs: "failure" });
    expect(openSections(model)).toStrictEqual([]);
    // The MARK still moves, which is the half the person did not decide: they shut the
    // section, they did not declare it healthy.
    expect(model.attentionFor("runs")).toBe("failure");
  });

  it("moves nothing when the same reading arrives twice", () => {
    const model = new SidebarModel();
    model.syncAttention({ runs: "attention" });
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.syncAttention({ runs: "attention" });
    expect(notifications).toBe(0);
  });
});

describe("SidebarModel — the cursor", () => {
  it("moves the cursor and stops at both ends rather than wrapping", () => {
    const model = new SidebarModel();
    model.moveCursor(-1);
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
    model.moveCursor(SIDEBAR_SECTION_IDS.length * 2);
    expect(model.snapshot.cursorSectionId).toBe(
      SIDEBAR_SECTION_IDS[SIDEBAR_SECTION_IDS.length - 1],
    );
  });

  it("negative control: setting the cursor where it already is notifies nobody", () => {
    const model = new SidebarModel();
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.setCursor(SIDEBAR_SECTION_IDS[0]);
    expect(notifications).toBe(0);
  });
});

describe("SidebarModel — the width", () => {
  it("clamps to the band the column is readable in", () => {
    const model = new SidebarModel();
    model.recordWidthPercent(SIDEBAR_MAXIMUM_WIDTH_PERCENT + 1000);
    expect(model.snapshot.state.widthPercent).toBe(SIDEBAR_MAXIMUM_WIDTH_PERCENT);
    model.recordWidthPercent(0);
    expect(model.snapshot.state.widthPercent).toBe(SIDEBAR_MINIMUM_WIDTH_PERCENT);
  });

  it("says nothing about a width it is already at, so a settled split writes nothing", () => {
    const model = new SidebarModel();
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.recordWidthPercent(SIDEBAR_DEFAULT_WIDTH_PERCENT);
    expect(notifications).toBe(0);
  });
});

describe("SidebarModel — subscribers", () => {
  it("notifies on every change and stops on unsubscribe", () => {
    const model = new SidebarModel();
    const seen: number[] = [];
    const unsubscribe = model.subscribe((snapshot) => {
      seen.push(snapshot.state.widthPercent);
    });
    model.recordWidthPercent(SIDEBAR_MINIMUM_WIDTH_PERCENT);
    unsubscribe();
    model.recordWidthPercent(SIDEBAR_MAXIMUM_WIDTH_PERCENT);
    // One notification, not two: the second change lands after the unsubscribe, and a
    // model that notified anyway would keep an unmounted sidebar rendering.
    expect(seen).toStrictEqual([SIDEBAR_MINIMUM_WIDTH_PERCENT]);
  });

  it("hands back one snapshot object per transition, which is what the store hook reads", () => {
    const model = new SidebarModel();
    const first = model.snapshot;
    expect(model.snapshot).toBe(first);
    model.toggleSection("runs");
    expect(model.snapshot).not.toBe(first);
  });
});

describe("the sidebar's labels", () => {
  it("names every declared section", () => {
    for (const sectionId of SIDEBAR_SECTION_IDS) {
      expect(SIDEBAR_SECTION_LABELS[sectionId]).not.toBe("");
    }
    expect(Object.keys(SIDEBAR_SECTION_LABELS)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });
});
