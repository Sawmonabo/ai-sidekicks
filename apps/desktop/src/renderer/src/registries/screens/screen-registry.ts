// The screen registry: how the six 1C families reach the screen.
//
// The frame mounts whatever the route names, and it learns what that is from this
// registry rather than from an import. The reason is parallel delivery: six families
// build six screens at once, and a frame that imported all six would serialize them
// behind one file and make every merge a conflict in that file.
//
// A family calls `registerScreen` at module scope with the slot it owns and
// a renderer. The frame resolves the current route to a slot, looks the renderer up,
// and mounts it inside an error boundary. A slot with no renderer is the
// "reserved, not stubbed" rule in action: the frame says the screen has not been
// built rather than rendering a placeholder that looks like a broken feature.
//
// IT LIVES IN `seats/` AND NOT IN `frame/`, WHERE IT WAS WRITTEN. This is a contract
// through which a view family hands the frame a body, which is what this family is
// for, and its inputs stop at `bridge/` — `core/`'s keyed registry, the bridge
// contract, the two stores, the two persistence stores, the route union — so the
// lowest home above all of them is the slot immediately above `bridge/`, which is
// here, where every feature can import it without reaching `app/`, which composes every
// feature.

import { createElement } from "react";

import { KeyedRegistry } from "@renderer/lib/keyed-registry.js";
import { LoaderBackedBody, type LazyBodyLoader } from "@renderer/components/LazyBody/lazy-body.js";
import { PendingScreenBody } from "./PendingScreenBody.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import { type ScreenContext } from "./screen-context.js";

/**
 * Every place a screen can be mounted. Closed; one per navigable destination.
 *
 * The tuple is the declaration and the union is derived from it. Written the other
 * way round — a union beside a hand-repeated array — the two are two closed sets
 * that agree until someone widens one, and the compiler notices neither: a slot
 * added to the union but not the array is a slot `registeredSlots` can never
 * report, and one added to the array but not the union does not compile at the
 * array but does everywhere it is read back.
 */
export const SCREEN_NAMES = [
  "sessions",
  "session",
  "workflows",
  "settings",
  // Reached only by the fixture-gated `#/pane-harness/…` address, so a release
  // renderer can name this slot and can never route to it. It is in the tuple
  // because the tuple is what `registeredSlots` and the composition test walk: a
  // slot claimed by a registration but absent from the declaration is a slot
  // neither of them can report on.
  "pane-harness",
] as const;

export type ScreenName = (typeof SCREEN_NAMES)[number];

export interface ScreenDescriptor {
  readonly slot: ScreenName;
  /** The task or family that owns it, so an unrendered slot names someone. */
  readonly owner: string;
  readonly render: (context: ScreenContext) => React.ReactNode;
}

/**
 * What a family hands `register`, in one of exactly two forms.
 *
 * The pane board's own union, applied to routes, and decided by the same product fact:
 * a screen that is painted before a person acts belongs in the entry graph, and a
 * screen reached by pressing a rail destination or opening an auxiliary window does
 * not. `apps/desktop/AGENTS.md` states the rule beside the seat-board one.
 *
 * The rail's OWN destination is the case that decides itself: whichever screen the
 * console opens on is the flagship first paint and keeps `render`.
 */
export type ScreenRegistration =
  | (ConsoleSurfaceRegistrationBase & {
      readonly render: (context: ScreenContext) => React.ReactNode;
      readonly body?: never;
    })
  | (ConsoleSurfaceRegistrationBase & {
      readonly body: LazyBodyLoader<ScreenContext>;
      readonly render?: never;
    });

export class ScreenRegistry {
  // `"owner-scoped"`: re-registering under the same owner replaces (a hot reload
  // re-runs a family's module), and a different owner claiming a taken slot is a
  // conflict rather than a swap, because which screen mounts would otherwise
  // depend on module import order.
  readonly #descriptorsBySlot = new KeyedRegistry<ScreenName, ScreenDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "screen slot",
    ownerOf: (descriptor) => descriptor.owner,
  });

  /**
   * The loader-backed screens, so `preload` has something to resolve.
   *
   * A second table rather than a member on the descriptor, for the pane board's reason:
   * the descriptor is what every MOUNT site reads and none of them has business knowing
   * whether the screen it is about to render arrived as a chunk.
   */
  readonly #loadedBodiesBySlot = new Map<ScreenName, LoaderBackedBody<ScreenContext>>();

  /** Claim a slot. A second claim by a different owner is an error, not a swap. */
  public register(registration: ScreenRegistration): void {
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
    const loadedBody = new LoaderBackedBody(registration.body, (context: ScreenContext) =>
      createElement(PendingScreenBody, { context }),
    );
    // Registered BEFORE the loader table is written, so a `register` the keyed registry
    // refuses — a different owner claiming a taken slot — cannot leave a loader behind
    // for a screen that is not the one mounting. The refusal throws past this line.
    this.#descriptorsBySlot.register(registration.slot, {
      slot: registration.slot,
      owner: registration.owner,
      render: loadedBody.render,
    });
    this.#loadedBodiesBySlot.set(registration.slot, loadedBody);
  }

  public unregister(slot: ScreenName): void {
    this.#descriptorsBySlot.unregister(slot);
    this.#loadedBodiesBySlot.delete(slot);
  }

  /**
   * Start this slot's screen loading, without navigating to it.
   *
   * The pane board's own `preload`, with its reasoning unchanged: idempotent by
   * construction, and a component-form or unregistered slot settles immediately with
   * nothing to do, so a caller preloading a destination it has not opened never has to
   * ask first whether that slot is loader-backed.
   */
  public async preload(slot: ScreenName): Promise<void> {
    await this.#loadedBodiesBySlot.get(slot)?.load();
  }

  /** Which registered slots have a screen still to load, in declaration order. */
  public unloadedKeys(): readonly ScreenName[] {
    return SCREEN_NAMES.filter((slot) => this.#loadedBodiesBySlot.get(slot)?.isResolved === false);
  }

  public descriptorFor(slot: ScreenName): ScreenDescriptor | undefined {
    return this.#descriptorsBySlot.get(slot);
  }

  public registeredSlots(): readonly ScreenName[] {
    return SCREEN_NAMES.filter((slot) => this.#descriptorsBySlot.has(slot));
  }
}

/** What every registration carries, whichever form it takes. */
interface ConsoleSurfaceRegistrationBase {
  readonly slot: ScreenName;
  readonly owner: string;
}

/** The process-wide registry the families call at module scope. */
export const screenRegistry: ScreenRegistry = new ScreenRegistry();

/** The call a 1C screen family makes to claim its slot, in either registration form. */
export function registerScreen(registration: ScreenRegistration): void {
  screenRegistry.register(registration);
}

/** Which slot a route mounts. `undefined` for routes that mount no screen. */
export function findScreenNameForRoute(route: AppRoute): ScreenName | undefined {
  switch (route.kind) {
    case "sessions":
      return "sessions";
    case "session":
      return "session";
    case "workflows":
      return "workflows";
    case "settings":
      return "settings";
    case "pane-harness":
      return "pane-harness";
    case "not-found":
      return undefined;
  }
}
