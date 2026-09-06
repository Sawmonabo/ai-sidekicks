// The composer's attach menu, as a seat rather than a list the composer maintains.
//
// `Spec-023 §Console Design (Meridian)` 12.1 gives the browser pane two open paths
// that do not start in the deck: attaching a page to the conversation, and detaching
// one back out. The first of those is an entry in the composer's `+` menu — which is
// the composer family's surface, in a family that may not import the browser's.
//
// SO IT IS A SEAT, for `composer-seat.ts`'s own reason applied one level down. A view
// family never imports a sibling, so the only two shapes available are a registration
// (a call) and a composition root naming both families. A registration is the one that
// does not put the composer's `+` menu in the frame's dependency graph, and it is the
// shape `registerConsoleSurface` and `registerComposerSeat` already take here.
//
// THE ACT ANSWERS RATHER THAN RENDERS, which is the other half of the same argument:
// the family that owns the wire knows what the wire said, and the surface that has to
// show it is the one the person is looking at. So the entry returns its outcome and
// the composer renders it.
//
// WHAT AN ENTRY MAY NOT DO. It carries a label, a glyph, and one act. It carries no
// eligibility of its own: whether attaching a page is permitted is a daemon decision,
// and an entry that hid itself would be the renderer deriving an authority it does not
// have. An entry that cannot run says so when it is run — which is the pane's own
// refusal rendering, in the pane, where the person can read it.

import type { ConsoleBridge } from "../bridge/index.js";
import { KeyedRegistry, type ConsoleRefusal } from "../core/index.js";
import type { GlyphName } from "../tokens/index.js";

/** What the composer hands an entry when a person picks it. */
export interface ComposerAttachMenuContext {
  readonly bridge: ConsoleBridge;
  /** The session the composer is addressed within, where it has one. */
  readonly sessionId: string | undefined;
  /**
   * The deck pane the person is looking at, or `undefined` where focus is not in the
   * deck.
   *
   * The pane's ID and not its kind: an entry contributed by a family knows which kind
   * it cares about, and a context that reported the kind would invite the composer to
   * decide which entries apply — which is the composer deriving an eligibility the
   * contributing family owns.
   */
  readonly focusedPaneId: string | undefined;
}

/**
 * How picking an entry settled.
 *
 * A refusal comes BACK rather than being rendered by the entry, because the surface a
 * person is looking at when they pick a menu row is the composer, and an owning family
 * that rendered its own refusal would put the answer in a pane that may not be open.
 */
export type ComposerAttachOutcome =
  | { readonly status: "attached" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** One row in the composer's `+` menu, contributed by a view family. */
export interface ComposerAttachMenuEntry {
  /** Stable across builds; the registry key and the menu item's own id. */
  readonly id: string;
  /** The family that contributed it, so an entry that misbehaves names someone. */
  readonly owner: string;
  readonly label: string;
  readonly glyph: GlyphName;
  /** One sentence under the label. Says what picking it does, never what it needs. */
  readonly detail: string;
  /** What picking it does, and how it settled. */
  readonly attach: (context: ComposerAttachMenuContext) => Promise<ComposerAttachOutcome>;
}

/**
 * The rows families have contributed to the composer's `+` menu.
 *
 * A class holding the registry rather than a bare module-scope one, which is the
 * package's rule for stateful logic and the shape every sibling seat here already
 * takes: the state is private, and what the module publishes is the three calls a
 * contributor, the composer, and a test each need.
 *
 * NOT EXPORTED, which is where it differs from its siblings. They publish their class
 * because their singleton is an exported `const` and `isolatedDeclarations` needs a
 * name to annotate it with; this menu's singleton is module-private, so exporting the
 * class would publish a symbol nothing imports — a dead export the gates fail.
 */
class ComposerAttachMenuRegistry {
  // `"owner-scoped"`, for `sidebar-sections.ts`' reason: a hot reload re-runs the
  // owning family's module and must replace, while two owners on one id is a conflict
  // rather than a swap decided by import order.
  readonly #entriesById = new KeyedRegistry<string, ComposerAttachMenuEntry>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "composer attach entry",
    ownerOf: (entry) => entry.owner,
    duplicateHint:
      "two families claiming one attach entry would make which one runs depend on module import order",
  });

  public register(entry: ComposerAttachMenuEntry): void {
    this.#entriesById.register(entry.id, entry);
  }

  /** Every contributed row, in registration order. The composer renders them as given. */
  public entries(): readonly ComposerAttachMenuEntry[] {
    return this.#entriesById.all();
  }

  public clear(): void {
    this.#entriesById.clear();
  }
}

/** The process-wide menu the contributing families call at module scope. */
const composerAttachMenu = new ComposerAttachMenuRegistry();

/** The call a view family makes to put one row in the composer's `+` menu. */
export function registerComposerAttachMenuEntry(entry: ComposerAttachMenuEntry): void {
  composerAttachMenu.register(entry);
}

// Consumed by T-023p-1C-3
/** Every contributed row, in registration order. The composer renders them as given. */
export function composerAttachMenuEntries(): readonly ComposerAttachMenuEntry[] {
  return composerAttachMenu.entries();
}

// Consumed by T-023p-1C-3
/**
 * Empty the menu.
 *
 * Test scaffolding, and named as such for `unregisterComposerSeat`'s reason: the
 * registry singleton outlives a case, so one that registered would leak into the next.
 */
export function clearComposerAttachMenu(): void {
  composerAttachMenu.clear();
}
