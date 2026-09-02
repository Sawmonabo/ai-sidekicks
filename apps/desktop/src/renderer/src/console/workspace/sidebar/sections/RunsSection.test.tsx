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
import { describe, expect, it, vi } from "vitest";

import { SessionStore, type ConsoleEntity } from "../../../store/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenarios/composer.js";
import {
  type ConsolePaneAddress,
  type SidebarSectionAttention,
  type SidebarSectionContext,
} from "../../seats/index.js";
import { RunsSection } from "./RunsSection.js";

const SESSION_ID = "session-runs-section";

function run(id: string, state: string, touchedAt = "2026-09-01T00:00:00.000Z"): ConsoleEntity {
  return { kind: "run", id, state, touchedAt };
}

interface RenderedSection {
  readonly section: HTMLElement;
  readonly store: SessionStore;
  readonly openedPanes: readonly ConsolePaneAddress[];
  readonly reported: readonly SidebarSectionAttention[];
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
}): RenderedSection {
  const store = new SessionStore({ sessionId: SESSION_ID });
  if (options.runs !== undefined) {
    store.initialise({ cursor: 0, entities: options.runs, participantJoinLog: [] });
  }
  if (options.degraded === true) {
    store.markDegraded("read-failed");
  }
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const openedPanes: ConsolePaneAddress[] = [];
  const reported: SidebarSectionAttention[] = [];
  const context: SidebarSectionContext = {
    sessionStore: store,
    bridge,
    openPane: (address) => openedPanes.push(address),
    isOpen: true,
    filterQuery: options.filterQuery ?? "",
    reportAttention: (attention) => reported.push(attention),
  };
  const { container } = render(<RunsSection {...context} />);
  return { section: container, store, openedPanes, reported };
}

function groupHeadings(section: HTMLElement): readonly string[] {
  return [...section.querySelectorAll(".meridian-sidebar-runs__group")].map((group) =>
    String(group.getAttribute("aria-label")),
  );
}

function rowsUnder(section: HTMLElement, groupLabel: string): readonly string[] {
  const group = section.querySelector(`[aria-label="${groupLabel}"]`);
  return [...(group?.querySelectorAll(".meridian-sidebar-runs__id") ?? [])].map((element) =>
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
    expect(section.querySelector(".meridian-sidebar-runs__id")).toBeNull();
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
    const open = section.querySelector(".meridian-sidebar-runs__open");
    act(() => {
      (open as HTMLButtonElement).click();
    });
    expect(openedPanes).toStrictEqual([
      { kind: "inspector", entity: { kind: "run", id: "run-1" } },
    ]);
  });
});

describe("RunsSection — what it reports to the sidebar", () => {
  it("reports amber exactly while an answered, whole read carries an attention run", async () => {
    const { reported } = renderSection({ runs: [run("run-failed", "failed")] });
    await vi.waitFor(() => {
      expect(reported.at(-1)).toBe("amber");
    });
  });

  it("negative control: an answered read with no attention run reports calm", () => {
    const { reported } = renderSection({ runs: [run("run-running", "running")] });
    expect(reported.at(-1)).toBe("calm");
  });

  it("reports calm from an unanswered read rather than a mark it cannot justify", () => {
    // A store that has not loaded knows nothing about whether a run needs
    // attention, and a mark raised from that would be a badge the daemon never
    // served.
    expect(renderSection({}).reported.at(-1)).toBe("calm");
  });

  it("reports calm from a degraded read, even holding a failed run", () => {
    // The strongest case: the datum that would raise amber IS in the store, and
    // the section still declines, because the list it came from is incomplete.
    const { reported } = renderSection({
      runs: [run("run-failed", "failed")],
      degraded: true,
    });
    expect(reported.at(-1)).toBe("calm");
  });
});
