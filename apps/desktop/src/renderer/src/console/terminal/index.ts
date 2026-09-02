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
// (`constants.ts`), the emulator wrapper (`xterm-adapter.ts`) with the three modules
// it composes — the addons and the renderer selection (`xterm-addons.ts`), both link
// paths (`xterm-links.ts`), and the host tie with its write gate
// (`xterm-host-binding.ts`) — and the deferred edge into it (`emulator-loader.ts`),
// the page-wide WebGL slot allocator (`renderer-pool.ts`), the link scheme guard
// (`link-guard.ts`), the mount point (`XtermHost.tsx`), the lease fold
// (`lease-model.ts`), the host-presence fold (`node-presence-model.ts`), the viewer's
// identity read (`viewer-identity.ts`), and the lease line (`LeaseLine.tsx`). Those
// are reached by the pane body beside them through deep imports inside the family —
// the door below is the SEAT BOARD's, and a body importing its own family through it
// would close a cycle: this module imports the pane, and the pane imports these.

// THE FAMILY'S STYLESHEET IS IMPORTED HERE AND NOWHERE ELSE, which is
// `apps/desktop/AGENTS.md`'s rule. It is the family's own sheet — the pane box, the
// lease line, the host's boundary — and it is small, hand-authored, and needed by
// every terminal surface the moment one renders, including the surface that stands
// in while the emulator is still arriving.
//
// The LIBRARY's sheet is deliberately not beside it. `@xterm/xterm/css/xterm.css`
// is imported by `xterm-adapter.ts`, which is reached only across the `import()` in
// `emulator-loader.ts`, so the grid's geometry rides the same lazy chunk as the code
// that draws the grid. An import here would have put those bytes in the document the
// operator waits for, which is what `Spec-023 §Console Design (Meridian)` §Budgets
// excludes when it names the terminal a lazy chunk.
import "./terminal.css";

import type { ConsolePaneRegistry } from "../seats/index.js";
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
