// The one record the sidebar keeps, driven through its own encoder and decoder.
//
// The seam's two halves are tested against each other rather than against a fixture,
// because a fixture is a third spelling of the grammar and would go stale the moment
// either side moved. What IS pinned literally is the grammar's own vocabulary — the
// header key, the version, and the collapsed member — since those are the addresses a
// record written last week is read back at.

import { describe, expect, it } from "vitest";

import { SIDEBAR_MAXIMUM_WIDTH_PERCENT } from "../../../core/index.js";
import { isSingleNameIdentifierShaped } from "../../../persistence/index.js";
import { SIDEBAR_SECTION_IDS } from "../../../seats/index.js";
import {
  DECK_MINIMUM_WIDTH_PERCENT,
  SIDEBAR_DEFAULT_WIDTH_PERCENT,
  SIDEBAR_MINIMUM_WIDTH_PERCENT,
} from "../../workspace-bounds.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
  SIDEBAR_SNAPSHOT_HEADER_KEY,
  clampSidebarWidthPercent,
  collapsedSectionSetsMatch,
  decodeSidebarLayout,
  encodeSidebarLayout,
  type SidebarLayoutState,
} from "./sidebar-layout-record.js";

function layoutWith(shut: readonly string[], widthPercent = 30, isCollapsed = true) {
  return {
    widthPercent,
    isCollapsed,
    collapsedSectionIds: new Set(shut),
  } as unknown as SidebarLayoutState;
}

describe("the sidebar's saved arrangement", () => {
  it("round-trips a width, a column collapse, and the set of shut sections", () => {
    const state = layoutWith(["repos", "artifacts"]);
    const decoded = decodeSidebarLayout(encodeSidebarLayout(state));
    expect(decoded.state.widthPercent).toBe(state.widthPercent);
    expect(decoded.state.isCollapsed).toBe(state.isCollapsed);
    expect(
      collapsedSectionSetsMatch(decoded.state.collapsedSectionIds, state.collapsedSectionIds),
    ).toBe(true);
    expect(decoded.refusals).toStrictEqual([]);
  });

  it("writes the same record for the same set whatever order it was built in", () => {
    // Byte-stable, because the store compares before it writes: a record that reordered
    // itself would file a change nobody made on every restore.
    const forwards = encodeSidebarLayout(layoutWith(["channels", "repos", "artifacts"]));
    const backwards = encodeSidebarLayout(layoutWith(["artifacts", "repos", "channels"]));
    expect(Object.keys(forwards)).toStrictEqual(Object.keys(backwards));
    expect(forwards).toStrictEqual(backwards);
  });

  it("keeps every key identifier-shaped, which is what the value class admits", () => {
    // The chokepoint refuses a record carrying a key that is not identifier-shaped, and
    // a refusal at the write would arrive a release after the code that caused it.
    const record = encodeSidebarLayout(layoutWith([...SIDEBAR_SECTION_IDS]));
    for (const key of Object.keys(record)) {
      expect(isSingleNameIdentifierShaped(key)).toBe(true);
    }
  });

  it("writes only what is SHUT, so a section this build mints reads as open", () => {
    const record = encodeSidebarLayout(layoutWith(["channels", "agents"]));
    expect(Object.keys(record)).toStrictEqual([SIDEBAR_SNAPSHOT_HEADER_KEY, "channels", "agents"]);
  });

  it("discards a record of an unknown version whole", () => {
    const decoded = decodeSidebarLayout({
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION + 1,
        widthPercent: 39,
        isCollapsed: true,
      },
      runs: { collapsed: true },
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
      },
      runs: { collapsed: true },
    });
    expect(decoded.state.widthPercent).toBe(39);
    expect(decoded.state.isCollapsed).toBe(true);
    expect([...decoded.state.collapsedSectionIds]).toStrictEqual(["runs"]);
    expect(decoded.refusals).toStrictEqual([]);
  });

  it("drops a section this build does not have, and says so once", () => {
    const decoded = decodeSidebarLayout({
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 22,
        isCollapsed: false,
      },
      telemetry: { collapsed: true },
      forecasting: { collapsed: true },
      runs: { collapsed: true },
    });
    expect([...decoded.state.collapsedSectionIds]).toStrictEqual(["runs"]);
    // ONE refusal for two unknown sections: a record written by a build with sections
    // this one lacks is one fact, not one per section.
    expect(decoded.refusals.map((refusal) => refusal.code)).toStrictEqual(["section-unknown"]);
  });

  it("answers a record that is not a record at all with the opening arrangement", () => {
    for (const corrupt of [null, 7, "sidebar", []]) {
      const decoded = decodeSidebarLayout(corrupt);
      expect(decoded.state).toStrictEqual(INITIAL_SIDEBAR_LAYOUT_STATE);
      expect(decoded.refusals.map((refusal) => refusal.code)).toStrictEqual([
        "snapshot-shape-invalid",
      ]);
    }
  });

  it("takes a header member it cannot read as the opening value rather than a hole", () => {
    const decoded = decodeSidebarLayout({
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: "wide",
      },
    });
    expect(decoded.state.widthPercent).toBe(SIDEBAR_DEFAULT_WIDTH_PERCENT);
    expect(decoded.state.isCollapsed).toBe(false);
  });
});

describe("the sidebar's width band", () => {
  it("holds a saved width inside the band the sidebar is readable in", () => {
    expect(clampSidebarWidthPercent(3)).toBe(SIDEBAR_MINIMUM_WIDTH_PERCENT);
    expect(clampSidebarWidthPercent(90)).toBe(SIDEBAR_MAXIMUM_WIDTH_PERCENT);
    expect(clampSidebarWidthPercent(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH_PERCENT);
  });

  it("negative control: a width already inside the band is kept exactly", () => {
    expect(clampSidebarWidthPercent(24)).toBe(24);
  });

  it("leaves the deck exactly its floor when the sidebar is dragged to its ceiling", () => {
    // The two ends of one band, driven together, so the pair cannot become two readings
    // of one constraint that disagree.
    expect(clampSidebarWidthPercent(90) + DECK_MINIMUM_WIDTH_PERCENT).toBe(100);
  });
});

describe("comparing two collapsed sets", () => {
  it("matches on membership rather than on insertion order", () => {
    expect(collapsedSectionSetsMatch(new Set(["runs", "repos"]), new Set(["repos", "runs"]))).toBe(
      true,
    );
  });

  it("negative control: a set with one more member does not match", () => {
    expect(collapsedSectionSetsMatch(new Set(["runs"]), new Set(["runs", "repos"]))).toBe(false);
  });
});
