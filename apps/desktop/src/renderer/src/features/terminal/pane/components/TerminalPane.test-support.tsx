// Shared stores and bridges for the pane suites: a real `SessionStore` fed the terminal
// scenario's own beats, so the pane is never tested against events the fixture does not produce.

import { PTY_CONTROL_CHANGED_EVENT } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { fixtureSessionSnapshot } from "@renderer/services/daemon/session-snapshot.fixture.js";
import { TERMINAL_LEASE_SCENARIO } from "../../../../../../../fixtures/scenarios/terminal-lease.js";
import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { paneContext } from "@renderer/registries/panes/pane-context.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { TerminalPane } from "./TerminalPane.js";

/** The terminal scenario's session id. */
export const SESSION_ID: string = TERMINAL_LEASE_SCENARIO.sessionId;

/** The fixture bridge every suite starts from. */
export function paneBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO }).bridge;
}

/** Every lease transition the scenario scripts, in the order it scripts them. */
export const leaseBeats: readonly (typeof TERMINAL_LEASE_SCENARIO.beats)[number][] =
  TERMINAL_LEASE_SCENARIO.beats.filter((beat) => beat.event.kind === PTY_CONTROL_CHANGED_EVENT);

/**
 * A store holding the scenario's events through its `transitionOrdinal`-th lease transition
 * (1 for the first).
 *
 * Addressed by ordinal rather than sequence number so inserting a beat ahead of a transition
 * does not move what a case means. The beats are applied directly, not through the engine's
 * clock, which would make every case a race.
 */
export function storeThrough(transitionOrdinal: number): SessionStore {
  const lastLeaseBeat = leaseBeats[transitionOrdinal - 1];
  if (lastLeaseBeat === undefined) {
    throw new Error(
      `the terminal scenario scripts ${String(leaseBeats.length)} lease transitions, not ${String(transitionOrdinal)}`,
    );
  }
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize(fixtureSessionSnapshot(TERMINAL_LEASE_SCENARIO, SESSION_ID));
  const events = TERMINAL_LEASE_SCENARIO.beats
    .map((beat) => beat.event as ProjectedSessionEvent)
    .filter((event) => event.sequence <= lastLeaseBeat.event.sequence);
  store.applyBatch(events);
  return store;
}

/**
 * The pane's `section` region, or a throw. The query stays on the element because the chrome
 * names a pane by its whole address trail, which differs between suites.
 */
export function paneRegionOf(container: HTMLElement): HTMLElement {
  const region = container.querySelector("section");
  if (!(region instanceof HTMLElement)) {
    throw new Error("TerminalPane rendered no region");
  }
  return region;
}

/**
 * The context the pane layout hands this pane, over the shared builder. Exported because the
 * browser-tier suites mount the pane themselves inside a sized box. `terminal` is
 * session-scoped, so its address carries no `entity`.
 */
export function terminalPaneContext(
  sessionStore: SessionStore | undefined,
  consoleBridge: PlatformBridge = paneBridge(),
): PaneContextOf<"terminal"> {
  return paneContext({ kind: "terminal" }, { bridge: consoleBridge, sessionStore });
}

/** Mount the pane over the store and return its region. */
export function renderPane(
  sessionStore: SessionStore | undefined,
  consoleBridge: PlatformBridge = paneBridge(),
): HTMLElement {
  const { container } = render(
    <TerminalPane {...terminalPaneContext(sessionStore, consoleBridge)} />,
  );
  return paneRegionOf(container);
}
