// Which airspace registry each window holds.
//
// One registry per renderer document, which is what "one per renderer process" means:
// an auxiliary window is its own renderer with its own overlays and its own native
// views, and two windows must not yield to each other's dialogs.
//
// KEYED ON THE DOCUMENT, not on the platform bridge: the overlay components that have
// to reach the same instance sit below `services/` in the import layering and cannot
// name a bridge. The document is what an overlay element and a pane host already share when
// they are in one window, and it is what they do not share when they are not, so it
// is the key both sides can name and the key that means what the rule means.
//
// A class with a private table and not a bare module-level `WeakMap`, on this
// package's rule and on `lib/reads/generation-latch.ts`'s precedent for the identical
// role: state a module owns in the open is state any later line in the module can
// reach around the one accessor that keeps its mint-once discipline.

import { AirspaceRegistry } from "./airspace-registry.js";

/**
 * The window an airspace belongs to, named by its own document.
 *
 * Opaque for `airspace-registry.ts`'s reason — `core/` compiles with no DOM lib, so
 * `Document` does not resolve here to the thing a caller passes. It is a WeakMap key
 * and nothing else: no property of it is ever read.
 */
export type AirspaceOwnerDocument = object;

class WindowAirspaceRegistries {
  readonly #registriesByDocument = new WeakMap<AirspaceOwnerDocument, AirspaceRegistry>();

  /** The one registry this document's overlays and native views share. */
  public forDocument(ownerDocument: AirspaceOwnerDocument): AirspaceRegistry {
    const held = this.#registriesByDocument.get(ownerDocument);
    if (held !== undefined) {
      return held;
    }
    const created = new AirspaceRegistry();
    this.#registriesByDocument.set(ownerDocument, created);
    return created;
  }
}

const windowAirspaceRegistries = new WindowAirspaceRegistries();

/**
 * The one airspace this document's overlays register into.
 *
 * Held weakly by the document, so a torn-down auxiliary window takes its registry
 * with it and a test that mints a document per case gets a registry per case.
 */
export function airspaceRegistryFor(ownerDocument: AirspaceOwnerDocument): AirspaceRegistry {
  return windowAirspaceRegistries.forDocument(ownerDocument);
}
