// What the terminal suites share: the context the pane layout hands the terminal pane, for the
// browser-tier suites that mount the pane inside a sized box, and the bridge the hook suites
// scope their state to.

import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { TERMINAL_LEASE_SCENARIO } from "@fixtures/scenarios/terminal-lease.js";
import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { paneContext } from "@test/helpers/pane-context.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";

/**
 * The context over the shared builder. `terminal` is session-scoped, so its address carries no
 * `entity`.
 */
export function terminalPaneContext(
  sessionStore: SessionStore | undefined,
  bridge: PlatformBridge,
): PaneContextOf<"terminal"> {
  return paneContext({ kind: "terminal" }, { bridge, sessionStore });
}

/** A fresh fixture bridge over the terminal lease scenario, one per case. */
export function terminalFixtureBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO }).bridge;
}
