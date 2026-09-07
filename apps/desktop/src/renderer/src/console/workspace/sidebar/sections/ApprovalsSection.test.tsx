// The approvals section: the three absences, the grouping, the filter, the rollup, and
// the drag.
//
// The store is the real `SessionStore` for `RunsSection.test.tsx`'s reason — the three
// absences are three distinct STORE states, and a hand-made stand-in would let all
// three pass while the real store put the section in a fourth. The `approval` rows are
// put in as projected entities, which is exactly the shape the approval-flow projector
// writes, so the section is read the way it will be read in a running console.
//
// A row's group is asserted by the heading it lands under rather than by reading the
// module's table: the table is the claim, and a test reading it would agree with the
// section whatever either said.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleEntity } from "../../../store/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenarios/composer.js";
import {
  type ConsolePaneAddress,
  type SidebarRowDragBinder,
  type SidebarRowDragTarget,
  type SidebarSectionContext,
} from "../../../seats/index.js";
import { foldSectionRollup } from "../model/section-rollup.js";
import { ApprovalsSection, approvalsSectionRollup } from "./ApprovalsSection.js";

const SESSION_ID = "session-approvals-section";

function approval(
  id: string,
  state: string,
  options: { readonly touchedAt?: string; readonly category?: string } = {},
): ConsoleEntity {
  return {
    kind: "approval",
    id,
    state,
    touchedAt: options.touchedAt ?? "2026-09-01T00:00:00.000Z",
    ...(options.category === undefined ? {} : { body: { category: options.category } }),
  };
}

interface RenderedSection {
  readonly section: HTMLElement;
  readonly store: SessionStore;
  readonly openedPanes: readonly ConsolePaneAddress[];
  readonly context: SidebarSectionContext;
}

