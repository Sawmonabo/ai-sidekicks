// The surface registry: how the six 1C families reach the screen.
//
// The frame mounts whatever the route names, and it learns what that is from this
// registry rather than from an import. The reason is parallel delivery: six families
// build six surfaces at once, and a frame that imported all six would serialize them
// behind one file and make every merge a conflict in that file.
//
// A family calls `registerConsoleSurface` at module scope with the slot it owns and
// a renderer. The frame resolves the current route to a slot, looks the renderer up,
// and mounts it inside an error boundary. A slot with no renderer is the
// "reserved, not stubbed" rule in action: the frame says the surface has not been
// built rather than rendering a placeholder that looks like a broken feature.
//
// IT LIVES IN `seats/` AND NOT IN `frame/`, WHERE IT WAS WRITTEN. This is a contract
// through which a view family hands the frame a body, which is what this family is
// for, and its inputs stop at `bridge/` — `core/`'s keyed registry, the bridge
// contract, the two stores, the two persistence stores, the route union — so the
// lowest home above all of them is the slot immediately above `bridge/`, which is
// here. In `frame/` it was the console's last named layering exemption: a view family
// cannot import `frame/index.ts` (that door reaches `ConsoleRoot`, which reaches
// `families.ts`, which composes every view family in), so every family wrote a deep
// specifier past the frame's door and `.dependency-cruiser.mjs` carried a
// module-named subtraction to tolerate it. The move deletes the subtraction, and
// `console-cross-family-deep-import` now covers the whole console with no exception.

import { createElement } from "react";

import { KeyedRegistry } from "../core/index.js";
import { LoadedLazyBody, type LazyBodyLoader } from "./lazy-body.js";
import { PendingSurfaceBody } from "./PendingSurfaceBody.js";
import type { ConsoleRoute } from "../routing/index.js";
import { type ConsoleSurfaceContext } from "./surface-context.js";

/**
 * Every place a surface can be mounted. Closed; one per navigable destination.
 *
 * The tuple is the declaration and the union is derived from it. Written the other
 * way round — a union beside a hand-repeated array — the two are two closed sets
 * that agree until someone widens one, and the compiler notices neither: a slot
 * added to the union but not the array is a slot `registeredSlots` can never
 * report, and one added to the array but not the union does not compile at the
 * array but does everywhere it is read back.
 */
export const CONSOLE_SURFACE_SLOTS = [
  "sessions",
  "workspace",
  "workflows",
  "settings",
  "timeline",
  "agent-console",
  // Reached only by the fixture-gated `#/pane-harness/…` address, so a release
  // renderer can name this slot and can never route to it. It is in the tuple
  // because the tuple is what `registeredSlots` and the composition test walk: a
  // slot claimed by a registration but absent from the declaration is a slot
  // neither of them can report on.
  "pane-harness",
] as const;

export type ConsoleSurfaceSlot = (typeof CONSOLE_SURFACE_SLOTS)[number];

export interface ConsoleSurfaceDescriptor {
  readonly slot: ConsoleSurfaceSlot;
  /** The task or family that owns it, so an unrendered slot names someone. */
  readonly owner: string;
  readonly render: (context: ConsoleSurfaceContext) => React.ReactNode;
}

/** What every registration carries, whichever form it takes. */
interface ConsoleSurfaceRegistrationBase {
  readonly slot: ConsoleSurfaceSlot;
  readonly owner: string;
}

/**
 * What a family hands `register`, in one of exactly two forms.
 *
 * The pane board's own union, applied to routes, and decided by the same product fact:
 * a surface that is painted before a person acts belongs in the entry graph, and a
 * surface reached by pressing a rail destination or opening an auxiliary window does
 * not. `apps/desktop/AGENTS.md` states the rule beside the seat-board one.
 *
 * The rail's OWN destination is the case that decides itself: whichever surface the
 * console opens on is the flagship first paint and keeps `render`.
 */
export type ConsoleSurfaceRegistration =
  | (ConsoleSurfaceRegistrationBase & {
      readonly render: (context: ConsoleSurfaceContext) => React.ReactNode;
      readonly body?: never;
    })
  | (ConsoleSurfaceRegistrationBase & {
      readonly body: LazyBodyLoader<ConsoleSurfaceContext>;
      readonly render?: never;
    });

