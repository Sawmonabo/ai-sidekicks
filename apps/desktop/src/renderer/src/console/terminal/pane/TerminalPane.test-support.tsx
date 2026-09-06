// The stores, bridges, and readers the pane's five suites share.
//
// The pane composes four modules — the session binding, the lease fold, the host's
// reported reachability, and the output subscription — and each has its own suite
// beside the module it is about. What they have in common is the SETUP: a real
// `SessionStore` fed the terminal scenario's own beats, and a fixture bridge with one
// growth read swapped. A hand-built timeline would let the pane pass against events
// the fixture does not produce, and five copies of the store builder would drift into
// five slightly different logs.

import { render } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { fixtureSessionSnapshot } from "../../bridge/fixture/fixture-session-snapshot.js";
import { growthUnavailable } from "../../bridge/growth-port/growth-port.js";
import { TERMINAL_SCENARIO } from "../../bridge/scenarios/terminal.js";
import { terminalScenarioEventId } from "../../bridge/scenarios/terminal-beats.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../core/index.js";
import { DraftStore, UiStateStore } from "../../persistence/index.js";
import type { PaneContextOf } from "../../seats/index.js";
import { FrameStore, SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { TerminalPane } from "./TerminalPane.js";

export const SESSION_ID: string = TERMINAL_SCENARIO.sessionId;

/** The fixture bridge every suite starts from, before it swaps one growth read. */
export function paneBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: TERMINAL_SCENARIO });
}

const LEASE_EVENT_KIND = "pty.control_changed";

/** Every lease transition the scenario scripts, in the order it scripts them. */
export const leaseBeats: readonly (typeof TERMINAL_SCENARIO.beats)[number][] =
  TERMINAL_SCENARIO.beats.filter((beat) => beat.event.kind === LEASE_EVENT_KIND);

/**
 * A store holding the scenario's events through its `transitionOrdinal`-th lease
 * transition — 1 for the first, and so on.
 *
 * Addressed by ORDINAL rather than by sequence number, because the scenario is a
 * sibling lane's file and its numbering moves when a beat is inserted ahead of a
 * transition. What the pane's cases are about is the state after the first take,
 * after the release that follows it, and after all of them — none of which is a
 * claim about which sequence number those land on.
 *
 * The beats are applied directly rather than played through the engine's clock: the
 * subject is what the pane renders for a given log, and waiting on a timer would make
 * every case a race without making any of them truer.
 */
export function storeThrough(transitionOrdinal: number): SessionStore {
  const lastLeaseBeat = leaseBeats[transitionOrdinal - 1];
  if (lastLeaseBeat === undefined) {
    throw new Error(
      `the terminal scenario scripts ${String(leaseBeats.length)} lease transitions, not ${String(transitionOrdinal)}`,
    );
  }
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise(fixtureSessionSnapshot(TERMINAL_SCENARIO, SESSION_ID));
  const events = TERMINAL_SCENARIO.beats
    .map((beat) => beat.event as ConsoleSessionEvent)
    .filter((event) => event.sequence <= lastLeaseBeat.event.sequence);
  store.applyBatch(events);
  return store;
}

/**
 * A store holding EVERY beat the scenario scripts, degraded final beat included.
 *
 * `storeThrough` stops at a lease transition, and the scenario's last beat is not
 * one — the host goes silent after the final take, authoring no `pty.control_changed`
 * because a roster read transitions nothing. So the frame the screenshot tier pins,
 * and the frame the degraded cases are about, is reachable only from the whole script.
 */
export function storeThroughEveryBeat(
  extraEvents: readonly ConsoleSessionEvent[] = [],
): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise(fixtureSessionSnapshot(TERMINAL_SCENARIO, SESSION_ID));
  const scripted = TERMINAL_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent);
  store.applyBatch([...scripted, ...extraEvents]);
  return store;
}

/** A host the scenario does not script, so the session reads as attaching two. */
const SECOND_NODE_ID = "node-laptop";

/**
 * A second host attaching after everything the script plays.
 *
 * The registered lifecycle payload and nothing more: the node and the state it moved
 * to. Its sequence follows the script's own last beat, so the store admits it in log
 * order rather than as a gap.
 */
export function secondNodeOnlineEvent(): ConsoleSessionEvent {
  const lastScripted = TERMINAL_SCENARIO.beats.at(-1);
  if (lastScripted === undefined) {
    throw new Error("the terminal scenario scripts no beats");
  }
  const sequence = lastScripted.event.sequence + 1;
  return {
    id: terminalScenarioEventId(sequence),
    sessionId: SESSION_ID,
    sequence,
    kind: "runtime_node.online",
    occurredAt: "2026-01-01T16:40:06.000Z",
    payload: { sessionId: SESSION_ID, nodeId: SECOND_NODE_ID, newState: "online" },
  };
}

