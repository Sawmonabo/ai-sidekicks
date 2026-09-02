// The pane: bound to a session or honestly not, the lease folded from the log, and
// an emulator mounted with nothing to show.
//
// WHAT EARNS A TEST HERE. The pieces have their own files — the fold, the line, the
// emulator — so this one owns the three decisions the PANE makes. It renders the
// unbound absence rather than an empty terminal when no session was addressed. It
// folds the lease from the session store's own timeline, so the holder on screen is
// the one the log named. And it mounts the emulator anyway, above a line that says
// in words that no output stream is registered — the state that would otherwise
// read as "the shell printed nothing".
//
// The store is a real `SessionStore` fed the terminal scenario's own beats, because
// a hand-built timeline would let the pane pass against events the fixture does not
// produce.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { TERMINAL_SCENARIO } from "../../bridge/scenarios/terminal.js";
import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { TerminalPane } from "./TerminalPane.js";

const SESSION_ID = TERMINAL_SCENARIO.sessionId;

function bridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: TERMINAL_SCENARIO });
}

const LEASE_EVENT_KIND = "pty.control_changed";

/** Every lease transition the scenario scripts, in the order it scripts them. */
const leaseBeats = TERMINAL_SCENARIO.beats.filter((beat) => beat.event.kind === LEASE_EVENT_KIND);

/**
 * A store holding the scenario's events through its `transitionOrdinal`-th lease
 * transition — 1 for the first, and so on.
 *
 * Addressed by ORDINAL rather than by sequence number, because the scenario is a
 * sibling lane's file and its numbering moves when a beat is inserted ahead of a
 * transition. What this pane's cases are about is the state after the first take,
 * after the release that follows it, and after all of them — none of which is a
 * claim about which sequence number those land on.
 *
 * The beats are applied directly rather than played through the engine's clock:
 * this file's subject is what the pane renders for a given log, and waiting on a
 * timer would make every case a race without making any of them truer.
 */
function storeThrough(transitionOrdinal: number): SessionStore {
  const lastLeaseBeat = leaseBeats[transitionOrdinal - 1];
  if (lastLeaseBeat === undefined) {
    throw new Error(
      `the terminal scenario scripts ${String(leaseBeats.length)} lease transitions, not ${String(transitionOrdinal)}`,
    );
  }
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const events = TERMINAL_SCENARIO.beats
    .map((beat) => beat.event as ConsoleSessionEvent)
    .filter((event) => event.sequence <= lastLeaseBeat.event.sequence);
  store.applyBatch(events);
  return store;
}

function renderPane(sessionStore: SessionStore | undefined): HTMLElement {
  const { container } = render(
    <TerminalPane paneId="pane-terminal" bridge={bridge()} sessionStore={sessionStore} />,
  );
  const region = container.querySelector("section");
  if (!(region instanceof HTMLElement)) {
    throw new Error("TerminalPane rendered no region");
  }
  return region;
}

describe("terminal pane — a pane opened without a session", () => {
  it("names itself, so the pane is reachable by name", () => {
    expect(renderPane(undefined).getAttribute("aria-label")).toBe("Terminal");
  });

  it("says it is unbound rather than showing a terminal that belongs to nobody", () => {
    const region = renderPane(undefined);
    const absence = region.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    expect(absence?.className).toContain("meridian-nothing--block");
    expect(region.textContent).toContain("not bound to a session");
    // Not "this session has no terminal", which is a claim about a session the
    // pane was never given.
    expect(region.textContent).toContain("only that none was addressed");
  });

  it("mounts no emulator it has no session to address", () => {
    expect(renderPane(undefined).querySelector(".meridian-terminal-host")).toBeNull();
  });
});

describe("terminal pane — bound to a session", () => {
  it("folds the holder off the log rather than off a claim", () => {
    // Through the first transition: a `taken` by the first participant to join.
    const region = renderPane(storeThrough(1));
    expect(region.textContent).toContain("Held by");
    expect(region.textContent).toContain(TERMINAL_SCENARIO.participantIdsInJoinOrder[0]);
  });

  it("renders the free lease the log's next transition establishes", () => {
    // The second transition is a `released` carrying an explicit null holder.
    const region = renderPane(storeThrough(2));
    expect(region.textContent).toContain("Free");
    expect(region.textContent).toContain("Nobody holds the shell.");
  });

  it("counts every transition the log carries", () => {
    const disclosure = renderPane(storeThrough(leaseBeats.length)).querySelector(
      ".meridian-lease-line__disclosure",
    );
    // Counted off the scenario rather than written down: the fold's count is the
    // claim, and a number typed here would only restate the fixture.
    expect(leaseBeats.length).toBeGreaterThan(0);
    expect(disclosure?.textContent).toContain(String(leaseBeats.length));
  });

  it("shows the viewer no keyboard, because no read says who the viewer is", () => {
    const region = renderPane(storeThrough(1));
    const host = region.querySelector(".meridian-terminal-host");
    // Fail-closed: a lease held by someone is somebody else's until a read says
    // otherwise, and the write gate follows that rather than the other way round.
    expect(host?.getAttribute("data-write-enabled")).toBe("false");
    expect(region.textContent).not.toContain("You may type into the shared shell.");
  });

  it("mounts the emulator and says in words that no output stream is registered", async () => {
    const region = renderPane(storeThrough(1));
    expect(region.querySelector(".meridian-terminal-host")).not.toBeNull();
    await waitFor(() => {
      expect(region.textContent).toContain("No output stream");
    });
    // The refusal carried is the port's own: it names the wire that is missing and
    // the document that owes it, rather than a sentence this pane wrote.
    expect(region.textContent).toContain("terminal pane as a renderer surface");
    expect(region.textContent).toContain("Spec-003");
  });

  it("negative control: it does not render the absence that would look finished", () => {
    const region = renderPane(storeThrough(1));
    const absences = [...region.querySelectorAll(".meridian-nothing")];
    expect(absences.length).toBeGreaterThan(0);
    for (const absence of absences) {
      // `empty` would say the shell printed nothing and the roster is read. Both
      // are claims this pane has no read behind.
      expect(absence.className).not.toContain("meridian-nothing--empty");
    }
  });
});
