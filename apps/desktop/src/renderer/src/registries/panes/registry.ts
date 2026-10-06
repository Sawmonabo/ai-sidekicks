// The pane layout's single mount registry: one owner per pane kind. The composition hands this
// table to each feature, which claims the kind it owns; the layout resolves a pane's kind to a
// descriptor and mounts it. There is no module-scope writer to the process-wide instance, since
// a feature calling one would compose into production from inside another composition.
//
// It is separate from `screens/registry.ts`: a screen is what a route mounts (at most one),
// a pane is one of several the layout holds, keyed by the entity it views. Both are
// `KeyedRegistry` with `duplicatePolicy: "owner-scoped"`.
//
// A pane may name the pane it was opened from, but only as an id passed in at mount
// (`PaneContext.linkedSourcePaneId`), never a handle, so a linked pane is still moved and closed
// on its own.

import { createElement } from "react";

import { KeyedRegistry } from "#renderer/lib/keyed-registry.js";
import { LoaderBackedBody, type LazyBodyLoader } from "#renderer/components/LazyBody/loader.js";
import { PendingPaneBody } from "./PendingPaneBody.js";
import { type PaneContext } from "./context.js";
import { PANE_KINDS, type PaneKind } from "#renderer/routing/panes/kinds.js";

/** What a feature registers to claim a pane kind. */
export interface PaneDescriptor {
  readonly kind: PaneKind;
  /** The feature that owns the kind. */
  readonly owner: string;
  readonly render: (context: PaneContext) => React.ReactNode;
}

/**
 * What a feature hands `register`, in one of two forms. The component form is a `render` the
 * registrar already holds, for a body on the first paint. The loader form is
 * `body: () => import("./pane/XBody.js")`, for a body painted only after a person acts. A union
 * with `never` arms, so the compiler refuses a registration carrying both or neither.
 */
export type PaneRegistration =
  | (PaneRegistrationBase & {
      readonly render: (context: PaneContext) => React.ReactNode;
      readonly body?: never;
    })
  | (PaneRegistrationBase & {
      readonly body: LazyBodyLoader<PaneContext>;
      readonly render?: never;
    });

/** The pane kinds' descriptors; the same owner replaces on hot reload, another owner is refused. */
export class PaneRegistry {
  readonly #descriptorsByKind = new KeyedRegistry<PaneKind, PaneDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "pane kind",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the pane layout mounts one body per pane kind, from one registration",
  });

  /**
   * The loader-backed bodies, so `preload` has something to resolve. Kept apart from the
   * descriptor so both registration forms produce one descriptor shape for mount sites.
   */
  readonly #loadedBodiesByKind = new Map<PaneKind, LoaderBackedBody<PaneContext>>();

  /**
   * Claims a pane kind; a second claim by a different owner is an error, not a swap. A loader-form
   * registration gets one `LoaderBackedBody` (one memoized promise, one stable lazy component)
   * and a descriptor whose `render` mounts it, so nothing downstream branches on the form.
   */
  public register(registration: PaneRegistration): void {
    if (registration.body === undefined) {
      // Register first, then trim the loader table, so a refused claim throws before dropping the
      // loader that belongs to the surviving descriptor.
      this.#descriptorsByKind.register(registration.kind, {
        kind: registration.kind,
        owner: registration.owner,
        render: registration.render,
      });
      this.#loadedBodiesByKind.delete(registration.kind);
      return;
    }
    // The fallback is the pane's own empty chrome.
    const loadedBody = new LoaderBackedBody(registration.body, (context: PaneContext) =>
      createElement(PendingPaneBody, { context }),
    );
    // The keyed registry may refuse below, and it throws before the loader table is written, so a
    // refused claim leaves no loader behind.
    this.#descriptorsByKind.register(registration.kind, {
      kind: registration.kind,
      owner: registration.owner,
      render: loadedBody.render,
    });
    this.#loadedBodiesByKind.set(registration.kind, loadedBody);
  }

  /** Removes a kind's descriptor and loader. */
  public unregister(kind: PaneKind): void {
    this.#descriptorsByKind.unregister(kind);
    this.#loadedBodiesByKind.delete(kind);
  }

  /**
   * Starts this kind's body loading without opening it. Idempotent: the promise is memoized, so
   * repeated calls cost one fetch. A component-form or unregistered kind settles immediately, so
   * callers need not ask whether the kind is loader-backed.
   */
  public async preload(kind: PaneKind): Promise<void> {
    await this.#loadedBodiesByKind.get(kind)?.load();
  }

  /**
   * Registered kinds whose body is still to load, in declaration order, so the warm walk's order
   * does not depend on module evaluation. Resolved kinds are filtered out.
   */
  public unloadedKeys(): readonly PaneKind[] {
    return PANE_KINDS.filter((kind) => this.#loadedBodiesByKind.get(kind)?.isResolved === false);
  }

  /** The descriptor registered for a kind, or `undefined`. */
  public descriptorFor(kind: PaneKind): PaneDescriptor | undefined {
    return this.#descriptorsByKind.get(kind);
  }

  /**
   * Kinds with a body, in declaration order so readers do not depend on module evaluation order.
   */
  public registeredPaneKinds(): readonly PaneKind[] {
    return PANE_KINDS.filter((kind) => this.#descriptorsByKind.has(kind));
  }
}

/** What every registration carries, whichever form it takes. */
interface PaneRegistrationBase {
  readonly kind: PaneKind;
  readonly owner: string;
}

/** The process-wide pane registry. */
export const paneRegistry: PaneRegistry = new PaneRegistry();
