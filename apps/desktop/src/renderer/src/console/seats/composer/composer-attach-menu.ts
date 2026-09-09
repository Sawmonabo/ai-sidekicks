// The composer's attach menu, as a seat rather than a list the composer maintains.
//
// `Spec-023 §Console Design (Meridian)` 12.1 gives the browser pane two open paths
// that do not start in the deck: attaching a page to the conversation, and detaching
// one back out. The first of those is an entry in the composer's `+` menu — which is
// the composer family's surface, in a family that may not import the browser's.
//
// SO IT IS A SEAT, for `single-slot/composer-seat.ts`'s own reason applied one level down. A view
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

import type { ConsoleBridge } from "../../bridge/index.js";
import { KeyedRegistry, type ConsoleRefusal } from "../../core/index.js";
import type { GlyphName } from "../../tokens/index.js";

/** What the composer hands an entry when a person picks it. */
export interface ComposerAttachMenuContext {
  readonly bridge: ConsoleBridge;
  /** The session the composer is addressed within, where it has one. */
  readonly sessionId: string | undefined;
  /**
   * The deck pane the person is looking at, or `undefined` where focus is not in the
   * deck.
   *
   * The pane's ID and not its kind, and an entry therefore cannot filter on kind: an
   * id is a handle and says nothing about what is behind it, so an entry sees only
   * that SOME pane is focused. That is deliberate and it is not the entry knowing
   * better — it is the composer declining to decide which entries apply, because a
   * context that reported the kind would invite exactly that. What follows is that an
   * entry offered against the wrong kind is refused by the DAEMON rather than hidden
   * here, which is the honest division: this window knows what is focused, and what
   * may be attached from it is the owning family's authority and not this seat's.
   */
  readonly focusedPaneId: string | undefined;
}

/**
 * One artifact a family has put on the composer's message.
 *
 * ARTIFACT-BACKED, WHICH IS THE ONLY ARM THE WIRE SUPPORTS. `Spec-014 §Required
 * Behavior` types the attachment reference as an ordered list of artifact ids and
 * forbids delivering an attachment over `SteerPayload.attachments`, which
 * `packages/contracts` types `unknown[]`; the corpus registers no operation that hands a
 * conversation a reference to anything else. So a family that wants to attach something
 * puts its bytes through the ingest pipeline first and hands back what that pipeline
 * minted — which is what `repos/attachments/` does for a file a participant chose, and
 * what the browser's capture does for a page.
 *
 * The two figures beside the id are the pipeline's own answer rather than a second
 * reading of the artifact: a composer row can state what it is carrying and how big it
 * is without a read of its own, and neither is re-derived anywhere.
 *
 * NOT `InlineCardAttachmentRef`, which is next door and names a different thing: that is
 * a reference to an attachment already ON a message, carried by a card rendering
 * history. This is what a family hands the composer BEFORE a message exists.
 */
export interface ComposerArtifactAttachment {
  readonly artifactId: string;
  /** The encoded type the pipeline stored, wire-verbatim. Never checked here. */
  readonly mediaType: string;
  /** What was stored, so a row can state a size without a second read. */
  readonly byteLength: number;
}

/**
 * How picking an entry settled.
 *
 * A refusal comes BACK rather than being rendered by the entry, because the surface a
 * person is looking at when they pick a menu row is the composer, and an owning family
 * that rendered its own refusal would put the answer in a pane that may not be open.
 *
 * AND SO DOES THE ATTACHMENT, for the same reason read the other way. The `attached` arm
 * used to carry nothing, so an entry could report success having put nothing on the
 * message — which is what the browser's row did: it dispatched a pane operation,
 * discarded its answer, and said `attached` while the conversation gained nothing. An
 * arm that has to carry the attachment cannot be satisfied by an act that produced none.
 */
export type ComposerAttachOutcome =
  | { readonly status: "attached"; readonly attachment: ComposerArtifactAttachment }
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
  // `"owner-scoped"`, for `seats/slots/sidebar-sections.ts`' reason: a hot reload re-runs the
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
