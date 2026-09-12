// The runs section: the three absences, the grouping, the filter, and the report.
//
// The store is the real `SessionStore` driven through `initialise` and
// `markDegraded`, because the three absences this section renders are three
// distinct STORE states and a stand-in returning a hand-made object would let all
// three pass while the real store put the section in a fourth.
//
// The grouping cases assert a run's group by the heading it lands under rather
// than by reaching into the module's table: the table is what the section is
// claiming, so a test reading it would agree with the section no matter what
// either said.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FrameStore, SessionStore, type ConsoleEntity } from "../../../store/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenario/composer/composer.js";
import {
  type ConsolePaneAddress,
  type SidebarRowDragBinder,
  type SidebarRowDragTarget,
  type SidebarSectionContext,
} from "../../../seats/index.js";
import { foldSectionRollup } from "../model/section-rollup.js";
import { RunsSection, runsSectionRollup } from "./RunsSection.js";

const SESSION_ID = "session-runs-section";

function run(id: string, state: string, touchedAt = "2026-09-01T00:00:00.000Z"): ConsoleEntity {
  return { kind: "run", id, state, touchedAt };
}

interface RenderedSection {
  readonly section: HTMLElement;
  readonly store: SessionStore;
  readonly openedPanes: readonly ConsolePaneAddress[];
  readonly context: SidebarSectionContext;
}

/**
 * Render the section over a store in one of its real states.
 *
 * `runs === undefined` leaves the store uninitialised, which is the `not-loaded`
 * absence; a `degradedCause` marks it after initialising, which is the `error`
 * one; an empty array is the initialised-and-whole `empty` one.
 */
function renderSection(options: {
  readonly runs?: readonly ConsoleEntity[];
  readonly degraded?: boolean;
  readonly filterQuery?: string;
  readonly dragRow?: SidebarRowDragBinder;
}): RenderedSection {
  const store = new SessionStore({ sessionId: SESSION_ID });
  if (options.runs !== undefined) {
    store.initialise({ cursor: 0, entities: options.runs, userJoinLog: [] });
  }
  if (options.degraded === true) {
    store.markDegraded("read-failed");
  }
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const openedPanes: ConsolePaneAddress[] = [];
  const context: SidebarSectionContext = {
    sessionStore: store,
    bridge,
    frameStore: new FrameStore(),
    openPane: (address) => openedPanes.push(address),
    isOpen: true,
    filterQuery: options.filterQuery ?? "",
    // Absent rather than present-and-undefined, which is the case the section's own
    // no-binder branch is written for and the shape the sidebar's context declares.
    ...(options.dragRow === undefined ? {} : { dragRow: options.dragRow }),
  };
  const { container } = render(<RunsSection {...context} />);
  return { section: container, store, openedPanes, context };
}

function groupHeadings(section: HTMLElement): readonly string[] {
  return [...section.querySelectorAll(".meridian-section-list__group")].map((group) =>
    String(group.getAttribute("aria-label")),
  );
}

function rowsUnder(section: HTMLElement, groupLabel: string): readonly string[] {
  const group = section.querySelector(`[aria-label="${groupLabel}"]`);
  return [...(group?.querySelectorAll(".meridian-section-list__id") ?? [])].map((element) =>
    String(element.textContent),
  );
}

