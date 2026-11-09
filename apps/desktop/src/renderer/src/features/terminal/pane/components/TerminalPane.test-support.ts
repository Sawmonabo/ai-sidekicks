// What the terminal suites share: the context the pane layout hands the terminal pane, for the
// browser-tier suites that mount the pane inside a sized box.

import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { PaneContextOf } from "#renderer/registries/panes/body-for-kind.js";
import { paneContext } from "#test/helpers/pane-context.js";
import type { SessionStore } from "#renderer/store/session/store.js";

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
