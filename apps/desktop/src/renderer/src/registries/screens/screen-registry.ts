// How each feature's screens reach the window. The router resolves the route to a screen name,
// looks up the renderer registered here and mounts it in an error boundary, so it imports no
// feature. Registrars are called from `app/registrations.ts`. A screen name with no renderer is a
// composition defect and the router throws; only the pane harness, registered by a fixture launch,
// may be absent.

import { createElement } from "react";

import { KeyedRegistry } from "@renderer/lib/keyed-registry.js";
import { LoaderBackedBody, type LazyBodyLoader } from "@renderer/components/LazyBody/lazy-body.js";
import { PendingScreenBody } from "./PendingScreenBody.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import { type ScreenContext } from "./screen-context.js";

/**
 * Every place a screen can be mounted, one per navigable destination; `ScreenName` derives from it.
 */
export const SCREEN_NAMES = [
  "sessions",
  "session",
  "workflows",
  "settings",
  // Reached only by the fixture-gated `#/pane-harness/…` address, so a release renderer can name
  // it but never route to it. It is in the tuple because `registeredScreenNames` walks the tuple.
  "pane-harness",
] as const;

/** One screen name. */
export type ScreenName = (typeof SCREEN_NAMES)[number];

/** A registered screen: its name, owning feature and renderer. */
export interface ScreenDescriptor {
  readonly name: ScreenName;
  /** The feature that owns the screen. */
  readonly owner: string;
  readonly render: (context: ScreenContext) => React.ReactNode;
}

/**
 * What a feature hands `register`, in one of two forms, as for panes: a screen painted before a
 * person acts (the one the console opens on) keeps `render` in the entry graph, and a screen
 * reached
 * from a rail destination or another window takes the loader form.
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

/**
 * The screen descriptors by name; the same owner replaces on hot reload, another owner is refused.
 */
export class ScreenRegistry {
  readonly #descriptorsByName = new KeyedRegistry<ScreenName, ScreenDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "screen",
    ownerOf: (descriptor) => descriptor.owner,
  });

  /** The loader-backed screens, kept apart from the descriptor that mount sites read. */
  readonly #loadedBodiesByName = new Map<ScreenName, LoaderBackedBody<ScreenContext>>();

  /** Claims a screen name; a second claim by a different owner is an error, not a swap. */
  public register(registration: ScreenRegistration): void {
    if (registration.body === undefined) {
      // Register first, then trim the loader table, so a refused claim keeps the survivor's loader.
      this.#descriptorsByName.register(registration.name, {
        name: registration.name,
        owner: registration.owner,
        render: registration.render,
      });
      this.#loadedBodiesByName.delete(registration.name);
      return;
    }
    // The fallback is the route's own empty absence frame.
    const loadedBody = new LoaderBackedBody(registration.body, (context: ScreenContext) =>
      createElement(PendingScreenBody, { context }),
    );
    // The keyed registry throws on a refused claim before the loader table is written.
    this.#descriptorsByName.register(registration.name, {
      name: registration.name,
      owner: registration.owner,
      render: loadedBody.render,
    });
    this.#loadedBodiesByName.set(registration.name, loadedBody);
  }

  /** Removes a screen's descriptor and loader. */
  public unregister(name: ScreenName): void {
    this.#descriptorsByName.unregister(name);
    this.#loadedBodiesByName.delete(name);
  }

  /**
   * Starts this screen loading without navigating to it. Idempotent; a component-form or
   * unregistered screen settles immediately.
   */
  public async preload(name: ScreenName): Promise<void> {
    await this.#loadedBodiesByName.get(name)?.load();
  }

  /** Registered screens still to load, in declaration order. */
  public unloadedKeys(): readonly ScreenName[] {
    return SCREEN_NAMES.filter((name) => this.#loadedBodiesByName.get(name)?.isResolved === false);
  }

  /** The descriptor registered for a name, or `undefined`. */
  public descriptorFor(name: ScreenName): ScreenDescriptor | undefined {
    return this.#descriptorsByName.get(name);
  }

  /** Registered screen names, in declaration order. */
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
