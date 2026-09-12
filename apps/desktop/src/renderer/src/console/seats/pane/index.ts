// The pane sub-module's door: what a SIBLING sub-module takes from it, and nothing more.
//
// A sub-module door and not a second family door, on the module-shape rule in
// `apps/desktop/AGENTS.md` — it publishes to `seats/` alone, it is reached by deep
// intra-family specifiers, and `seats/index.ts` re-exports every pane name from the
// module that DECLARES it rather than through this line.
//
// FOUR NAMES, one per measured production edge, because a line with no production
// reader is a dead export that same rule rejects:
//   - `ConsolePaneAddress` — `composer/composer-seat.ts`
//   - `ConsolePaneOpener` — `slots/sidebar-sections.ts`
//   - `ConsolePaneRegistry` — `surface/surface-context.ts`
//   - `PENDING_PANE_BODY_ATTRIBUTE` — `surface/PendingSurfaceBody.tsx`
// The pane chrome, the pane context, and the pane controls are deliberately absent:
// their only readers outside this directory are the `lazy-body/` suites, and a test
// takes the declaring module by its own deep specifier.

export type { ConsolePaneAddress, ConsolePaneOpener } from "./pane-address.js";
export type { ConsolePaneRegistry } from "./pane-registry.js";
export { PENDING_PANE_BODY_ATTRIBUTE } from "./pending-pane-body.js";
