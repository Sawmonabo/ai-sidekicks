// The pane: bound to a session or honestly not, the lease folded from the log, and
// an emulator mounted with nothing to show.
//
// WHAT EARNS A TEST HERE. The pieces have their own files — the fold, the line, the
// emulator — so this one owns the four decisions the PANE makes. It renders the
// unbound absence rather than an empty terminal when no session was addressed. It
// folds the lease from the session store's own timeline, so the holder on screen is
// the one the log named. It folds the HOST's reported reachability off that same
// timeline and hands it to the lease fold, which is the only way 8.8's degraded
// state is reachable from the wire — and it hands nothing over where the log names
// more than one host, because the wire links no holder to a machine. And it mounts
// the emulator anyway, above a line that says in words that no output stream is
// registered — the state that would otherwise read as "the shell printed nothing".
//
// The store is a real `SessionStore` fed the terminal scenario's own beats, because
// a hand-built timeline would let the pane pass against events the fixture does not
// produce.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { TERMINAL_SCENARIO, TERMINAL_SCENARIO_CAST } from "../../bridge/scenarios/terminal.js";
import { TERMINAL_HOST_NODE_ID } from "../../bridge/scenarios/terminal-cast.js";
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

/**
 * A bridge whose output subscribe REJECTS with whatever the caller hands it.
 *
 * `LeaseLine.test.tsx`'s shape, applied to the other bridge-facing read on this
 * pane. The growth port ANSWERS a refusal, so a rejection means the bridge itself
 * failed — and the standard wire envelope is what a failing bridge sends across
 * the preload boundary (`src/shared/wire-errors.ts` owns that shape).
 */
/**
 * A store holding EVERY beat the scenario scripts, degraded final beat included.
 *
 * `storeThrough` stops at a lease transition, and the scenario's last beat is not
 * one — the host goes silent after the final take, authoring no `pty.control_changed`
 * because a roster read transitions nothing. So the frame the screenshot tier pins,
 * and the frame the degraded cases below are about, is reachable only from the whole
 * script.
 */
function storeThroughEveryBeat(extraEvents: readonly ConsoleSessionEvent[] = []): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const scripted = TERMINAL_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent);
  store.applyBatch([...scripted, ...extraEvents]);
  return store;
}

/**
 * A second host attaching after everything the script plays.
 *
 * The registered lifecycle payload and nothing more: the node and the state it moved
 * to. Its sequence follows the script's own last beat, so the store admits it in log
 * order rather than as a gap.
 */
function secondNodeOnlineEvent(): ConsoleSessionEvent {
  const lastScripted = TERMINAL_SCENARIO.beats.at(-1);
  if (lastScripted === undefined) {
    throw new Error("the terminal scenario scripts no beats");
  }
  return {
    sessionId: SESSION_ID,
    sequence: lastScripted.event.sequence + 1,
    kind: "runtime_node.online",
    occurredAt: "2026-01-01T16:40:06.000Z",
    payload: { sessionId: SESSION_ID, nodeId: SECOND_NODE_ID, newState: "online" },
  };
}

/** A host the scenario does not script, so the session reads as attaching two. */
const SECOND_NODE_ID = "node-laptop";

function bridgeRejectingOutputWith(rejection: unknown): ConsoleBridge {
  const base = bridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      terminalSubscribeOutput: () => Promise.reject(rejection),
    },
  };
}

