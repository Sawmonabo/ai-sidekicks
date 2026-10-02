// One airspace registry per renderer document: a document's overlays and native views yield only
// to its own dialogs.
//
// Keyed on the document rather than a platform bridge: the overlay components that must reach
// the same registry sit below `services/` in the import layering and cannot name a bridge.
// A class keeps the table private so the accessor is the only way to mint a registry.

import { AirspaceRegistry } from "./airspace-registry.js";

/**
 * The window an airspace belongs to, named by its own document.
 *
 * Opaque because `lib/` is also compiled by programs with no DOM lib; it is a WeakMap key and
 * no property of it is read.
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
 * Held weakly, so a torn-down window takes its registry with it.
 */
export function airspaceRegistryFor(ownerDocument: AirspaceOwnerDocument): AirspaceRegistry {
  return windowAirspaceRegistries.forDocument(ownerDocument);
}
