// The deck's single mount door: one owner per pane kind.
//
// `Spec-023 §Console Design (Meridian)` §The surface set states the deck rule in
// structural terms — "one entity opens one pane, structurally (a single mount door
// and a tripwire that fails on a second)". This module is that door. A view family is
// HANDED this table by the composition and claims the kind it owns inside its own
// `register<Family>` entry point; the deck resolves a pane's kind to a descriptor and
// mounts it. There is deliberately no module-scope convenience that writes into the
// process-wide instance — a family calling one would compose into production from
// inside a composition that had handed it somewhere else.
//
// WHY THIS IS NOT `surface-registry.ts`, BESIDE IT IN THIS FAMILY
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

import { createElement } from "react";

import { KeyedRegistry } from "../core/index.js";
import { LoadedLazyBody, type LazyBodyLoader } from "./lazy-body.js";
import { PendingPaneBody } from "./PendingPaneBody.js";
import { type ConsolePaneAddress } from "./pane-address.js";
import { type ConsolePaneContext } from "./pane-context.js";
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

// Consumed by T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7
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

/** What every registration carries, whichever form it takes. */
interface ConsolePaneRegistrationBase {
  readonly kind: PaneKind;
  readonly owner: string;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * What a family hands `register`, in one of exactly two forms.
 *
 * THE COMPONENT FORM is the original: a `render` the registrar already holds, for a
 * body that is on the flagship first paint and therefore belongs in the entry graph.
 *
 * THE LOADER FORM is `body: () => import("./pane/XBody.js")`, for a body that is not.
 * The distinction is a product fact rather than a size threshold — what decides it is
 * whether the surface is painted before a person acts — and `apps/desktop/AGENTS.md`
 * states the rule beside the pane-board one.
 *
 * A UNION AND NOT TWO OPTIONAL MEMBERS. `render?` and `body?` beside each other would
 * make "both" and "neither" representable, and both would have to be answered at run
 * time by a registry that cannot know which the family meant. The `never` arms are what
 * make the compiler refuse a registration carrying both.
 */
export type ConsolePaneRegistration =
  | (ConsolePaneRegistrationBase & {
      readonly render: (context: ConsolePaneContext) => React.ReactNode;
      readonly body?: never;
    })
  | (ConsolePaneRegistrationBase & {
      readonly body: LazyBodyLoader<ConsolePaneContext>;
      readonly render?: never;
    });

export class ConsolePaneRegistry {
  // `"owner-scoped"`, for `surface-registry.ts`'s reason: re-registering
  // under the same owner replaces (a hot reload re-runs a family's module), and a
  // different owner claiming a taken kind is a conflict rather than a swap,
  // because which body mounts would otherwise depend on module import order.
  readonly #descriptorsByKind = new KeyedRegistry<PaneKind, ConsolePaneDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "pane kind",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the deck mounts one body per pane kind, through a single door",
  });

  /**
   * The loader-backed bodies, so `preload` has something to resolve.
   *
   * A second table rather than a member on the descriptor, because the descriptor is
   * what every MOUNT site reads and none of them has any business knowing whether the
   * body it is about to render arrived as a chunk. Keeping the two apart is what lets
   * both registration forms produce one resolved descriptor shape.
   */
  readonly #loadedBodiesByKind = new Map<PaneKind, LoadedLazyBody<ConsolePaneContext>>();

  /**
   * Claim a pane kind. A second claim by a different owner is an error, not a swap.
   *
   * A loader-form registration is normalised here: the registry builds the one
   * `LoadedLazyBody` for it — one memoised promise and one stable lazy component — and
   * stores the descriptor whose `render` mounts it. So `descriptorFor` answers the same
   * shape for both forms, and nothing downstream branches on how a body was registered.
   */
  public register(registration: ConsolePaneRegistration): void {
    if (registration.body === undefined) {
      // REGISTERED FIRST, THEN THE LOADER TABLE IS TRIMMED, which is the loader arm's
      // ordering read from the other side. Deleting first meant a refused registration —
      // a different owner claiming a taken kind — threw AFTER dropping the loader that
      // belongs to the descriptor still admitted, and the surviving pane then reported
      // nothing to `preload` or `unloadedKeys`: warmable one moment and silently not the
      // next, with no error anywhere naming why. The refusal throws past this line.
      this.#descriptorsByKind.register(registration.kind, {
        kind: registration.kind,
        owner: registration.owner,
        render: registration.render,
      });
      this.#loadedBodiesByKind.delete(registration.kind);
      return;
    }
    // The fallback is the pane's own empty chrome, supplied here rather than by the
    // generic machinery: what a pane reserves while it loads is a pane-shaped question.
    const loadedBody = new LoadedLazyBody(registration.body, (context: ConsolePaneContext) =>
      createElement(PendingPaneBody, { context }),
    );
    // Registered BEFORE the descriptor, so a `register` the keyed registry refuses —
    // a different owner claiming a taken kind — cannot leave a loader behind for a
    // body that is not the one mounting. The refusal throws past this line.
    this.#descriptorsByKind.register(registration.kind, {
      kind: registration.kind,
      owner: registration.owner,
      render: loadedBody.render,
    });
    this.#loadedBodiesByKind.set(registration.kind, loadedBody);
  }

  public unregister(kind: PaneKind): void {
    this.#descriptorsByKind.unregister(kind);
    this.#loadedBodiesByKind.delete(kind);
  }

  /**
   * Start this kind's body loading, without opening it.
   *
   * The three callers are the palette's highlighted entry, an address about to open
   * before the route commits, and the idle warm — all of which know a pane is LIKELY
   * before it is certain, which is exactly the moment a loader can be paid for off the
   * critical path.
   *
   * Idempotent by construction: the promise is memoised on the registration, so calling
   * this on every arrow-key press costs one fetch. A component-form kind and an
   * unregistered kind both settle immediately with nothing to do — a caller preloading
   * an address it has not opened yet must not have to ask first whether the kind is
   * loader-backed, or every call site would carry a copy of that question.
   */
  public async preload(kind: PaneKind): Promise<void> {
    await this.#loadedBodiesByKind.get(kind)?.load();
  }

  /**
   * Which registered kinds have a body still to load, in declaration order.
   *
   * `registeredPaneKinds`' ordering rule, for its reason: the warm walk's order is
   * observable in what lands first, and registration order would make it depend on which
   * family's module evaluated first. Already-resolved kinds are filtered out so a second
   * walk over a warmed board does nothing rather than re-entering every memo.
   */
  public unloadedKeys(): readonly PaneKind[] {
    return PANE_KINDS.filter((kind) => this.#loadedBodiesByKind.get(kind)?.isResolved === false);
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

// Consumed by T-023p-1C-2, T-023p-1C-8
/** Which pane kinds the process-wide registry has a body for. */
export function registeredPaneKinds(): readonly PaneKind[] {
  return consolePaneRegistry.registeredPaneKinds();
}
