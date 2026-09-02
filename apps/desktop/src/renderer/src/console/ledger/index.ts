// The ledger family's door, and the two surfaces it mounts.
//
// WHAT THIS FAMILY IS. The ledger is the console's signature surface: the work log
// a session reads as, plus the deck that holds it. It spans three directories —
// `ledger/` (the frame, the structure, the cards), `panes/timeline/` (the pane body
// the deck mounts), and `workspace/` (the seats every family hands work through) —
// and they are one family, so imports between them are intra-family and deep while
// every import of another family goes through that family's own door.
//
// WHY THE REGISTRATION LIVES IN THE BARREL RATHER THAN BESIDE IT. What follows is a
// TABLE — which slot, which owner, and what mounts there — not a view, which is
// `frame/legacy-surfaces.ts`' reason for the same shape. Split into a component file
// it would be one element per file with the table itself spread across three places;
// left here it is the one thing a reader opening this family wants first.
//
// WHY `frame/surface-registry.js` IS REACHED DEEP AND NOT THROUGH `frame/index.js`.
// Not a shortcut, and not a lapse — the barrel route is a CYCLE. `frame/index.ts`
// exports `ConsoleRoot`, `ConsoleRoot.tsx` imports `console/families.ts` so a window
// and its composed families are one fact, and `families.ts` imports this file. An
// edge from here to `frame/index.js` closes that loop and the layering gate fails
// the build on it. `console/families.ts` reaches the same module the same way for
// the same reason. `surface-registry.ts` imports nothing above `bridge/`, so this
// edge stays a strict descent through the DAG.
//
// THE TWO SLOTS. `workspace` is the session's own surface and `timeline` is the
// full-screen ledger window (`Spec-023 §Console Design (Meridian)` §5.20: "the same
// pane at full width with the rail, replay, and find, and no composer"). Both mount
// the same pane today, which is the design's own empty deck state — "no panes: the
// workspace shows the ledger alone, full width". The rail, replay, find, and the
// composer's absence arrive with the lanes that author them.

import { createElement, type ReactNode } from "react";

import { SurfaceAbsence } from "../frame/RouteSurface.js";
import {
  type ConsoleSurfaceContext,
  type ConsoleSurfaceDescriptor,
  type ConsoleSurfaceRegistry,
} from "../frame/surface-registry.js";
import { Nothing } from "../primitives/index.js";
import { consolePaneRegistry, type ConsolePaneContext } from "../workspace/index.js";

import "./ledger.css";

export * from "./cards/index.js";
export * from "./frame/index.js";
export * from "./structure/index.js";

/**
 * The owner string every ledger claim carries.
 *
 * One binding rather than a literal per descriptor: the surface registry's
 * duplicate policy is owner-scoped, so re-registering under the same owner replaces
 * and a different owner is refused by name. Two spellings of this family's own name
 * would make a hot reload a collision.
 */
const LEDGER_SURFACE_OWNER = "ledger";

/**
 * The deck's single pane, while the deck holds exactly one.
 *
 * `ConsolePaneContext.paneId` is a pane's identity across a layout restore, so it is
 * a value rather than an index: the lane that ships the deck mints one per pane and
 * this constant retires with the single-pane arm.
 */
const LEDGER_PANE_ID = "ledger-timeline";

const LEDGER_SURFACES: readonly ConsoleSurfaceDescriptor[] = [
  { slot: "workspace", owner: LEDGER_SURFACE_OWNER, render: mountLedgerDeck },
  { slot: "timeline", owner: LEDGER_SURFACE_OWNER, render: mountLedgerDeck },
];

/**
 * Claim the two surfaces the ledger mounts.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsoleFamilies`' reason: a test composes into a registry it owns and an
 * auxiliary window composes a subset without a second code path.
 */
export function registerLedger(registry: ConsoleSurfaceRegistry): void {
  for (const descriptor of LEDGER_SURFACES) {
    registry.register(descriptor);
  }
}

/**
 * Mount the ledger through the deck's own door.
 *
 * The pane body is resolved from the pane registry rather than imported, which is
 * `Spec-023 §Console Design (Meridian)` §4.2's "one entity, one pane … a single
 * mount door" applied at the only place a pane is mounted today. Importing
 * `panes/timeline/` here would also close a cycle the moment that body reaches back
 * into this family for the frame, which it will.
 *
 * Resolution happens during render, on `RouteSurface`'s reasoning: the pane seat
 * board is composed at module scope before any window renders, so a descriptor is
 * there to be looked up on the first pass.
 */
function mountLedgerDeck(context: ConsoleSurfaceContext): ReactNode {
  const descriptor = consolePaneRegistry.descriptorFor("timeline");
  if (descriptor === undefined) {
    // Reserved, not stubbed. Unreachable while the pane seat board composes this
    // family, and rendered honestly rather than assumed away: the descriptor is
    // resolved from a registry anything holding it can compose differently.
    return createElement(
      SurfaceAbsence,
      null,
      createElement(Nothing, {
        kind: "empty",
        placement: "surface",
        title: "The ledger has no body to mount.",
        detail: "No timeline pane is registered in this window.",
      }),
    );
  }
  return createElement(
    "div",
    { className: "meridian-ledger-surface" },
    descriptor.render(ledgerPaneContext(context)),
  );
}

/**
 * What the single pane is handed.
 *
 * `entity` is `undefined` because this timeline is scoped to the session rather than
 * to one of its entities, and `focusHue` is `undefined` for the reason the seat
 * states: the ring takes an actor's hue only where the pane's entity is a run or an
 * agent, and an unattributed pane takes the neutral boundary rather than somebody
 * else's colour.
 */
function ledgerPaneContext(context: ConsoleSurfaceContext): ConsolePaneContext {
  return {
    kind: "timeline",
    entity: undefined,
    paneId: LEDGER_PANE_ID,
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: context.sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    focusHue: undefined,
  };
}
