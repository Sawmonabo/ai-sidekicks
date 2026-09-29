// The screen registry: how each feature's screens reach the window.
//
// The router mounts whatever the route names, and it learns what that is from this
// registry rather than from an import. A router that imported every screen would depend
// on every feature and put all of their work behind one file.
//
// A feature registers its screens through a registrar that `app/registrations.ts` calls
// with the window's registry, naming the screen it owns and a renderer. The router
// resolves the current route to a screen name, looks the renderer up, and mounts it
// inside an error boundary. A screen name with no renderer is a composition defect, so
// the router throws rather than rendering a placeholder that looks like a broken
// feature; the one exception is the pane harness, which only a fixture launch registers.
//
// It lives in `registries/` because every feature registers into it and no feature may
// import another.

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
 * that agree until someone widens one, and the compiler notices neither: a name
 * added to the union but not the array is a name `registeredScreenNames` can never
 * report, and one added to the array but not the union does not compile at the
 * array but does everywhere it is read back.
 */
export const SCREEN_NAMES = [
  "sessions",
  "session",
  "workflows",
  "settings",
  // Reached only by the fixture-gated `#/pane-harness/…` address, so a release
  // renderer can name this screen and can never route to it. It is in the tuple
  // because the tuple is what `registeredScreenNames` and the composition test walk: a
  // name claimed by a registration but absent from the declaration is a name
  // neither of them can report on.
  "pane-harness",
] as const;

export type ScreenName = (typeof SCREEN_NAMES)[number];

export interface ScreenDescriptor {
  readonly name: ScreenName;
  /** The feature that owns it, so an unrendered screen names someone. */
  readonly owner: string;
  readonly render: (context: ScreenContext) => React.ReactNode;
}

/**
 * What a feature hands `register`, in one of exactly two forms.
 *
 * The pane board's own union, applied to routes, and decided by the same product fact:
 * a screen that is painted before a person acts belongs in the entry graph, and a
 * screen reached by pressing a rail destination or opening an auxiliary window does
 * not.
 *
 * The rail's OWN destination is the case that decides itself: whichever screen the
 * console opens on is the flagship first paint and keeps `render`.
 */
export type ScreenRegistration =
  | (ScreenRegistrationBase & {
      readonly render: (context: ScreenContext) => React.ReactNode;
      readonly body?: never;
    })
  | (ScreenRegistrationBase & {
      readonly body: LazyBodyLoader<ScreenContext>;
      readonly render?: never;
    });

export class ScreenRegistry {
  // `"owner-scoped"`: re-registering under the same owner replaces (a hot reload
  // re-runs a feature's module), and a different owner claiming a taken name is a
  // conflict rather than a swap, because which screen mounts would otherwise
  // depend on module import order.
  readonly #descriptorsByName = new KeyedRegistry<ScreenName, ScreenDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "screen",
    ownerOf: (descriptor) => descriptor.owner,
  });

  /**
   * The loader-backed screens, so `preload` has something to resolve.
   *
   * A second table rather than a member on the descriptor, for the pane board's reason:
   * the descriptor is what every MOUNT site reads and none of them has business knowing
   * whether the screen it is about to render arrived as a chunk.
   */
  readonly #loadedBodiesByName = new Map<ScreenName, LoaderBackedBody<ScreenContext>>();

  /** Claim a screen name. A second claim by a different owner is an error, not a swap. */
  public register(registration: ScreenRegistration): void {
    if (registration.body === undefined) {
      // Registered first and the loader table trimmed after, for the pane board's
      // measured reason: a refused re-registration must not strip the loader off the
      // descriptor that survives it, or a warmable screen silently stops being one.
      this.#descriptorsByName.register(registration.name, {
        name: registration.name,
        owner: registration.owner,
        render: registration.render,
      });
      this.#loadedBodiesByName.delete(registration.name);
      return;
    }
    // The fallback is the route's own absence frame, empty. Supplied here rather than by
    // the generic machinery, because what a route reserves while it loads is a
    // route-shaped question.
    const loadedBody = new LoaderBackedBody(registration.body, (context: ScreenContext) =>
      createElement(PendingScreenBody, { context }),
    );
    // Registered BEFORE the loader table is written, so a `register` the keyed registry
    // refuses — a different owner claiming a taken name — cannot leave a loader behind
    // for a screen that is not the one mounting. The refusal throws past this line.
    this.#descriptorsByName.register(registration.name, {
      name: registration.name,
      owner: registration.owner,
      render: loadedBody.render,
    });
    this.#loadedBodiesByName.set(registration.name, loadedBody);
  }

  public unregister(name: ScreenName): void {
    this.#descriptorsByName.unregister(name);
    this.#loadedBodiesByName.delete(name);
  }

  /**
   * Start this screen loading, without navigating to it.
   *
   * The pane board's own `preload`, with its reasoning unchanged: idempotent by
   * construction, and a component-form or unregistered screen settles immediately with
   * nothing to do, so a caller preloading a destination it has not opened never has to
   * ask first whether that screen is loader-backed.
   */
  public async preload(name: ScreenName): Promise<void> {
    await this.#loadedBodiesByName.get(name)?.load();
  }

  /** Which registered screens are still to load, in declaration order. */
  public unloadedKeys(): readonly ScreenName[] {
    return SCREEN_NAMES.filter((name) => this.#loadedBodiesByName.get(name)?.isResolved === false);
  }

  public descriptorFor(name: ScreenName): ScreenDescriptor | undefined {
    return this.#descriptorsByName.get(name);
  }

  public registeredScreenNames(): readonly ScreenName[] {
    return SCREEN_NAMES.filter((name) => this.#descriptorsByName.has(name));
  }
}

/** What every registration carries, whichever form it takes. */
interface ScreenRegistrationBase {
  readonly name: ScreenName;
  readonly owner: string;
}

/** The window's registry, which `app/providers.tsx` fills through `app/registrations.ts`. */
export const screenRegistry: ScreenRegistry = new ScreenRegistry();

/** Which screen a route mounts. `undefined` for routes that mount no screen. */
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
