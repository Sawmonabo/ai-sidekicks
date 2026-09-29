// The terminal's pane registration: one kind, loaded as its own chunk.

import type { PaneRegistry } from "@renderer/console/seats/index.js";

/**
 * Claim the terminal family's pane kinds.
 *
 * One kind, and structurally one: a session has exactly one terminal surface, and the
 * pane layout's single mount door makes a second claim on this kind an error rather than a
 * swap.
 */
export function registerTerminalPane(registry: PaneRegistry): void {
  registry.register({
    kind: "terminal",
    owner: "terminal",
    // A loader, for `browser/index.ts`'s reason. The emulator was already a lazy chunk
    // of its own and everything around it was not, so a session that never opens a
    // terminal still carried the pane, the lease line, and their rules.
    body: () => import("../pane/terminal-pane-body.js"),
  });
}
