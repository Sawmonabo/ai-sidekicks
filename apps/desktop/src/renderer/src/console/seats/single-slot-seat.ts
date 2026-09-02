// A seat with exactly one occupant, owner-scoped.
//
// Two of this family's seats hold one body rather than a keyed table — the
// composer (one message input per session view) and the timeline row slot (one
// renderer for every row). Both want the same three properties the pane and
// sidebar registries want: the same owner may re-register (a hot reload re-runs
// the owning family's module), a different owner may not (which body renders would
// otherwise depend on module import order), and a refusal names both owners.
//
// So this is `KeyedRegistry` with the key held constant, hoisted on its second use
// rather than written twice. It is deliberately NOT a second registry primitive:
// the policy, the refusal shape, and the owner comparison all still come from
// `core/keyed-registry.ts`, and this class only fixes the key.
//
// Intra-family: the seats import it deep and the barrel does not re-export it. A
// caller outside this family that wanted a single-slot seat would be minting a
// seam, and minting seams is what this family is for.

import { KeyedRegistry } from "../core/index.js";

/**
 * What a single-slot seat holds: who registered it, and what they render.
 *
 * `TRenderer` rather than a fixed function type because each seat's renderer takes
 * its own props — the point of the seat is that those props are the contract, and
 * a shared renderer type would erase exactly the part that matters.
 */
export interface SingleSlotSeatDescriptor<TRenderer> {
  /** The task or family that owns the body, so an empty seat names someone. */
  readonly owner: string;
  readonly render: TRenderer;
}

export class SingleSlotSeat<TRenderer> {
  readonly #seatName: string;
  readonly #descriptorsBySeatName: KeyedRegistry<string, SingleSlotSeatDescriptor<TRenderer>>;

  /**
   * @param seatName - The seat's name, which is also its one key. It appears in
   *   every refusal this seat raises, so it reads as a noun ("composer seat").
   * @param duplicateHint - One clause saying what breaks if two owners claim it.
   */
  public constructor(seatName: string, duplicateHint: string) {
    this.#seatName = seatName;
    this.#descriptorsBySeatName = new KeyedRegistry<string, SingleSlotSeatDescriptor<TRenderer>>({
      duplicatePolicy: "owner-scoped",
      describeWhat: `${seatName} seat`,
      ownerOf: (descriptor) => descriptor.owner,
      duplicateHint,
    });
  }

  /** Claim the seat. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: SingleSlotSeatDescriptor<TRenderer>): void {
    this.#descriptorsBySeatName.register(this.#seatName, descriptor);
  }

  public unregister(): void {
    this.#descriptorsBySeatName.unregister(this.#seatName);
  }

  public descriptor(): SingleSlotSeatDescriptor<TRenderer> | undefined {
    return this.#descriptorsBySeatName.get(this.#seatName);
  }

  /** The registered renderer, or `undefined` while the seat is empty. */
  public renderer(): TRenderer | undefined {
    return this.#descriptorsBySeatName.get(this.#seatName)?.render;
  }
}
