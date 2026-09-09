// The goal line: what it states, what it refuses to state, and what it does not edit.
//
// The store is the real `SessionStore` driven through `initialise` and
// `markDegraded`, on `RunsSection.test.tsx`'s reason: the absences this section
// renders are distinct STORE states, and a stand-in returning a hand-made object
// would let every one of them pass while the real store put the section in another.
//
// THE SHARPEST CASE IS THE DEGRADED ONE. A projection missing the very event that
// set the goal answers the fold with "none" — so a section that rendered the fold
// without checking the store's completeness would report its own gap as the
// session's state, in the words a person reads as "nobody has set one".

import { cleanup, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenario/composer/composer.js";
import { consoleCommands } from "../../../palette/index.js";
import { type ConsolePaneAddress, type SidebarSectionContext } from "../../../seats/index.js";
import { FrameStore, SessionStore, type ConsoleSessionEvent } from "../../../store/index.js";
import { GoalSection } from "./GoalSection.js";
import { GOAL_SECTION_ACTION_LABEL, GOAL_SECTION_COMMAND_ID } from "./goal-section-commands.js";

const SESSION_ID = "session-goal-section";

/** One goal event, in the shape the fold reads off the log. */
function goalEvent(options: {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "session.goal_updated" | "session.goal_cleared";
  readonly text?: string;
}): ConsoleSessionEvent {
  return {
    id: options.id,
    sessionId: SESSION_ID,
    sequence: options.sequence,
    kind: options.kind,
    occurredAt: "2026-09-01T00:00:00.000Z",
    payload:
      options.text === undefined
        ? { sessionId: SESSION_ID }
        : { sessionId: SESSION_ID, goal: { text: options.text } },
  };
}

interface RenderedGoalSection {
  readonly section: HTMLElement;
  readonly openedPanes: readonly ConsolePaneAddress[];
}

function renderSection(options: {
  readonly events?: readonly ConsoleSessionEvent[];
  readonly degraded?: boolean;
}): RenderedGoalSection {
  const store = new SessionStore({ sessionId: SESSION_ID });
  if (options.events !== undefined) {
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    for (const event of options.events) {
      store.apply(event);
    }
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
    filterQuery: "",
  };
  const { container } = render(<GoalSection {...context} />);
  return { section: container, openedPanes };
}

describe("GoalSection — the absences are not one another", () => {
  it("says the read has not answered while the store is uninitialised", () => {
    const { section } = renderSection({});
    expect(section.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(section.textContent).toContain("Reading the session's goal.");
  });

  it("never reports an incomplete projection as a session with no goal", () => {
    const { section } = renderSection({ events: [], degraded: true });
    expect(section.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(section.textContent).toContain("read-failed");
    expect(section.textContent).not.toContain("No goal set");
  });

  it("says no goal is set once the read has answered and the log names none", () => {
    const { section } = renderSection({ events: [] });
    expect(section.textContent).toContain("No goal set");
  });
});

describe("GoalSection — one line, and it is the log's", () => {
  it("states the goal the latest goal event carries", () => {
    const { section } = renderSection({
      events: [
        goalEvent({
          id: "e1",
          sequence: 1,
          kind: "session.goal_updated",
          text: "Ship the console",
        }),
      ],
    });
    expect(section.querySelector(".meridian-sidebar-goal__text")?.textContent).toBe(
      "Ship the console",
    );
  });

  it("keeps the whole text reachable rather than shortening the participant's own words", () => {
    const goal = "Ship the console, then the sidebar, then everything the sidebar opens";
    const { section } = renderSection({
      events: [goalEvent({ id: "e1", sequence: 1, kind: "session.goal_updated", text: goal })],
    });
    const line = section.querySelector(".meridian-sidebar-goal__text");
    expect(line?.textContent).toBe(goal);
    expect(line?.getAttribute("title")).toBe(goal);
  });

  it("follows a clear back to no goal, because clearing is its own act", () => {
    const { section } = renderSection({
      events: [
        goalEvent({ id: "e1", sequence: 1, kind: "session.goal_updated", text: "Ship it" }),
        goalEvent({ id: "e2", sequence: 2, kind: "session.goal_cleared" }),
      ],
    });
    expect(section.textContent).toContain("No goal set");
  });
});

describe("GoalSection — it states the goal and never edits it", () => {
  it("offers no field, no set control of its own, and no clear", () => {
    // A second editor here would be a second in-flight mutation over a contract
    // that admits exactly one per session, and it could not see the card's.
    const { section } = renderSection({
      events: [goalEvent({ id: "e1", sequence: 1, kind: "session.goal_updated", text: "Ship it" })],
    });
    expect(section.querySelector("textarea")).toBeNull();
    expect(section.querySelector("input")).toBeNull();
    expect(
      [...section.querySelectorAll("button")].map((control) => control.textContent),
    ).toStrictEqual([GOAL_SECTION_ACTION_LABEL]);
  });

  it("opens the surface that owns the editor rather than promising an edit here", () => {
    const { section, openedPanes } = renderSection({ events: [] });
    const control = section.querySelector("button");
    expect(control?.textContent).toBe(GOAL_SECTION_ACTION_LABEL);
    control?.click();
    expect(openedPanes).toStrictEqual([{ kind: "approvals" }]);
  });

  it("says the same neutral words whether or not a goal is set", () => {
    // The label used to swap between "Set a goal" and "Change the goal", which
    // advertised a mutation to every role — including the two the goal contract
    // makes read-only, whose destination renders no editor at all.
    const withGoal = renderSection({
      events: [goalEvent({ id: "e1", sequence: 1, kind: "session.goal_updated", text: "Ship it" })],
    });
    expect(withGoal.section.querySelector("button")?.textContent).toBe(GOAL_SECTION_ACTION_LABEL);
    cleanup();

    const withoutGoal = renderSection({ events: [] });
    expect(withoutGoal.section.querySelector("button")?.textContent).toBe(
      GOAL_SECTION_ACTION_LABEL,
    );
  });

  it("negative control: the words promise no mutation", () => {
    // Without this the case above would pass over a label that swapped one advertised
    // mutation for another, or that named the act "Set the goal" in both readings.
    const { section } = renderSection({ events: [] });
    const label = section.querySelector("button")?.textContent ?? "";
    expect(label).not.toContain("Set a goal");
    expect(label).not.toContain("Change the goal");
  });
});

describe("GoalSection — the act is palette-reachable, and it is the same act", () => {
  it("contributes a row carrying the button's own words", () => {
    renderSection({ events: [] });

    expect(consoleCommands.get(GOAL_SECTION_COMMAND_ID)?.title).toBe(GOAL_SECTION_ACTION_LABEL);
  });

  it("opens the same pane the button opens", () => {
    const { openedPanes } = renderSection({ events: [] });

    consoleCommands.get(GOAL_SECTION_COMMAND_ID)?.run();

    expect(openedPanes).toStrictEqual([{ kind: "approvals" }]);
  });

  it("offers the row in every reading the section has, as the button is", () => {
    // The control is not withheld while the projection is incomplete — that is when
    // a person most wants to look at what the session is for — so the row is not
    // either. Presence on both surfaces is the one condition: the section is mounted.
    const { section } = renderSection({ events: [], degraded: true });

    expect(section.querySelector("button")?.textContent).toBe(GOAL_SECTION_ACTION_LABEL);
    expect(consoleCommands.get(GOAL_SECTION_COMMAND_ID)).not.toBeUndefined();
  });

  it("negative control: the row goes when the section does", () => {
    // Without this every case above would pass over a contribution registered at
    // module scope, which would keep offering to open a pane in a window whose
    // sidebar had gone.
    renderSection({ events: [] });
    expect(consoleCommands.get(GOAL_SECTION_COMMAND_ID)).not.toBeUndefined();

    cleanup();

    expect(consoleCommands.get(GOAL_SECTION_COMMAND_ID)).toBeUndefined();
  });
});
