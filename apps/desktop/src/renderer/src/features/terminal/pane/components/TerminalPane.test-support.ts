// The context the pane layout hands the terminal pane, for the browser-tier suites that mount the
// pane themselves inside a sized box.

import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { TERMINAL_LEASE_SCENARIO } from "../../../../../../../fixtures/scenarios/terminal-lease.js";
import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { paneContext } from "@renderer/registries/panes/pane-context.test-support.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";

/**
 * The context over the shared builder. `terminal` is session-scoped, so its address carries no
 * `entity`.
 */
export function terminalPaneContext(
  sessionStore: SessionStore | undefined,
  consoleBridge: PlatformBridge = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO }).bridge,
): PaneContextOf<"terminal"> {
  return paneContext({ kind: "terminal" }, { bridge: consoleBridge, sessionStore });
}
