// The stores and bridges the pane's suites share: a real `SessionStore` fed the terminal
// scenario's own beats, so the pane is never tested against events the fixture does not
// produce.

import { render } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { fixtureSessionSnapshot } from "@renderer/services/daemon/session-snapshot.fixture.js";
import { TERMINAL_SCENARIO } from "../../../../../../../fixtures/scenarios/terminal-lease.js";
import type { PaneContextOf } from "@renderer/console/seats/index.js";
import { paneContext } from "@renderer/registries/panes/pane-context.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { TerminalPane } from "./TerminalPane.js";

/** The terminal scenario's session id. */
export const SESSION_ID: string = TERMINAL_SCENARIO.sessionId;

/** The fixture bridge every suite starts from. */
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
  store.initialize(fixtureSessionSnapshot(TERMINAL_SCENARIO, SESSION_ID));
  const events = TERMINAL_SCENARIO.beats
    .map((beat) => beat.event as ProjectedSessionEvent)
    .filter((event) => event.sequence <= lastLeaseBeat.event.sequence);
  store.applyBatch(events);
  return store;
}

/**
 * The pane's region, or a raise. One reader, because three suites reach for it.
 *
 * The section is `seats/PaneFrame`'s now, so the query stays on the element
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

/**
 * The context the deck hands this pane, over the shared builder.
 *
 * Exported because two suites outside this module mount the pane themselves rather
 * than through `renderPane`: the browser tier's box measurement and its deck fill
 * check, which mount the pane inside a sized slot.
 *
 * The address arm carries no `entity` member: `terminal` is session-scoped, so the
 * union's arm has none and the seat refuses one at this call site. The pane id is the
 * seat's own derivation — `pane-terminal` — because no case here is about which pane
 * this is.
 */
export function terminalPaneContext(
  sessionStore: SessionStore | undefined,
  consoleBridge: ConsoleBridge = paneBridge(),
): PaneContextOf<"terminal"> {
  return paneContext({ kind: "terminal" }, { bridge: consoleBridge, sessionStore });
}

/** Mount the pane over the store and return its region. */
export function renderPane(
  sessionStore: SessionStore | undefined,
  consoleBridge: ConsoleBridge = paneBridge(),
): HTMLElement {
  const { container } = render(
    <TerminalPane {...terminalPaneContext(sessionStore, consoleBridge)} />,
  );
  return paneRegionOf(container);
}
