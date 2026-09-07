// The frame-lifetime binding seat: how a view family keeps a read live for as long
// as the window is, rather than for as long as one destination is on screen.
//
// WHAT THE OTHER FOUR SEATS CANNOT DO. A surface, a pane, a sidebar section, and an
// inline card are all BODIES — each is mounted when something is looking at it and
// unmounted when the route moves on, which is correct for a body and wrong for a
// fact the frame renders. The rail's attention count is the measured case: the read
// that produces it lives in a view family, the rail that draws it is frame chrome,
// and while the read was mounted by the sessions destination the count vanished the
// moment a person navigated away — leaving the rail suppressed on a machine that was
// perfectly reachable, which is the "stale versus absent" distinction the design's
// degraded rule is built on, answered wrongly.
//
// SO A BINDING IS A SEAT WITH A DIFFERENT LIFETIME AND NOT A DIFFERENT SHAPE. A
// family registers one exactly as it registers a surface — slot, owner, and a mount
// function — and the frame mounts every registered one ONCE, around its own subtree,
// for as long as the window holds a bridge. It goes up with the frame and comes down
// with the frame, and no route decides either.
//
// IT WRAPS RATHER THAN SITS BESIDE, and that is the half that makes it worth a seat.
// A binding that only ran hooks could publish into the frame store and nothing more,
// which forces every value it produces through a store that sits BELOW the family
// that owns the vocabulary — so a reading with a view family's own types could never
// travel that way. Wrapping the subtree means the family provides its own value
// through its own context, in its own types, and the destination that used to perform
// the read consumes the one the binding performs instead. One read, one subscription,
// two readers.
//
// WHAT A BINDING MAY NOT DO. It renders no markup of its own: whatever it returns has
// to carry the children it was handed, and a binding drawing a body would be a
// surface that no route can reach and no person can leave. That is a rule about what
// a family writes rather than something this module can check, and it is the same
// rule every other seat here carries.

import { KeyedRegistry } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { type FrameStore, type SessionStoreRegistry } from "../store/index.js";
import type { ReactNode } from "react";

/**
 * Every binding a frame can mount. Closed; one per family-owned frame-lifetime read.
 *
 * The tuple is the declaration and the union is derived from it, on
 * `CONSOLE_SURFACE_SLOTS`' rule: a union written beside a hand-repeated array is two
 * closed sets that agree until someone widens one, and a slot in the union but not
 * the array is a slot `registeredSlots` can never report.
 */
export const FRAME_BINDING_SLOTS = ["session-attention"] as const;

/** One frame-lifetime binding. Derived from the enumeration, never restated. */
export type FrameBindingSlot = (typeof FRAME_BINDING_SLOTS)[number];

/**
 * What a binding is handed — and deliberately NOT `ConsoleSurfaceContext`.
 *
 * Three identities, every one of them stable for the window's whole life: the
 * resolved bridge, the frame store, and the session-store registry. A surface context
 * is composed fresh on every frame render and carries the route, so a binding keyed on
 * one would rebuild its read on a pass nothing moved on and would hold a value that
 * changes when a person navigates — which is the exact lifetime a binding exists to
 * escape.
 */
export interface FrameBindingContext {
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  readonly sessionStoreRegistry: SessionStoreRegistry;
}

/** What a binding's mount receives: what it may read, and the subtree it wraps. */
export interface FrameBindingProps {
  readonly context: FrameBindingContext;
  readonly children: ReactNode;
}

export interface FrameBindingDescriptor {
  readonly slot: FrameBindingSlot;
  /** The family that owns it, so an unmounted binding names someone. */
  readonly owner: string;
  /**
   * The element that holds the binding's hooks, wrapped around `children`.
   *
   * A function returning an element rather than a component type, on the surface
   * registry's own shape: what a family hands over is `createElement(TheBinding, …)`,
   * so the hooks run inside the family's own component and get their own instance,
   * their own state, and their own place in the tree.
   */
  readonly mount: (props: FrameBindingProps) => ReactNode;
}

export class FrameBindingRegistry {
  // `"owner-scoped"`, on the surface registry's rule and for its reason: a hot reload
  // re-runs a family's module and must replace, while a second owner claiming a
  // binding slot is a conflict rather than a swap — otherwise which read a window
  // performs would depend on module import order.
  readonly #descriptorsBySlot = new KeyedRegistry<FrameBindingSlot, FrameBindingDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "frame binding",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint:
      "a frame binding is mounted once per window, so a second owner would mean two reads of one thing",
  });

  /** Claim a binding slot. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: FrameBindingDescriptor): void {
    this.#descriptorsBySlot.register(descriptor.slot, descriptor);
  }

  public unregister(slot: FrameBindingSlot): void {
    this.#descriptorsBySlot.unregister(slot);
  }

  public descriptorFor(slot: FrameBindingSlot): FrameBindingDescriptor | undefined {
    return this.#descriptorsBySlot.get(slot);
  }

  /** Which slots hold a binding, in declaration order. */
  public registeredSlots(): readonly FrameBindingSlot[] {
    return FRAME_BINDING_SLOTS.filter((slot) => this.#descriptorsBySlot.has(slot));
  }
}

/** The process-wide registry a composition hands out. */
export const frameBindingRegistry: FrameBindingRegistry = new FrameBindingRegistry();

/**
 * Wrap a frame's subtree in every binding the composition registered.
 *
 * DECLARATION ORDER, OUTERMOST FIRST, so the nesting a family sees is the order the
 * tuple states rather than the order modules happened to evaluate in. A binding whose
 * value another binding needed would be a dependency neither has declared — the seat
 * board's own rule one layer down — so the order here is legibility and never a
 * mechanism a family may lean on.
 *
 * A slot nothing registered contributes no element at all rather than an empty
 * wrapper: an unfilled binding seat is the reserved-not-stubbed state, and a
 * pass-through component in the tree would be a mount, a reconciliation node, and a
 * name in the profiler standing for a family that has not landed.
 */
export function mountFrameBindings(
  registry: FrameBindingRegistry,
  context: FrameBindingContext,
  children: ReactNode,
): ReactNode {
  return [...FRAME_BINDING_SLOTS].reverse().reduce<ReactNode>((wrapped, slot) => {
    const descriptor = registry.descriptorFor(slot);
    return descriptor === undefined ? wrapped : descriptor.mount({ context, children: wrapped });
  }, children);
}