export class ConsoleSurfaceRegistry {
  // `"owner-scoped"`: re-registering under the same owner replaces (a hot reload
  // re-runs a family's module), and a different owner claiming a taken slot is a
  // conflict rather than a swap, because which surface mounts would otherwise
  // depend on module import order.
  readonly #descriptorsBySlot = new KeyedRegistry<ConsoleSurfaceSlot, ConsoleSurfaceDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "surface slot",
    ownerOf: (descriptor) => descriptor.owner,
  });

  /**
   * The loader-backed surfaces, so `preload` has something to resolve.
   *
   * A second table rather than a member on the descriptor, for the pane board's reason:
   * the descriptor is what every MOUNT site reads and none of them has business knowing
   * whether the surface it is about to render arrived as a chunk.
   */
  readonly #loadedBodiesBySlot = new Map<
    ConsoleSurfaceSlot,
    LoadedLazyBody<ConsoleSurfaceContext>
  >();

  /** Claim a slot. A second claim by a different owner is an error, not a swap. */
  public register(registration: ConsoleSurfaceRegistration): void {
    if (registration.body === undefined) {
      // Registered first and the loader table trimmed after, for the pane board's
      // measured reason: a refused re-registration must not strip the loader off the
      // descriptor that survives it, or a warmable slot silently stops being one.
      this.#descriptorsBySlot.register(registration.slot, {
        slot: registration.slot,
        owner: registration.owner,
        render: registration.render,
      });
      this.#loadedBodiesBySlot.delete(registration.slot);
      return;
    }
    // The fallback is the route's own absence frame, empty. Supplied here rather than by
    // the generic machinery, because what a route reserves while it loads is a
    // route-shaped question.
    const loadedBody = new LoadedLazyBody(registration.body, (context: ConsoleSurfaceContext) =>
      createElement(PendingSurfaceBody, { context }),
    );
    // Registered BEFORE the loader table is written, so a `register` the keyed registry
    // refuses — a different owner claiming a taken slot — cannot leave a loader behind
    // for a surface that is not the one mounting. The refusal throws past this line.
    this.#descriptorsBySlot.register(registration.slot, {
      slot: registration.slot,
      owner: registration.owner,
      render: loadedBody.render,
    });
    this.#loadedBodiesBySlot.set(registration.slot, loadedBody);
  }

  public unregister(slot: ConsoleSurfaceSlot): void {
    this.#descriptorsBySlot.unregister(slot);
    this.#loadedBodiesBySlot.delete(slot);
  }

  /**
   * Start this slot's surface loading, without navigating to it.
   *
   * The pane board's own `preload`, with its reasoning unchanged: idempotent by
   * construction, and a component-form or unregistered slot settles immediately with
   * nothing to do, so a caller preloading a destination it has not opened never has to
   * ask first whether that slot is loader-backed.
   */
  public async preload(slot: ConsoleSurfaceSlot): Promise<void> {
    await this.#loadedBodiesBySlot.get(slot)?.load();
  }

  /** Which registered slots have a surface still to load, in declaration order. */
  public unloadedKeys(): readonly ConsoleSurfaceSlot[] {
    return CONSOLE_SURFACE_SLOTS.filter(
      (slot) => this.#loadedBodiesBySlot.get(slot)?.isResolved === false,
    );
  }

  public descriptorFor(slot: ConsoleSurfaceSlot): ConsoleSurfaceDescriptor | undefined {
    return this.#descriptorsBySlot.get(slot);
  }

  public registeredSlots(): readonly ConsoleSurfaceSlot[] {
    return CONSOLE_SURFACE_SLOTS.filter((slot) => this.#descriptorsBySlot.has(slot));
  }
}

/** The process-wide registry the families call at module scope. */
export const consoleSurfaceRegistry: ConsoleSurfaceRegistry = new ConsoleSurfaceRegistry();

/** The call a 1C surface family makes to claim its slot, in either registration form. */
export function registerConsoleSurface(registration: ConsoleSurfaceRegistration): void {
  consoleSurfaceRegistry.register(registration);
}

/** Which slot a route mounts. `undefined` for routes that mount no surface. */
export function surfaceSlotFor(route: ConsoleRoute): ConsoleSurfaceSlot | undefined {
  switch (route.kind) {
    case "sessions":
      return "sessions";
    case "workspace":
      return "workspace";
    case "workflows":
      return "workflows";
    case "settings":
      return "settings";
    case "pane-harness":
      return "pane-harness";
    case "auxiliary":
      return route.route === "timeline" ? "timeline" : "agent-console";
    case "not-found":
      return undefined;
  }
}
