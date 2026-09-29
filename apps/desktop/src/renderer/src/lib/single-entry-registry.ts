// A registry with exactly one entry, owner-scoped.
//
// Three registries hold one body rather than a keyed table: the composer (one message
// input per session view), the transcript row renderer (one renderer for every row), and
// the row footer beneath it. Each wants the same three properties the pane and screen
// registries want: the same owner may re-register (a hot reload re-runs the owning
// feature's module), a different owner may not (which body renders would otherwise
// depend on module import order), and a refusal names both owners.
//
// So this is `KeyedRegistry` with the key held constant, hoisted on its second use
// rather than written twice. It is deliberately NOT a second registry primitive:
// the policy, the refusal shape, and the owner comparison all still come from
// `core/keyed-registry.ts`, and this class only fixes the key.

import { KeyedRegistry } from "./keyed-registry.js";

/**
 * What a single-entry registry holds: who registered it, and what they render.
 *
 * `TRenderer` rather than a fixed function type because each registry's renderer takes
 * its own props — the point of the registry is that those props are the contract, and
 * a shared renderer type would erase exactly the part that matters.
 */
export interface SingleEntryDescriptor<TRenderer> {
  /** The feature that owns the body, so an empty registry names someone. */
  readonly owner: string;
  readonly render: TRenderer;
}

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

  public unregister(): void {
    this.#descriptorsByName.unregister(this.#registryName);
  }

  public descriptor(): SingleEntryDescriptor<TRenderer> | undefined {
    return this.#descriptorsByName.get(this.#registryName);
  }

  /** The registered renderer, or `undefined` while the registry is empty. */
  public renderer(): TRenderer | undefined {
    return this.#descriptorsByName.get(this.#registryName)?.render;
  }
}
