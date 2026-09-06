// The surface registry: how the six 1C families reach the screen.
//
// The frame mounts whatever the route names, and it learns what that is from this
// registry rather than from an import. The reason is parallel delivery: six families
// build six surfaces at once, and a frame that imported all six would serialize them
// behind one file and make every merge a conflict in that file.
//
// A family calls `registerConsoleSurface` at module scope with the slot it owns and
// a renderer. The frame resolves the current route to a slot, looks the renderer up,
// and mounts it inside an error boundary. A slot with no renderer is the
// "reserved, not stubbed" rule in action: the frame says the surface has not been
// built rather than rendering a placeholder that looks like a broken feature.
//
// IT LIVES IN `seats/` AND NOT IN `frame/`, WHERE IT WAS WRITTEN. This is a contract
// through which a view family hands the frame a body, which is what this family is
// for, and its inputs stop at `bridge/` — `core/`'s keyed registry, the bridge
// contract, the two stores, the two persistence stores, the route union — so the
// lowest home above all of them is the slot immediately above `bridge/`, which is
// here. In `frame/` it was the console's last named layering exemption: a view family
// cannot import `frame/index.ts` (that door reaches `ConsoleRoot`, which reaches
// `families.ts`, which composes every view family in), so every family wrote a deep
// specifier past the frame's door and `.dependency-cruiser.mjs` carried a
// module-named subtraction to tolerate it. The move deletes the subtraction, and
// `console-cross-family-deep-import` now covers the whole console with no exception.

import { KeyedRegistry } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { type FrameStore, type SessionStore, type SessionStoreRegistry } from "../store/index.js";
import { type DraftStore, type UiStateStore } from "../persistence/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import type { ConsolePaneRegistry } from "./pane-registry.js";

/**
 * Every place a surface can be mounted. Closed; one per navigable destination.
 *
 * The tuple is the declaration and the union is derived from it. Written the other
 * way round — a union beside a hand-repeated array — the two are two closed sets
 * that agree until someone widens one, and the compiler notices neither: a slot
 * added to the union but not the array is a slot `registeredSlots` can never
 * report, and one added to the array but not the union does not compile at the
 * array but does everywhere it is read back.
 */
export const CONSOLE_SURFACE_SLOTS = [
  "sessions",
  "workspace",
  "workflows",
  "settings",
  "timeline",
  "agent-console",
  // Reached only by the fixture-gated `#/pane-harness/…` address, so a release
  // renderer can name this slot and can never route to it. It is in the tuple
  // because the tuple is what `registeredSlots` and the composition test walk: a
  // slot claimed by a registration but absent from the declaration is a slot
  // neither of them can report on.
  "pane-harness",
] as const;

export type ConsoleSurfaceSlot = (typeof CONSOLE_SURFACE_SLOTS)[number];

/** Everything a surface is handed. Nothing here is global; all of it is per window. */
export interface ConsoleSurfaceContext {
  readonly route: ConsoleRoute;
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  /** The session store for the route's session, or `undefined` on a bare route. */
  readonly sessionStore: SessionStore | undefined;
  /**
   * Every session this window has open — the only session set the renderer can
   * name, since no bridge member lists a node's sessions. A surface that has to
   * OFFER sessions reads it; a surface that renders one reads `sessionStore`.
   */
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /**
   * The pane board THIS composition registered its bodies into.
   *
   * On the context rather than reached for, and here rather than as one surface's
   * prop, because it is the same fact for every family: a surface that opens a pane
   * has to resolve it from the board the composition around it filled.
   * `registerConsoleFamilies` already takes the board as a parameter so a test and an
   * auxiliary window can compose their own — and a surface that then read the
   * process-wide singleton would hand that composition a production body, or the
   * reserved absence where production has none, however carefully it had asked.
   *
   * Required rather than defaulted to the singleton, on the composition site's own
   * rule: a default is the same hard-coding one parameter along, and a caller that
   * forgets it still reads production.
   */
  readonly paneRegistry: ConsolePaneRegistry;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
}

export interface ConsoleSurfaceDescriptor {
  readonly slot: ConsoleSurfaceSlot;
  /** The task or family that owns it, so an unrendered slot names someone. */
  readonly owner: string;
  readonly render: (context: ConsoleSurfaceContext) => React.ReactNode;
}

export class ConsoleSurfaceRegistry {
  // `"owner-scoped"`: re-registering under the same owner replaces (a hot reload
  // re-runs a family's module), and a different owner claiming a taken slot is a
  // conflict rather than a swap, because which surface mounts would otherwise
  // depend on module import order.
  readonly #descriptorsBySlot = new KeyedRegistry<ConsoleSurfaceSlot, ConsoleSurfaceDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "surface slot",
    ownerOf: (descriptor) => descriptor.owner,
  });

  /** Claim a slot. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: ConsoleSurfaceDescriptor): void {
    this.#descriptorsBySlot.register(descriptor.slot, descriptor);
  }

  public unregister(slot: ConsoleSurfaceSlot): void {
    this.#descriptorsBySlot.unregister(slot);
  }

  public descriptorFor(slot: ConsoleSurfaceSlot): ConsoleSurfaceDescriptor | undefined {
    return this.#descriptorsBySlot.get(slot);
  }

  public registeredSlots(): readonly ConsoleSurfaceSlot[] {
    return CONSOLE_SURFACE_SLOTS.filter((slot) => this.#descriptorsBySlot.has(slot));
  }
}

/** The process-wide registry the families call at module scope. */
export const consoleSurfaceRegistry: ConsoleSurfaceRegistry = new ConsoleSurfaceRegistry();

/** The call a 1C surface family makes to claim its slot. */
export function registerConsoleSurface(descriptor: ConsoleSurfaceDescriptor): void {
  consoleSurfaceRegistry.register(descriptor);
}

/** Which slot a route mounts. `undefined` for routes that mount no surface. */
export function surfaceSlotFor(route: ConsoleRoute): ConsoleSurfaceSlot | undefined {
  switch (route.kind) {
    case "sessions":
      return "sessions";
    case "workspace":
      return "workspace";
    case "workflows":
      return "workflows";
    case "settings":
      return "settings";
    case "pane-harness":
      return "pane-harness";
    case "auxiliary":
      return route.route === "timeline" ? "timeline" : "agent-console";
    case "not-found":
      return undefined;
  }
}
