// The agents section: what each read state renders, how the roster groups, and where
// a row opens.
//
// THE BRIDGE IS THE REAL FIXTURE BRIDGE with its growth port overridden, which is the
// shape every other surface in this family is driven through: `agent.list` is a growth
// operation, so a suite decides its answer by answering that operation rather than by
// standing in for the reader. The refusal case answers with the SHIPPED refusal for
// that operation, so what the section renders is what a release build produces.
//
// The store is the real `SessionStore`, because the read's refresh triggers watch its
// timeline and a stand-in would let a section pass that never re-reads.
//
// THE CLOCK IS THE SCENARIO'S, and every case advances it. Under the fixture the
// frozen scenario clock is the only clock the renderer reads, so the read's own
// debounce elapses exactly when a tick says it does — a suite that did not advance
// would watch a section sit in its loading arm forever and could not tell that from a
// read that never fired.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../store/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthRefusing,
  unscriptedScenario,
} from "../bridge/fixture/fixture-bridge.test-support.js";
import { type ConsolePaneAddress, type SidebarSectionContext } from "../seats/index.js";
import { AgentsSection } from "./AgentsSection.js";

const SESSION_ID = "session-agents-section";

interface RosterRow {
  readonly agentId: string;
  readonly name?: string;
  readonly state?: string;
  readonly createdAt?: string;
}

interface RenderedSection {
  readonly section: HTMLElement;
  readonly openedPanes: readonly ConsolePaneAddress[];
  /** Advance the scenario clock past the read's debounce. */
  readonly advance: () => void;
}

/**
 * How far the scenario clock moves to settle one read.
 *
 * Comfortably past `REFRESH_DEBOUNCE_MS`, which is what the read's own scheduler arms:
 * the number is a bound rather than the cap itself, so a cap change does not silently
 * turn every case here into a test of the loading arm.
 */
const READ_SETTLE_MS = 5_000;

async function renderSection(options: {
  readonly agents?: readonly RosterRow[];
  readonly refuse?: boolean;
  readonly filterQuery?: string;
}): Promise<RenderedSection> {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const bridge: ConsoleBridge = fixtureBridgeWithGrowth(unscriptedScenario("agents-section"), {
    agentList:
      options.refuse === true
        ? growthRefusing("agentList")
        : growthAnswering(async () => await Promise.resolve({ agents: options.agents ?? [] })),
  });
  const openedPanes: ConsolePaneAddress[] = [];
  const context: SidebarSectionContext = {
    sessionStore: store,
    bridge,
    openPane: (address) => openedPanes.push(address),
    isOpen: true,
    filterQuery: options.filterQuery ?? "",
  };
  const { container } = render(<AgentsSection context={context} />);
  return {
    section: container,
    openedPanes,
    advance: () => bridge.scenarioEngine?.advance(READ_SETTLE_MS),
  };
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

describe("AgentsSection — every read state is its own sentence", () => {
  it("says the read has not answered before the roster arrives", async () => {
    const { section, advance } = await renderSection({
      agents: [{ agentId: "agent-1", state: "ready" }],
    });
    // The first paint, before the read settles: an absence rather than an empty list.
    expect(section.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(section.querySelector(".meridian-section-list__id")).not.toBeNull();
    });
  });

  it("renders the port's own refusal sentence when the wire is unregistered", async () => {
    const { section, advance } = await renderSection({ refuse: true });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(section.querySelector(".meridian-nothing--error")).not.toBeNull();
    });
    // The port's own sentence, composed from that operation's slate row — it names the
    // four `agent.*` verbs the roster read is one of, which is exactly the half a
    // rebuilt refusal would have dropped.
    expect(section.textContent).toContain("is not registered on this build yet");
    expect(section.textContent).toContain("roster read");
  });

  it("says no agent is attached when the roster answered empty", async () => {
    const { section, advance } = await renderSection({ agents: [] });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    });
    expect(section.textContent).toContain("No agent is attached to this session.");
  });
});

describe("AgentsSection — the grouping is the wire's vocabulary", () => {
  it("puts a configured agent in the attention group and a ready one in ready", async () => {
    const { section, advance } = await renderSection({
      agents: [
        { agentId: "agent-waiting", name: "scout", state: "configured" },
        { agentId: "agent-live", name: "pilot", state: "ready" },
      ],
    });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(groupHeadings(section)).toEqual(["Needs attention", "Ready"]);
    });
    expect(rowsUnder(section, "Needs attention")).toEqual(["scout"]);
    expect(rowsUnder(section, "Ready")).toEqual(["pilot"]);
  });

  it("renders a state the vocabulary does not carry as itself, in its own group", async () => {
    const { section, advance } = await renderSection({
      agents: [{ agentId: "agent-x", state: "hibernating" }],
    });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(groupHeadings(section)).toEqual(["Unrecognized state"]);
    });
    // Fail-closed: the row is neither dropped nor guessed into one of the four
    // registered states, and the wire's own string is on screen.
    expect(section.textContent).toContain("hibernating");
  });

  it("names an agent by its id where the roster gave it no name", async () => {
    const { section, advance } = await renderSection({
      agents: [{ agentId: "agent-1", state: "ready" }],
    });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(rowsUnder(section, "Ready")).toEqual(["agent-1"]);
    });
  });
});

describe("AgentsSection — the filter", () => {
  it("narrows to the rows whose name, id, or state matches", async () => {
    const { section, advance } = await renderSection({
      agents: [
        { agentId: "agent-1", name: "scout", state: "ready" },
        { agentId: "agent-2", name: "pilot", state: "ready" },
      ],
      filterQuery: "pilot",
    });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(rowsUnder(section, "Ready")).toEqual(["pilot"]);
    });
  });

  it("says no agent matches rather than that none is attached", async () => {
    const { section, advance } = await renderSection({
      agents: [{ agentId: "agent-1", state: "ready" }],
      filterQuery: "nothing-matches-this",
    });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(section.textContent).toContain("No agent matches the filter.");
    });
  });
});

describe("AgentsSection — a row opens the agent console at that agent", () => {
  it("addresses the pane at the row's own agent", async () => {
    const { section, openedPanes, advance } = await renderSection({
      agents: [{ agentId: "agent-1", name: "scout", state: "ready" }],
    });
    act(() => {
      advance();
    });
    await waitFor(() => {
      expect(section.querySelector(".meridian-section-list__open")).not.toBeNull();
    });
    act(() => {
      (section.querySelector(".meridian-section-list__open") as HTMLButtonElement).click();
    });
    expect(openedPanes).toEqual([
      { kind: "agent-console", entity: { kind: "agent", id: "agent-1" } },
    ]);
  });
});
