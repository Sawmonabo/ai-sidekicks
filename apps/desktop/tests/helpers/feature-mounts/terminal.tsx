// The terminal pane, mounted once for the screenshot and accessibility tiers.
//
// The body comes out of a pane registry the terminal feature registers into, and the
// store is fed the terminal-lease scenario's beats verbatim, so the lease reading on
// screen is the fixture's rather than this file's.

import { waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";

import { registerTerminalPane } from "@renderer/features/terminal/contributions/panes.js";
import { type PaneContext } from "@renderer/console/seats/index.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { fixtureSessionSnapshot } from "@renderer/services/daemon/session-snapshot.fixture.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { TERMINAL_LEASE_SCENARIO } from "../../../fixtures/scenarios/terminal-lease.js";
import { renderSettled } from "../app-harness.js";
import { type MountedView, paneTrailName, requireLabeledRegion } from "./mount-queries.js";
import { paneBinding, resolvedPaneBody } from "./pane-body-resolution.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";

/**
 * How long the emulator's chunk may take to arrive.
 *
 * Above Testing Library's one-second default because the first mount in a file pays for
 * the whole `@xterm/xterm` chunk, compiled on demand by the dev server, while every later
 * one reads the loader's memo.
 */
const EMULATOR_CHUNK_TIMEOUT_MS = 20_000;

/**
 * A store holding every beat the terminal-lease scenario scripts, opened from the
 * scenario's own base state and with the fold a window composes: a store built without
 * projectors folds the scenario's `run.*` beats into no entity at all.
 */
function terminalSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: TERMINAL_LEASE_SCENARIO.sessionId,
    projectors: COMPOSED_ENTITY_PROJECTORS,
  });
  store.initialize(
    fixtureSessionSnapshot(TERMINAL_LEASE_SCENARIO, TERMINAL_LEASE_SCENARIO.sessionId),
  );
  store.applyBatch(
    TERMINAL_LEASE_SCENARIO.beats.map((beat) => beat.event as ProjectedSessionEvent),
  );
  return store;
}

/**
 * The terminal pane, mounted and waited on until the emulator's chunk has landed.
 *
 * The emulator is reached across an `import()`, so a tier that read the tree straight
 * after the mount would be looking at the not-loaded absence rather than at the grid.
 */
export async function mountTerminalPane(): Promise<MountedView> {
  const bridge = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO });
  const TerminalPaneBody: FunctionComponent<PaneContext> = await resolvedPaneBody(
    "terminal",
    registerTerminalPane,
  );
  const { container } = await renderSettled(
    <TerminalPaneBody
      kind="terminal"
      {...paneBinding({
        paneId: "pane-terminal-surface",
        bridge,
        sessionStore: terminalSessionStore(),
      })}
    />,
  );
  const region = requireLabeledRegion(
    container,
    paneTrailName(TERMINAL_LEASE_SCENARIO.sessionId, "Terminal"),
  );
  // Not inside `act`: the chunk resolves in a promise React knows nothing about, and an
  // `act` scope holds the resulting commit back until it exits.
  await waitFor(
    () => {
      if (region.querySelector(".meridian-terminal-host__surface") === null) {
        throw new Error("the terminal emulator has not mounted yet");
      }
    },
    { timeout: EMULATOR_CHUNK_TIMEOUT_MS },
  );
  return { element: region, bridge };
}
