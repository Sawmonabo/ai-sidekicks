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
// The registration lives here, and so does the pane BODY (`terminal/pane/`), for
// `console/browser/index.ts`'s reason: the seat board composes families, not bodies,
// and a body parked under `console/panes/` is subtracted from both view-family
// layering rules.
//
// WHAT THE FAMILY OWNS TODAY, after T-023p-1C-7, GROUPED BY SEAM. The family held its
// modules flat over three concerns that share no state and change for no common
// reason, which is a bucket rather than a module; each is now a sub-module directory
// reached by deep intra-family specifiers, and the door below is unchanged. The count
// of modules is deliberately not stated — it moves with every module the family adds
// — and what the argument rests on is the three concerns, which the directories below
// are.
//
//   • `emulator/` — everything between this console and `@xterm/xterm`, and the one
//     directory the lazy chunk is drawn from. The wrapper (`xterm-adapter.ts`) with
//     the three modules it composes — the addons and the renderer selection
//     (`xterm-addons.ts`), both link paths (`xterm-links.ts`), and the host tie with
//     its write gate (`xterm-host-binding.ts`) — the deferred edge into it
//     (`emulator-loader.ts`) with the hook that turns that fetch into a reading a
//     surface can render (`emulator-state.ts`), the page-wide WebGL slot allocator
//     (`renderer-pool.ts`), the link scheme guard (`link-guard.ts`), and the mount
//     point (`XtermHost.tsx`).
//   • `lease/` — who holds the write lease and how a viewer asks for it: the fold
//     (`lease-model.ts`) over the one-event reader beneath it (`lease-transition.ts`),
//     the viewer's identity read (`viewer-identity.ts`), the acquisition terms
//     (`lease-acquisition.ts`), the one wire call (`lease-claim.ts`), and the line
//     that renders all of it (`LeaseLine.tsx`) with its ledger, holder name,
//     participant mark, and withheld-claim control.
//   • `pane/` — the deck's terminal body and the reads only it makes: the pane
//     (`TerminalPane.tsx`) and its bound half (`BoundTerminalPane.tsx`), the
//     body the door below loads (`pane/terminal-pane-body.ts`), the host-presence
//     fold (`node-presence-model.ts`), and the output subscription
//     (`output-stream.ts`).
//
// The pane body reaches the other two through deep imports inside the family — the
// door below is the SEAT BOARD's, and a body importing its own family through it
// would close a cycle: this module imports the pane, and the pane imports these.
//
// Its BOUNDS are not among them. The scrollback, the WebGL ceiling, and the ledger
// cap live in `console/core/constants.ts`, which `apps/desktop/AGENTS.md` §Config
// single-sourcing makes the console's one home for a cap — a family module holding
// its own put the console's cap inventory in three places.

// THIS FAMILY'S STYLESHEETS ARE NOT IMPORTED HERE. They enter at
// `pane/terminal-pane-body.ts` — the family's one chunk root — which is the same
// placement the LIBRARY's sheet already had: `@xterm/xterm/css/xterm.css` is imported
// by `emulator/xterm-adapter.ts`, reached only across the `import()` in
// `emulator/emulator-loader.ts`, so the grid's geometry has always ridden the chunk
// that draws the grid. Four hand-authored sheets sitting on the initial document while
// the library's sheet did not was the inconsistency, and this is which way it resolved.
//
// ADMITTED BY THE COLLISION CENSUS. A sheet may travel behind a chunk boundary only if
// no other family declares a class it declares — load order decides equal-specificity
// conflicts, so deferring such a sheet restyles somebody else's surface, which
// `runs/index.ts` records happening. None of this family's four sheets does, per
// `test/console/architecture/stylesheet-selector-owners.test.ts`.

import type { ConsolePaneRegistry } from "../seats/index.js";

/**
 * Claim the terminal family's pane kinds.
 *
 * One kind, and structurally one: `Spec-023 §Console Design (Meridian)` 8.8 gives
 * V1 exactly one terminal surface per session, and the deck's single mount door
 * makes a second claim on this kind an error rather than a swap.
 */
export function registerTerminalPanes(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "terminal",
    owner: "terminal",
    // A loader, for `browser/index.ts`'s reason. The emulator was already a lazy chunk
    // of its own and everything around it was not, so a session that never opens a
    // terminal still carried the pane, the lease line, and their rules.
    body: () => import("./pane/terminal-pane-body.js"),
  });
}
