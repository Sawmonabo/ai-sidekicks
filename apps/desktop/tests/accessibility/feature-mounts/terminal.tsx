// The terminal pane mounted for the accessibility tier, with its store fed the terminal-lease
// scenario's beats so the lease reading is the fixture's.

import { waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";

import { registerTerminalPane } from "#renderer/features/terminal/contributions/panes.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { fixtureSessionBaseState } from "#renderer/services/daemon/session/base-state.fixture.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { TERMINAL_LEASE_SCENARIO } from "#fixtures/scenarios/terminal-lease.js";
import { renderSettled } from "../../helpers/app/harness.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { type MountedView, paneTrailName, requireLabeledRegion } from "./queries.js";
import { paneContext } from "../../helpers/pane-context.js";
import { resolvedPaneBody } from "./pane-body-resolution.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";

/**
 * How long the emulator's chunk may take to arrive. Above Testing Library's default because the
 * first mount in a file pays for the whole `@xterm/xterm` chunk, compiled on demand by the dev
 * server.
 */
const EMULATOR_CHUNK_TIMEOUT_MS = 20_000;

/**
 * A store holding every beat of the terminal-lease scenario, with the fold a window composes;
 * without projectors the scenario's `run.*` beats fold into no entity.
 */
function terminalSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: TERMINAL_LEASE_SCENARIO.sessionId,
    projectors: COMPOSED_ENTITY_PROJECTORS,
  });
  store.initialize(
    fixtureSessionBaseState(TERMINAL_LEASE_SCENARIO, TERMINAL_LEASE_SCENARIO.sessionId),
  );
  store.applyBatch(
    TERMINAL_LEASE_SCENARIO.beats.map((beat) => beat.event as ProjectedSessionEvent),
  );
  return store;
}

/**
 * The terminal pane, mounted and waited on until the emulator's chunk has landed and its renderer
 * has settled. The emulator loads through `import()`, so an early read would see the not-loaded
 * absence, not the grid; the renderer reports its mode once it attaches, a state change of its own.
 */
export async function mountTerminalPane(): Promise<MountedView> {
  const { bridge } = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO });
  const TerminalPaneBody: FunctionComponent<PaneContext> = await resolvedPaneBody(
    "terminal",
    registerTerminalPane,
  );
  const { container } = await renderSettled(
    <LiveAnnouncerProvider>
      <TerminalPaneBody
        {...paneContext(
          { kind: "terminal" },
          { paneId: "pane-terminal", bridge, sessionStore: terminalSessionStore() },
        )}
      />
    </LiveAnnouncerProvider>,
  );
  const region = requireLabeledRegion(
    container,
    paneTrailName(TERMINAL_LEASE_SCENARIO.sessionId, "Terminal"),
  );
  // Outside `act`: the chunk resolves in a promise React cannot see, and `act` would hold the
  // resulting commit back until it exits.
  await waitFor(
    () => {
      if (region.querySelector(".meridian-terminal-mount-point__mount-element") === null) {
        throw new Error("the terminal emulator has not mounted yet");
      }
      if (
        region.querySelector('.meridian-terminal-mount-point[data-renderer="pending"]') !== null
      ) {
        throw new Error("the terminal emulator's renderer has not settled yet");
      }
    },
    { timeout: EMULATOR_CHUNK_TIMEOUT_MS },
  );
  return { element: region, bridge };
}
