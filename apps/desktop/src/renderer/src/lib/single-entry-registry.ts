// A `KeyedRegistry` with its key held constant, for the composer, the transcript row renderer and
// the row footer. The same owner may re-register (a hot reload), a different owner may not (which
// body renders would depend on import order), and a refusal names both owners.

import { KeyedRegistry } from "./keyed-registry.js";

/**
 * What a single-entry registry holds: who registered it, and what they render. `TRenderer` is
 * generic because each registry's renderer props are its contract.
 */
export interface SingleEntryDescriptor<TRenderer> {
  /** The feature that owns the body, so an empty registry names someone. */
  readonly owner: string;
  readonly render: TRenderer;
}

/** A registry with exactly one owner-scoped entry; a second owner claiming it is an error. */
export class SingleEntryRegistry<TRenderer> {
  readonly #registryName: string;
  readonly #descriptorsByName: KeyedRegistry<string, SingleEntryDescriptor<TRenderer>>;

  /**
   * @param registryName - The registry's name, which is also its one key. It appears in
   *   every refusal this registry raises, so it reads as a noun ("composer").
   * @param duplicateHint - One clause saying what breaks if two owners claim it.
   */
  public constructor(registryName: string, duplicateHint: string) {
    this.#registryName = registryName;
    this.#descriptorsByName = new KeyedRegistry<string, SingleEntryDescriptor<TRenderer>>({
      duplicatePolicy: "owner-scoped",
      describeWhat: `${registryName} renderer`,
      ownerOf: (descriptor) => descriptor.owner,
      duplicateHint,
    });
  }

  /** Claim the entry. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: SingleEntryDescriptor<TRenderer>): void {
    this.#descriptorsByName.register(this.#registryName, descriptor);
  }

  /** The registered descriptor, or `undefined` while the registry is empty. */
  public descriptor(): SingleEntryDescriptor<TRenderer> | undefined {
    return this.#descriptorsByName.get(this.#registryName);
  }

  /** The registered renderer, or `undefined` while the registry is empty. */
  public renderer(): TRenderer | undefined {
    return this.#descriptorsByName.get(this.#registryName)?.render;
  }
}
