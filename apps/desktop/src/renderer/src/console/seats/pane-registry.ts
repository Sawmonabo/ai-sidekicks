// The deck's single mount door: one owner per pane kind.
//
// `Spec-023 §Console Design (Meridian)` §The surface set states the deck rule in
// structural terms — "one entity opens one pane, structurally (a single mount door
// and a tripwire that fails on a second)". This module is that door. A view family
// calls `registerConsolePane` at module scope with the kind it owns; the deck
// resolves a pane's kind to a descriptor and mounts it.
//
// WHY THIS IS NOT `frame/surface-registry.ts`
//
// A SURFACE is what a route mounts — one per navigable destination, at most one on
// screen. A PANE is what the deck holds — several at once, opened by the sidebar,
// keyed by the entity they are a view of, and torn off into an auxiliary window
// where the kind allows it. The two tables answer different questions and are
// keyed by different closed sets, so folding them together would mean one key
// space in which a route and a pane could collide.
//
// What they DO share is the duplicate policy and the reason for it, so both are
// `KeyedRegistry` with `duplicatePolicy: "owner-scoped"` rather than two
// hand-rolled tables that agree today.
//
// WHICH KINDS DETACH IS NOT THIS TABLE'S ANSWER. A descriptor says who owns a kind
// and what mounts for it; whether that kind may be torn off into an auxiliary window
// is a property of the kind, and `pane-kinds.ts` derives it from the window model's
// own closed set through `isDetachablePaneKind`.
//
// PANES CAN NAME THE PANE THEY WERE OPENED FROM, AND STILL NOT HOLD IT. A deck
// links two panes when one opens the other — an inspector opened from a ledger row
// is a view OF that row's pane — and the link travels as an identifier passed in at
// mount (`ConsolePaneContext.linkedSourcePaneId`), never as a handle held. That is
// the design's independence rule made structural: a linked pane is still moved,
// detached, and closed on its own, because the only thing it has of its source is a
// string, and a string cannot be dereferenced into a body.

import { KeyedRegistry } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { type FrameStore, type SessionStore } from "../store/index.js";
import { type DraftStore, type UiStateStore } from "../persistence/index.js";
import { type ConsolePaneAddress } from "./pane-address.js";
import { PANE_KINDS, type PaneKind } from "./pane-kinds.js";

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * How a pane names itself as the pane another was opened FROM.
 *
 * A parameter object rather than a bare second string, so the caller writes what
 * the identifier means at the call site: `openPane(address, { linkedSourcePaneId })`
 * reads as a link and a positional `openPane(address, paneId)` reads as anything at
 * all. `linkedSourcePaneId` is required here — the whole value is optional on the
 * opener, so an absent link is an absent argument rather than a present object
 * carrying `undefined`, and there is exactly one way to say "no link".
 */
export interface ConsolePaneLink {
  readonly linkedSourcePaneId: string;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * The call the sidebar and the palette make to open a pane.
 *
 * A callback handed down by whoever owns the deck, rather than a module-scope
 * function, because an auxiliary window's deck is a different deck: a section
 * rendered in the timeline window must open its panes there and not in the main
 * window that happens to have loaded the same module.
 *
 * The optional `link` is how a pane that opens another says which pane it is: the
 * deck copies it onto the new pane's `ConsolePaneContext.linkedSourcePaneId`.
 * Optional because most opens have no source pane at all — the sidebar and the
 * palette open from a list, not from a pane — and a required member would have both
 * of those inventing a value to pass.
 */
export type ConsolePaneOpener = (address: ConsolePaneAddress, link?: ConsolePaneLink) => void;

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

// Consumed by T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6
/**
 * What a family registers to claim a pane kind.
 *
 * IT CARRIES NO DETACH MEMBER, deliberately. Whether a kind may be torn off into
 * an auxiliary window is `pane-kinds.ts`'s `isDetachablePaneKind` — one answer,
 * derived from the window model's own closed set. A boolean here would be asked
 * of every descriptor independently, so `browser`, `terminal`, or `artifact` could
 * each advertise a detach path the window model cannot serve, and neither this
 * registration nor the type system would notice.
 */
export interface ConsolePaneDescriptor {
  readonly kind: PaneKind;
  /** The task or family that owns it, so an unrendered kind names someone. */
  readonly owner: string;
  readonly render: (context: ConsolePaneContext) => React.ReactNode;
}

export class ConsolePaneRegistry {
  // `"owner-scoped"`, for `frame/surface-registry.ts`'s reason: re-registering
  // under the same owner replaces (a hot reload re-runs a family's module), and a
  // different owner claiming a taken kind is a conflict rather than a swap,
  // because which body mounts would otherwise depend on module import order.
  readonly #descriptorsByKind = new KeyedRegistry<PaneKind, ConsolePaneDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "pane kind",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the deck mounts one body per pane kind, through a single door",
  });

  /** Claim a pane kind. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: ConsolePaneDescriptor): void {
    this.#descriptorsByKind.register(descriptor.kind, descriptor);
  }

  public unregister(kind: PaneKind): void {
    this.#descriptorsByKind.unregister(kind);
  }

  public descriptorFor(kind: PaneKind): ConsolePaneDescriptor | undefined {
    return this.#descriptorsByKind.get(kind);
  }

  /**
   * Which kinds have a body, in DECLARATION order rather than registration order.
   *
   * Declaration order because the answer is read by the gallery and by the layout
   * validator, and both want the spec's order; registration order would make it
   * depend on which family's module happened to evaluate first.
   */
  public registeredPaneKinds(): readonly PaneKind[] {
    return PANE_KINDS.filter((kind) => this.#descriptorsByKind.has(kind));
  }
}

/** The process-wide registry the view families call at module scope. */
export const consolePaneRegistry: ConsolePaneRegistry = new ConsolePaneRegistry();

// Consumed by T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6
/** The call a view family makes to claim a pane kind. */
export function registerConsolePane(descriptor: ConsolePaneDescriptor): void {
  consolePaneRegistry.register(descriptor);
}

// Consumed by T-023p-1C-2, T-023p-1C-8
/** Which pane kinds the process-wide registry has a body for. */
export function registeredPaneKinds(): readonly PaneKind[] {
  return consolePaneRegistry.registeredPaneKinds();
}