describe("RunsSection — the three absences are three sentences", () => {
  it("says the read has not answered while the store is uninitialised", () => {
    const { section } = renderSection({});
    expect(section.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(section.textContent).toContain("Reading the session's runs.");
  });

  it("says the list is unavailable, with the store's own cause, when degraded", () => {
    const { section } = renderSection({ runs: [run("run-1", "running")], degraded: true });
    expect(section.querySelector(".meridian-nothing--error")).not.toBeNull();
    // The cause is rendered verbatim rather than paraphrased into a friendlier
    // word, which is what makes this different from the empty case below.
    expect(section.textContent).toContain("read-failed");
    // A degraded store holding a run must not render the run: a partial list
    // shown as a whole one is the failure this branch exists to prevent.
    expect(section.querySelector(".meridian-section-list__id")).toBeNull();
  });

  it("says no run has started when the read answered and was whole", () => {
    const { section } = renderSection({ runs: [] });
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(section.textContent).toContain("No run has been started");
  });

  it("negative control: with runs present none of the three absences renders", () => {
    // Without this, all three cases above would pass over a section that rendered
    // its `not-loaded` branch unconditionally.
    const { section } = renderSection({ runs: [run("run-1", "running")] });
    expect(section.querySelector(".meridian-nothing")).toBeNull();
    expect(section.textContent).toContain("run-1");
  });
});

describe("RunsSection — grouping is the wire's vocabulary", () => {
  it("splits the registered states into needs-attention, running, and the rest", () => {
    const { section } = renderSection({
      runs: [
        run("run-failed", "failed"),
        run("run-approval", "waiting_for_approval"),
        run("run-running", "running"),
        run("run-done", "completed"),
      ],
    });
    expect(groupHeadings(section)).toStrictEqual(["Needs attention", "Running", "Everything else"]);
    expect(new Set(rowsUnder(section, "Needs attention"))).toStrictEqual(
      new Set(["run-failed", "run-approval"]),
    );
    expect(rowsUnder(section, "Running")).toStrictEqual(["run-running"]);
    expect(rowsUnder(section, "Everything else")).toStrictEqual(["run-done"]);
  });

  it("puts a state the union does not carry in its own group rather than guessing", () => {
    // Fail-closed: a build that meets a tenth state must not silently file it
    // under "everything else", where it would look like a settled run.
    const { section } = renderSection({ runs: [run("run-odd", "transcending")] });
    expect(groupHeadings(section)).toStrictEqual(["Unrecognized state"]);
    expect(rowsUnder(section, "Unrecognized state")).toStrictEqual(["run-odd"]);
    // The state is still shown verbatim; the section neither renames nor hides it.
    expect(section.textContent).toContain("transcending");
  });

  it("orders a group newest first", () => {
    const { section } = renderSection({
      runs: [
        run("run-older", "running", "2026-09-01T00:00:00.000Z"),
        run("run-newer", "running", "2026-09-02T00:00:00.000Z"),
      ],
    });
    expect(rowsUnder(section, "Running")).toStrictEqual(["run-newer", "run-older"]);
  });

  it("renders a heading only for a group that has rows", () => {
    const { section } = renderSection({ runs: [run("run-running", "running")] });
    expect(groupHeadings(section)).toStrictEqual(["Running"]);
  });
});

describe("RunsSection — the sidebar's filter narrows this section's rows", () => {
  it("keeps the rows the query matches by identifier or by state", () => {
    const { section } = renderSection({
      runs: [run("run-alpha", "running"), run("run-beta", "completed")],
      filterQuery: "ALPHA",
    });
    // Case-insensitive: the person types what they remember, not what the wire
    // happens to have capitalised.
    expect(rowsUnder(section, "Running")).toStrictEqual(["run-alpha"]);
    expect(groupHeadings(section)).toStrictEqual(["Running"]);
  });

  it("says nothing matched the filter rather than nothing has started", () => {
    // The two empty states are different facts, and telling a person no run has
    // started while they have a filter on would be false.
    const { section } = renderSection({
      runs: [run("run-alpha", "running")],
      filterQuery: "nothing-matches-this",
    });
    expect(section.textContent).toContain("No run matches the filter.");
    expect(section.textContent).not.toContain("No run has been started");
  });
});

describe("RunsSection — opening a pane", () => {
  it("opens the inspector on the run the person activated", () => {
    const { section, openedPanes } = renderSection({ runs: [run("run-1", "running")] });
    const open = section.querySelector(".meridian-section-list__open");
    act(() => {
      (open as HTMLButtonElement).click();
    });
    // The session's runs pane, with no entity member on the address: no pane kind
    // is a view of one run, so the row opens the surface that holds them all.
    expect(openedPanes).toStrictEqual([{ kind: "runs" }]);
  });
});

describe("RunsSection — the rollup the sidebar reads while this section is shut", () => {
  // Driven through the exported reader rather than through a render, because that is
  // how the sidebar calls it: a collapsed section is not mounted, and a rollup that
  // could only be produced by a mounted body would be unreachable in exactly the state
  // the rule that opens it is written for.
  //
  // The LEVEL is asserted through the column's own fold rather than by reading the
  // nodes' members, because the fold is what the open-or-collapsed rule is decided
  // from: a section that reported the right nodes and folded to the wrong level would
  // still leave the rule wrong, and this is the reading that catches it.

  function rollupOver(options: Parameters<typeof renderSection>[0]) {
    return foldSectionRollup(runsSectionRollup(renderSection(options).context));
  }

  it("folds to `attention` while an answered, whole read carries a run needing one", () => {
    expect(rollupOver({ runs: [run("run-failed", "failed")] }).attention).toBe("attention");
  });

  it("negative control: an answered read with no such run folds to nothing", () => {
    expect(rollupOver({ runs: [run("run-running", "running")] }).attention).toBeUndefined();
  });

  it("reports nothing from an unanswered read rather than a mark it cannot justify", () => {
    // A store that has not loaded knows nothing about whether a run needs attention,
    // and a mark raised from that would be a badge the daemon never served.
    const rollup = rollupOver({});
    expect(rollup.attention).toBeUndefined();
    // And no counts either: the header draws nothing rather than four zeroes, which is
    // the difference between "unavailable" and "empty" this section spends a branch on.
    expect(rollup.nodeCount).toBe(0);
  });

  it("reports nothing from a degraded read, even holding a failed run", () => {
    // The strongest case: the datum that would raise the mark IS in the store, and the
    // section still declines, because the list it came from is incomplete.
    const rollup = rollupOver({ runs: [run("run-failed", "failed")], degraded: true });
    expect(rollup.attention).toBeUndefined();
    expect(rollup.nodeCount).toBe(0);
  });

  it("ignores the filter, because a failed run hidden by one is still a failed run", () => {
    expect(
      rollupOver({ runs: [run("run-failed", "failed")], filterQuery: "nothing-matches" }).attention,
    ).toBe("attention");
  });

  it("counts its runs into the column's groups, which a single level could not carry", () => {
    // What the tree buys over the level it replaced: the shut header's grouped counts.
    const rollup = rollupOver({
      runs: [
        run("run-failed", "failed"),
        run("run-running", "running"),
        run("run-done", "completed"),
        run("run-odd", "transcending"),
      ],
    });

    expect(rollup.countsByGroup).toStrictEqual({
      pinned: 0,
      "needs-attention": 1,
      running: 1,
      // The settled run and the one whose state this build does not know. The column's
      // four groups have no member for an unrecognized state, and the section draws it
      // under its own heading instead of a fifth shared group being minted for it.
      rest: 2,
    });
  });
});

describe("RunsSection — a row is draggable through the column's own binder", () => {
  it("binds each row's element under a section-scoped node id", () => {
    const boundTargets: SidebarRowDragTarget[] = [];
    const boundElements: HTMLElement[] = [];
    const { section } = renderSection({
      runs: [run("run-1", "running")],
      dragRow: (target) => {
        boundTargets.push(target);
        return (element) => {
          if (element !== null) {
            boundElements.push(element);
          }
        };
      },
    });

    expect(boundTargets).toStrictEqual([
      // Prefixed by the section, because the binder cache is the whole column's.
      { nodeId: "runs:run-1", label: "run run-1", opens: { kind: "runs" } },
    ]);
    // And the binder actually reached an ELEMENT, which is the half a composed target
    // does not prove: the same button the press uses, because the drag and the press
    // are two ways to perform one act rather than two controls for one outcome.
    expect(boundElements).toStrictEqual([section.querySelector(".meridian-section-list__open")]);
  });

  it("negative control: a column that hands down no binder binds nothing", () => {
    // The section still renders its rows; what it does not do is invent a gesture.
    const { section } = renderSection({ runs: [run("run-1", "running")] });

    expect(section.querySelectorAll(".meridian-section-list__open")).toHaveLength(1);
  });
});
