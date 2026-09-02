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

import { KeyedRegistry } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleEntityRef, type FrameStore, type SessionStore } from "../../store/index.js";
import { type DraftStore, type UiStateStore } from "../../persistence/index.js";
import { PANE_KINDS, type PaneKind } from "./pane-kinds.js";

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * Which pane, over which entity — the address a pane is opened at.
 *
 * `entity` is `undefined` for the pane kinds that are session-scoped rather than
 * entity-scoped (the session `runs` list, an unbound `timeline`). It is a required
 * member carrying `undefined` rather than an optional one so a caller that forgot
 * to resolve an entity is a compile error at the construction site instead of an
 * absent key that reads identically to a deliberate session scope.
 */
export interface ConsolePaneAddress {
  readonly kind: PaneKind;
  readonly entity: ConsoleEntityRef | undefined;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * The call the sidebar and the palette make to open a pane.
 *
 * A callback handed down by whoever owns the deck, rather than a module-scope
 * function, because an auxiliary window's deck is a different deck: a section
 * rendered in the timeline window must open its panes there and not in the main
 * window that happens to have loaded the same module.
 */
export type ConsolePaneOpener = (address: ConsolePaneAddress) => void;

/**
 * Everything a pane body is handed. Nothing here is global; all of it is per pane,
 * in the window the pane is mounted in.
 */
export interface ConsolePaneContext extends ConsolePaneAddress {
  /** This pane's identity in the deck, stable across a layout restore. */
  readonly paneId: string;
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  /** The session store for the pane's session, or `undefined` on a bare route. */
  readonly sessionStore: SessionStore | undefined;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  /**
   * The focus ring's colour, as a `var()` reference produced by
   * `tokens/tokenReference` — `Spec-023 §Console Design (Meridian)` rule 2: "the
   * hue answers 'who' everywhere — … pane focus rings". `undefined` where the deck
   * has no actor to attribute the pane to, which is the fail-closed answer: an
   * unattributed pane takes the neutral boundary rather than someone else's hue.
   */
  readonly focusHue: string | undefined;
}

export interface ConsolePaneDescriptor {
  readonly kind: PaneKind;
  /** The task or family that owns it, so an unrendered kind names someone. */
  readonly owner: string;
  readonly render: (context: ConsolePaneContext) => React.ReactNode;
  /**
   * Whether this kind may be torn off into an auxiliary window.
   *
   * A property of the KIND and not of a pane instance: `Spec-023 §Console Design
   * (Meridian)` ships exactly two auxiliary windows, and a pane whose body holds a
   * main-process view (`browser`) or a process lease (`terminal`) cannot follow a
   * detach without its owning plan saying how. Required rather than optional so
   * every family answers it deliberately.
   */
  readonly openInWindow: boolean;
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

// Consumed by T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7
/** The call a view family makes to claim a pane kind. */
export function registerConsolePane(descriptor: ConsolePaneDescriptor): void {
  consolePaneRegistry.register(descriptor);
}

// Consumed by T-023p-1C-2, T-023p-1C-8
/** Which pane kinds the process-wide registry has a body for. */
export function registeredPaneKinds(): readonly PaneKind[] {
  return consolePaneRegistry.registeredPaneKinds();
}
