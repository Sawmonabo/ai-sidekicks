// The sidebar's three rules, driven directly: who is open, what round-trips, and what
// a record this build cannot read does to the column.
//
// The open-section rule is the risky one and it fails silently in both directions — a
// sidebar that ignored attention leaves a red section folded away, and one that let two
// sections open at once stops being the surface the design describes.

import { describe, expect, it } from "vitest";

import { SIDEBAR_SECTION_IDS } from "../../seats/index.js";
import {
  DECK_MINIMUM_WIDTH_PERCENT,
  SIDEBAR_DEFAULT_WIDTH_PERCENT,
  SIDEBAR_MAXIMUM_WIDTH_PERCENT,
  SIDEBAR_MINIMUM_WIDTH_PERCENT,
} from "../workspace-bounds.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
  SIDEBAR_SECTION_LABELS,
  SIDEBAR_SNAPSHOT_HEADER_KEY,
  chooseSectionOnPress,
  clampSidebarWidthPercent,
  decodeSidebarLayout,
  encodeSidebarLayout,
  resolveOpenSectionId,
} from "./sidebar-model.js";

describe("the sidebar's open section", () => {
  it("opens the section that is calling, over the one the person chose", () => {
    expect(resolveOpenSectionId({ approvals: "attention" }, "goal")).toBe("approvals");
  });

  it("opens the FIRST caller in declared order when two are calling", () => {
    // Declared order rather than severity: the order is the order a person reads down
    // the column, and comparing amber against red across two families would be a
    // ranking no document states. `runs` precedes `artifacts` in the tuple.
    expect(resolveOpenSectionId({ artifacts: "attention", runs: "failure" }, undefined)).toBe(
      "runs",
    );
  });

  it("falls back to the person's choice when nothing is calling", () => {
    expect(resolveOpenSectionId({}, "members")).toBe("members");
  });

  it("negative control: nothing calling and nothing chosen leaves every section collapsed", () => {
    // Without this every case above would pass over a resolver that opened the first
    // declared section unconditionally — which is exactly what density rule 7 forbids.
    expect(resolveOpenSectionId({}, undefined)).toBeUndefined();
  });

  it("closes the open section when its own header is pressed again", () => {
    expect(chooseSectionOnPress("runs", "runs")).toBeUndefined();
  });

  it("negative control: pressing another section opens that one instead", () => {
    // One section at a time is enforced by the choice being a single value, so
    // "opening a second collapses the first" needs no second act to forget.
    expect(chooseSectionOnPress("agents", "runs")).toBe("agents");
  });
});

describe("the sidebar's saved arrangement", () => {
  it("round-trips a width, a collapse, and the open section", () => {
    const state = { widthPercent: 30, isCollapsed: true, chosenSectionId: "repos" } as const;
    expect(decodeSidebarLayout(encodeSidebarLayout(state)).state).toStrictEqual(state);
  });

  it("keeps every string it writes identifier-shaped, which is what the class admits", () => {
    // The chokepoint refuses a value carrying a string that is not identifier-shaped,
    // and a refusal at the write would arrive a release after the code that caused it.
    const record = encodeSidebarLayout({
      widthPercent: 22,
      isCollapsed: false,
      chosenSectionId: "channels",
    });
    const header = record[SIDEBAR_SNAPSHOT_HEADER_KEY];
    expect(header?.["openSectionId"]).toBe("channels");
    expect(Object.keys(record)).toStrictEqual([SIDEBAR_SNAPSHOT_HEADER_KEY]);
  });

  it("discards a record of an unknown version whole", () => {
    const decoded = decodeSidebarLayout({
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION + 1,
        widthPercent: 39,
        isCollapsed: true,
        openSectionId: "runs",
      },
    });
    expect(decoded.state).toStrictEqual(INITIAL_SIDEBAR_LAYOUT_STATE);
    expect(decoded.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "snapshot-version-unknown",
    ]);
  });

  it("negative control: the same record at this version is adopted", () => {
    // Without this the case above would pass over a decoder that discarded everything.
    const decoded = decodeSidebarLayout({
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 39,
        isCollapsed: true,
        openSectionId: "runs",
      },
    });
    expect(decoded.state.chosenSectionId).toBe("runs");
    expect(decoded.refusals).toStrictEqual([]);
  });

  it("drops a section this build does not have, and says so", () => {
    const decoded = decodeSidebarLayout({
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 22,
        isCollapsed: false,
        openSectionId: "telemetry",
      },
    });
    expect(decoded.state.chosenSectionId).toBeUndefined();
    expect(decoded.refusals.map((refusal) => refusal.code)).toStrictEqual(["section-unknown"]);
  });

  it("answers a record that is not a record at all with the opening arrangement", () => {
    for (const corrupt of [null, 7, "sidebar", []]) {
      const decoded = decodeSidebarLayout(corrupt);
      expect(decoded.state).toStrictEqual(INITIAL_SIDEBAR_LAYOUT_STATE);
      expect(decoded.refusals).toHaveLength(1);
    }
  });

  it("holds a saved width inside the band the sidebar is readable in", () => {
    expect(clampSidebarWidthPercent(3)).toBe(SIDEBAR_MINIMUM_WIDTH_PERCENT);
    expect(clampSidebarWidthPercent(90)).toBe(SIDEBAR_MAXIMUM_WIDTH_PERCENT);
    expect(clampSidebarWidthPercent(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH_PERCENT);
  });

  it("negative control: a width already inside the band is kept exactly", () => {
    expect(clampSidebarWidthPercent(24)).toBe(24);
  });

  it("leaves the deck exactly its floor when the sidebar is dragged to its ceiling", () => {
    // The two ends of one band, driven together. The split held its own deck floor of
    // forty percent while the clamp capped the sidebar at forty, so a sidebar at its
    // ceiling left the deck sixty and the pair summed to eighty — two readings of one
    // constraint, disagreeing.
    expect(clampSidebarWidthPercent(90) + DECK_MINIMUM_WIDTH_PERCENT).toBe(100);
  });
});

describe("the sidebar's labels", () => {
  it("names every declared section", () => {
    // Total by construction in the type, and total in fact here: a section added to the
    // tuple without a label would render as its own identifier.
    for (const sectionId of SIDEBAR_SECTION_IDS) {
      expect(SIDEBAR_SECTION_LABELS[sectionId]).not.toBe("");
    }
    expect(Object.keys(SIDEBAR_SECTION_LABELS)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });
});