function renderSection(options: {
  readonly approvals?: readonly ConsoleEntity[];
  readonly degraded?: boolean;
  readonly filterQuery?: string;
  readonly dragRow?: SidebarRowDragBinder;
}): RenderedSection {
  const store = new SessionStore({ sessionId: SESSION_ID });
  if (options.approvals !== undefined) {
    store.initialise({ cursor: 0, entities: options.approvals, participantJoinLog: [] });
  }
  if (options.degraded === true) {
    store.markDegraded("read-failed");
  }
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const openedPanes: ConsolePaneAddress[] = [];
  const context: SidebarSectionContext = {
    sessionStore: store,
    bridge,
    openPane: (address) => openedPanes.push(address),
    isOpen: true,
    filterQuery: options.filterQuery ?? "",
    // Absent rather than present-and-undefined, which is the case the section's own
    // no-binder branch is written for and the shape the sidebar's context declares.
    ...(options.dragRow === undefined ? {} : { dragRow: options.dragRow }),
  };
  const { container } = render(<ApprovalsSection {...context} />);
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

describe("ApprovalsSection — the three absences are three sentences", () => {
  it("says the read has not answered while the store is uninitialised", () => {
    const { section } = renderSection({});
    expect(section.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(section.textContent).toContain("Reading what this session is waiting on.");
  });

  it("says the list is unavailable, with the store's own cause, when degraded", () => {
    const { section } = renderSection({
      approvals: [approval("approval-1", "pending")],
      degraded: true,
    });
    expect(section.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(section.textContent).toContain("read-failed");
    // A degraded store holding a pending approval must not render it: a partial list
    // shown as a whole one is exactly what this branch exists to prevent.
    expect(section.querySelector(".meridian-section-list__id")).toBeNull();
  });

  it("says nothing is waiting when the read answered and was whole", () => {
    const { section } = renderSection({ approvals: [] });
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(section.textContent).toContain("Nothing in this session is waiting on an approval.");
  });
});

describe("ApprovalsSection — the grouping is the wire's vocabulary", () => {
  it("puts a pending request in the waiting group and a resolved one in settled", () => {
    const { section } = renderSection({
      approvals: [approval("approval-pending", "pending"), approval("approval-done", "approved")],
    });
    expect(groupHeadings(section)).toEqual(["Waiting on a person", "Settled"]);
    expect(rowsUnder(section, "Waiting on a person")).toEqual(["approval-pending"]);
    expect(rowsUnder(section, "Settled")).toEqual(["approval-done"]);
  });

  it("renders a state the union does not carry as itself, in its own group", () => {
    const { section } = renderSection({ approvals: [approval("approval-x", "escalated")] });
    expect(groupHeadings(section)).toEqual(["Unrecognized state"]);
    // The wire's own string is on screen: the section neither drops the row nor
    // guesses it into one of the five registered states.
    expect(section.textContent).toContain("escalated");
  });

  it("orders a group newest first, as moments rather than lexically", () => {
    const { section } = renderSection({
      approvals: [
        approval("approval-older", "pending", { touchedAt: "2026-09-01T09:00:00.000Z" }),
        // An hour later in wall-clock terms, and lexically SMALLER than the row above.
        approval("approval-newer", "pending", { touchedAt: "2026-09-01T08:00:00.000-02:00" }),
      ],
    });
    expect(rowsUnder(section, "Waiting on a person")).toEqual(["approval-newer", "approval-older"]);
  });
});

describe("ApprovalsSection — the filter, and what it does not touch", () => {
  it("narrows to the rows whose id, state, or category matches", () => {
    const { section } = renderSection({
      approvals: [
        approval("approval-1", "pending", { category: "file_write" }),
        approval("approval-2", "pending", { category: "network" }),
      ],
      filterQuery: "network",
    });
    expect(rowsUnder(section, "Waiting on a person")).toEqual(["approval-2"]);
  });

  it("says no approval matches rather than that nothing is waiting", () => {
    const { section } = renderSection({
      approvals: [approval("approval-1", "pending")],
      filterQuery: "nothing-matches-this",
    });
    expect(section.textContent).toContain("No approval matches the filter.");
  });
});

describe("ApprovalsSection — the rollup the sidebar reads while it is collapsed", () => {
  // Through the column's own fold rather than by reading the nodes' members: the fold
  // is what the open-or-collapsed rule is decided from, so a section that reported the
  // right nodes and folded to the wrong level would still leave the rule wrong.
  function rollupOver(options: Parameters<typeof renderSection>[0]) {
    return foldSectionRollup(approvalsSectionRollup(renderSection(options).context));
  }

  it("reports attention when an answered, whole projection holds a pending request", () => {
    expect(rollupOver({ approvals: [approval("approval-1", "pending")] }).attention).toBe(
      "attention",
    );
  });

  it("reports nothing when every request has settled", () => {
    expect(
      rollupOver({ approvals: [approval("approval-1", "approved")] }).attention,
    ).toBeUndefined();
  });

  // The negative control for the never-synthesise rule: the same pending row that
  // raises a mark above raises none while the projection is not answered and whole.
  it("reports nothing from a store that has not loaded", () => {
    const rollup = rollupOver({});
    expect(rollup.attention).toBeUndefined();
    expect(rollup.nodeCount).toBe(0);
  });

  it("reports nothing from a store the daemon called incomplete", () => {
    const rollup = rollupOver({
      approvals: [approval("approval-1", "pending")],
      degraded: true,
    });
    expect(rollup.attention).toBeUndefined();
    expect(rollup.nodeCount).toBe(0);
  });

  it("keeps reporting attention while a filter hides the pending row", () => {
    // A pending approval hidden by a filter is still pending; a rollup answered from
    // the filtered list would go quiet exactly when somebody typed.
    expect(
      rollupOver({
        approvals: [approval("approval-1", "pending")],
        filterQuery: "nothing-matches-this",
      }).attention,
    ).toBe("attention");
  });

  it("counts waiting apart from everything else, which a single level could not carry", () => {
    const rollup = rollupOver({
      approvals: [
        approval("approval-1", "pending"),
        approval("approval-2", "rejected"),
        approval("approval-3", "transcending"),
      ],
    });

    expect(rollup.countsByGroup).toStrictEqual({
      pinned: 0,
      "needs-attention": 1,
      // Nothing about an approval runs: it is a question waiting on a person, so the
      // column's `running` group is unreachable from this section rather than empty by
      // accident.
      running: 0,
      // The settled one and the one whose state this build does not know.
      rest: 2,
    });
  });
});

describe("ApprovalsSection — a row is draggable through the column's own binder", () => {
  it("binds each row's element under a section-scoped node id", () => {
    const boundTargets: SidebarRowDragTarget[] = [];
    const boundElements: HTMLElement[] = [];
    const { section } = renderSection({
      approvals: [approval("approval-1", "pending")],
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
      {
        nodeId: "approvals:approval-1",
        label: "approval approval-1",
        opens: { kind: "approvals" },
      },
    ]);
    // The binder reached the row's own button — the same element the press uses.
    expect(boundElements).toStrictEqual([section.querySelector(".meridian-section-list__open")]);
  });

  it("negative control: a column that hands down no binder binds nothing", () => {
    const { section } = renderSection({ approvals: [approval("approval-1", "pending")] });

    expect(section.querySelectorAll(".meridian-section-list__open")).toHaveLength(1);
  });
});

describe("ApprovalsSection — a row opens the surface that holds every request", () => {
  it("opens the approvals pane rather than an address for one approval", () => {
    const { section, openedPanes } = renderSection({
      approvals: [approval("approval-1", "pending")],
    });
    const open = section.querySelector(".meridian-section-list__open");
    expect(open).not.toBeNull();
    act(() => {
      (open as HTMLButtonElement).click();
    });
    expect(openedPanes).toEqual([{ kind: "approvals" }]);
  });
});