/**
 * A bridge whose output subscribe REJECTS with whatever the caller hands it.
 *
 * `LeaseLine.test-support.tsx`'s shape, applied to the other bridge-facing read on
 * this pane. The growth port ANSWERS a refusal, so a rejection means the bridge itself
 * failed — and the standard wire envelope is what a failing bridge sends across the
 * preload boundary (`src/shared/wire-errors.ts` owns that shape).
 */
export function bridgeRejectingOutputWith(rejection: unknown): ConsoleBridge {
  const base = paneBridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      terminalSubscribeOutput: () => Promise.reject(rejection),
    },
  };
}

/**
 * A bridge that answers the caller-identity read with one of the cast.
 *
 * The scenario names the owner as its viewer, but a case that depends on WHO is
 * looking says so itself rather than inheriting it: the three arms the lease fold can
 * reach — the claimant's own hold, somebody else's, and no identity at all — are each
 * chosen by the case, so a scenario edit cannot silently move one onto a different arm
 * than the one its name claims.
 */
export function bridgeAnsweringCallerWith(participantId: string): ConsoleBridge {
  const base = paneBridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      callerParticipantRead: async () => ({
        status: "served" as const,
        value: { participantId },
      }),
    },
  };
}

/**
 * A bridge whose caller-identity read is refused — the port's own "not checked"
 * refusal, taken through the same constructor the fixture port uses when a scenario
 * has named no viewer, so the sentences the cases assert are the wire's and not a copy
 * that could drift from it.
 */
export function bridgeRefusingCaller(): ConsoleBridge {
  const base = paneBridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      callerParticipantRead: async () => growthUnavailable("callerParticipantRead"),
    },
  };
}

/**
 * The output line's refusal, told from the lease line's own.
 *
 * Both render through the same inline primitive, and the pane has two reads that can
 * refuse — the output stream and the caller's identity. A bare class query would match
 * whichever landed first, so every output case scopes itself OUT of the lease line
 * rather than asserting on a count.
 */
export function outputRefusal(region: HTMLElement): Element | null {
  return (
    [...region.querySelectorAll(".meridian-refusal--inline")].find(
      (refusal) => refusal.closest(".meridian-lease-line") === null,
    ) ?? null
  );
}

/**
 * The pane's region, or a raise. One reader, because three suites reach for it.
 *
 * The section is `seats/ConsolePaneChrome`'s now, so the query stays on the element
 * rather than moving to an accessible name: the chrome names a pane by its whole
 * address trail, and a suite mounting the pane with no session and one with a session
 * would then be looking the region up under two different names for the same reason
 * they mount it — which is not what any of them is about.
 */
export function paneRegionOf(container: HTMLElement): HTMLElement {
  const region = container.querySelector("section");
  if (!(region instanceof HTMLElement)) {
    throw new Error("TerminalPane rendered no region");
  }
  return region;
}

/** The pane a suite mounts under when which pane it is is not the subject. */
const DEFAULT_TEST_PANE_ID = "pane-terminal";

/**
 * The context the deck hands this pane, built once for every suite that mounts it.
 *
 * Exported because two suites outside this module mount the pane themselves rather
 * than through `renderPane` — the output subscription's rebind cases, which need the
 * `rerender` this function does not hand back, and the browser tier's box measurement,
 * which mounts the pane inside a sized slot — and a per-suite copy would be a second
 * answer to which members the `terminal` arm carries.
 */
export function terminalPaneContext(
  sessionStore: SessionStore | undefined,
  consoleBridge: ConsoleBridge = paneBridge(),
): PaneContextOf<"terminal"> {
  return {
    // No `entity` member at all: the `terminal` address is session-scoped, so the
    // kind's arm of the union carries none and an `undefined` one would be a
    // reference this pane is documented never to be a view of.
    kind: "terminal",
    paneId: DEFAULT_TEST_PANE_ID,
    bridge: consoleBridge,
    frameStore: new FrameStore(),
    sessionStore,
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    linkedSourcePaneId: undefined,
    focusHue: undefined,
  };
}

export function renderPane(
  sessionStore: SessionStore | undefined,
  consoleBridge: ConsoleBridge = paneBridge(),
): HTMLElement {
  const { container } = render(
    <TerminalPane {...terminalPaneContext(sessionStore, consoleBridge)} />,
  );
  return paneRegionOf(container);
}
