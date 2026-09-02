// The terminal family's door.
//
// The family owns the session's one shared shell: the emulator wrapper, the watch
// mode every non-holder gets, the lease line, and the transition ledger. All four
// are built. What is NOT built is the OUTPUT — the byte stream, the scrollback,
// and the resize report are `Plan-023 §Console growth slate` row 3, which the
// growth port refuses by name — so the pane mounts a real emulator with nothing
// to show and says so, and the row's arrival is a drain into a surface that is
// already there rather than a new mount.
//
// The registration lives in the family rather than in `console/panes/terminal/`
// for `console/browser/index.ts`'s reason: the seat board composes families, not
// bodies.
//
// WHAT THE FAMILY OWNS TODAY, after T-023p-1C-7: its named bounds
// (`constants.ts`), the emulator wrapper (`xterm-adapter.ts`), the page-wide WebGL
// slot allocator (`renderer-pool.ts`), the mount point (`XtermHost.tsx`), the lease
// fold (`lease-model.ts`), and the lease line (`LeaseLine.tsx`). Those are reached
// by the pane body beside them through deep imports inside the family — the door
// below is the SEAT BOARD's, and a body importing its own family through it would
// close a cycle: this module imports the pane, and the pane imports these.

// THE FAMILY'S STYLESHEETS ARE IMPORTED HERE AND NOWHERE ELSE, which is
// `apps/desktop/AGENTS.md`'s rule and matters twice over for this family: the
// emulator's own sheet is a LIBRARY's, and a component that imported it would put
// the bundler's edge into `@xterm/xterm` at a leaf rather than at the door. Both
// land together so a surface can never render a terminal whose grid arrived
// without its geometry.
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

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
