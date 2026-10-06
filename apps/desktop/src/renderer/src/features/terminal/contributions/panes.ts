// The terminal's pane registration: one kind, loaded as its own chunk.

import type { PaneRegistry } from "#renderer/registries/panes/registry.js";

/** Registers the terminal pane kind; a session has one terminal pane, so a second claim errors. */
export function registerTerminalPane(registry: PaneRegistry): void {
  registry.register({
    kind: "terminal",
    owner: "terminal",
    // A loader, so a session that never opens a terminal does not carry the pane, the lease
    // line, or their styles.
    body: () => import("../pane/body.js"),
  });
}
