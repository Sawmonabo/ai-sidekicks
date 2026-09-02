// The terminal family's door.
//
// The family owns the session's one shared shell: the emulator wrapper, the watch
// mode every non-holder gets, the lease line, and the transition ledger. What it
// owns TODAY is the pane's seat on the deck — the rest is built once
// `Plan-023 §Console growth slate` row 3 leaves the slate and `Spec-003`'s renderer
// obligations are registered, and the shell it is built into is registered here so
// that arrival is an edit to a mounted pane rather than a new mount.
//
// The registration lives in the family rather than in `console/panes/terminal/`
// for `console/browser/index.ts`'s reason: the seat board composes families, not
// bodies.

import type { ConsolePaneRegistry } from "../workspace/index.js";
import { TERMINAL_PANE_DESCRIPTOR } from "../panes/terminal/index.js";

/**
 * Claim the terminal family's pane kinds.
 *
 * One kind, and structurally one: `Spec-023 §Console Design (Meridian)` 8.8 gives
 * V1 exactly one terminal surface per session, and the deck's single mount door
 * makes a second claim on this kind an error rather than a swap.
 */
export function registerTerminalPanes(registry: ConsolePaneRegistry): void {
  registry.register(TERMINAL_PANE_DESCRIPTOR);
}