function renderPane(
  sessionStore: SessionStore | undefined,
  consoleBridge: ConsoleBridge = bridge(),
): HTMLElement {
  const { container } = render(
    <TerminalPane paneId="pane-terminal" bridge={consoleBridge} sessionStore={sessionStore} />,
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
    // The owner by ROLE rather than by position in the join log: the assertion is
    // that the pane shows the participant the log's first `taken` named, and a
    // beat inserted ahead of that one would silently move an index.
    expect(region.textContent).toContain(TERMINAL_SCENARIO_CAST.owner);
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
    // The refusal carried is the port's own: it names the wire that is missing
    // rather than a sentence this pane wrote — and never the governance document
    // that owes it, which is ledger data and not product vocabulary.
    expect(region.textContent).toContain("terminal pane as a renderer surface");
    expect(region.textContent).toContain("not registered on this build yet");
    expect(region.textContent).not.toContain("Spec-003");
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

describe("terminal pane — the host's reported reachability", () => {
  it("degrades to unheld and read-only when the log says the one host went silent", () => {
    // The whole script: a take, and then the host that was running the shell going
    // offline with no lease transition to follow it. On the fold that passed no
    // reachability at all this frame still read "Held by <owner>" over a surface
    // with nothing to say about the machine.
    const region = renderPane(storeThroughEveryBeat());
    expect(region.textContent).toContain("Free");
    expect(region.textContent).toContain("Nobody holds the shell.");
    expect(region.textContent).not.toContain("Held by");
    // The node named, so a person is sent to the right machine.
    expect(region.textContent).toContain(TERMINAL_HOST_NODE_ID);
    expect(region.textContent).toContain("reads as free and stays read-only");
    expect(
      region.querySelector(".meridian-terminal-host")?.getAttribute("data-write-enabled"),
    ).toBe("false");
  });

  it("says nothing about a host's health while the log's one host is still reporting", () => {
    // The same fold one beat earlier. Without this the case above would pass
    // against a pane that reported every session degraded.
    const region = renderPane(storeThrough(leaseBeats.length));
    expect(region.textContent).toContain("Held by");
    expect(region.textContent).not.toContain("reads as free and stays read-only");
    expect(region.textContent).not.toContain("Node health not read");
  });

  it("checks nothing when the log names two hosts, and still shows the log's holder", () => {
    // The wire carries no link from a lease holder to the machine it sits on, so a
    // second attached node makes the question unanswerable. A pane that picked the
    // offline one — or the first one — would degrade this frame and would be
    // guessing; the honest answer is that nothing was checked.
    const region = renderPane(storeThroughEveryBeat([secondNodeOnlineEvent()]));
    expect(region.textContent).toContain("Held by");
    expect(region.textContent).toContain(TERMINAL_SCENARIO_CAST.owner);
    expect(region.textContent).toContain("Node health not read");
    expect(region.textContent).not.toContain("reads as free and stays read-only");
  });
});

describe("terminal pane — a rejected output subscribe keeps its diagnosis", () => {
  it("renders the wire's own code when the subscribe REJECTED rather than refused", async () => {
    const region = renderPane(
      storeThrough(1),
      bridgeRejectingOutputWith({
        code: "permission_denied",
        message: "You may not watch this session's shell.",
      }),
    );
    await waitFor(() => {
      expect(region.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    // The half a person acts on. The old arm reduced this to a generic title with
    // the envelope serialized into the detail, so a denied permission and a torn
    // transport read the same.
    expect(region.textContent).toContain("permission_denied");
    expect(region.textContent).toContain("You may not watch this session's shell.");
    expect(region.textContent).not.toContain("could not be reached");
  });

  it("names the next move when the rejection carried no code of its own", async () => {
    const region = renderPane(
      storeThrough(1),
      bridgeRejectingOutputWith(new Error("the preload went away")),
    );
    await waitFor(() => {
      expect(region.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    // The normalizer's fourth arm, and the only one this pane's fallback reaches:
    // a rejection with nothing to say gets a sentence that says what to do.
    expect(region.textContent).toContain("terminal-output-unreachable");
    expect(region.textContent).toContain("Reopening this pane asks again.");
  });

  it("negative control: the refusal displaces the absence rather than joining it", async () => {
    // Without this the cases above would pass against a pane that rendered both,
    // leaving "No output stream" on screen beside a refusal that contradicts it.
    const region = renderPane(
      storeThrough(1),
      bridgeRejectingOutputWith({ code: "permission_denied", message: "no" }),
    );
    await waitFor(() => {
      expect(region.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(region.textContent).not.toContain("No output stream");
    expect(region.textContent).not.toContain("Asking for the output stream");
  });

  it("negative control: the served-and-refused paths still render an absence", async () => {
    // And without this the cases above would pass against a pane that had turned
    // every output reading into a refusal, which would make the port's own typed
    // absence unreachable.
    const region = renderPane(storeThrough(1));
    await waitFor(() => {
      expect(region.textContent).toContain("No output stream");
    });
    expect(region.querySelector(".meridian-refusal--inline")).toBeNull();
  });
});
