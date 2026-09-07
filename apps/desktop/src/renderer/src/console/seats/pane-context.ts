// What a pane body is handed, below every module that hands it one.
//
// HOISTED OUT OF `pane-registry.ts`, and the reason is a cycle rather than tidiness. The
// deck's board mounts a reserved frame while a loader-backed body is in flight, so the
// registry reaches `PendingPaneBody.tsx`, which draws `ConsolePaneChrome.tsx` — and both
// of those name the context a pane is mounted with, which the registry used to declare.
// That is a back-edge from a module the registry imports to the registry itself, and the
// layering gate counts type edges (`tsPreCompilationDeps`) precisely so a cycle cannot
// hide inside an `import type` that erases at runtime. Hoisting the shared symbol into a
// module below both is what that gate's own message prescribes, and the same move
// `palette/contributions.ts` makes for the command shape.
//
// It imports nothing from this family, which is the property that makes it a floor
// rather than one more node in the graph.

import { type ConsoleBridge } from "../bridge/index.js";
import { type DraftStore, type UiStateStore } from "../persistence/index.js";
import { type FrameStore, type SessionStore } from "../store/index.js";
import { type ConsolePaneAddress } from "./pane-address.js";

// Consumed by T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7
/**
 * Everything a pane body is handed. Nothing here is global; all of it is per pane,
 * in the window the pane is mounted in.
 *
 * An intersection rather than an interface extending the address, because the
 * address is a discriminated union over `kind` and an interface can only extend
 * an object type. The intersection distributes over that union, so narrowing a
 * context on its `kind` narrows its `entity` with it — the property the union
 * exists for, carried through to every registered body.
 */
export type ConsolePaneContext = ConsolePaneAddress & ConsolePaneBinding;

/** What a pane is bound to, beside the address it was opened at. */
interface ConsolePaneBinding {
  /** This pane's identity in the deck, stable across a layout restore. */
  readonly paneId: string;
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  /** The session store for the pane's session, or `undefined` on a bare route. */
  readonly sessionStore: SessionStore | undefined;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  /**
   * The pane this one was opened FROM, when the deck linked the two — a value
   * passed in and never a handle held, so a linked pane stays independently
   * movable, detachable, and closable.
   *
   * A required member carrying `undefined` when unlinked, on `sessionStore`'s
   * precedent: an optional member would read identically whether the deck decided
   * there was no source pane or forgot to pass one, and only one of those is a
   * deliberate answer.
   *
   * WHETHER A RESTORED LAYOUT RESTORES THE LINK IS THE DECK'S CALL, AND IT IS
   * ALREADY EXPRESSIBLE. `persistence/value-classes.ts`'s `layout` class admits a
   * per-pane record whose members are numbers, booleans, and identifier-shaped
   * strings, and a pane id is identifier-shaped — so a deck that writes the link
   * into its layout entry gets it back on restore, through the closed value-class
   * set exactly as it stands. No class is widened here, and nothing on this
   * substrate writes such a member: until the deck that owns the layout writes one,
   * a restored pane comes back unlinked.
   */
  readonly linkedSourcePaneId: string | undefined;
  /**
   * The focus ring's colour, as a `var()` reference produced by
   * `tokens/tokenReference` — `Spec-023 §Console Design (Meridian)` rule 2: "the
   * hue answers 'who' everywhere — … pane focus rings". `undefined` where the deck
   * has no actor to attribute the pane to, which is the fail-closed answer: an
   * unattributed pane takes the neutral boundary rather than someone else's hue.
   */
  readonly focusHue: string | undefined;
}
