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

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenarios/composer.js";
import { type ConsolePaneAddress, type SidebarSectionContext } from "../../../seats/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../../store/index.js";
import { GoalSection } from "./GoalSection.js";

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
    ).toStrictEqual(["Change the goal"]);
  });

  it("opens the surface that owns the editor rather than promising an edit here", () => {
    const { section, openedPanes } = renderSection({ events: [] });
    const control = section.querySelector("button");
    expect(control?.textContent).toBe("Set a goal");
    control?.click();
    expect(openedPanes).toStrictEqual([{ kind: "approvals" }]);
  });
});
