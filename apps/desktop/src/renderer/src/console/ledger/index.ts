// The ledger family's door, and the two surfaces it mounts.
//
// WHAT THIS FAMILY IS. The ledger is the console's signature surface: the work log a
// session reads as. It is authored in two directories — `ledger/` (the frame, the
// structure, the cards) and `panes/timeline/` (the pane body the deck mounts), the
// second of which sits on the pane seat board and so may name more than one family.
// The deck that HOLDS it is `workspace/`, and that is a sibling view family rather
// than a third directory of this one: the seat contracts both of them speak now live
// in `seats/`, below the frame, and the one thing this family still needs from the
// workspace — the component the session's own surface mounts — arrives as a
// composition argument from `families.ts` rather than as an import. A view family
// importing another is the edge `structure:layering` forbids outright.
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
// THE TWO SLOTS, AND WHY THEY NO LONGER MOUNT THE SAME THING. `workspace` is the
// session's own surface: the cast bar, the deck, and the composer's seat, which is
// `workspace/Workspace.tsx`. `timeline` is the full-screen ledger WINDOW
// `Spec-023 §The surface set` names — a `timeline` pane "moved into their own
// hardened `BrowserWindow`", loading "the same renderer bundle at a window route" — so
// it mounts the pane alone: no deck around it, because an auxiliary window holds one
// pane, and no composer, because the composer is the session workspace's chrome and this
// window is not that workspace. The rail,
// replay, and find arrive with the lanes that author them.

import { createElement, type ComponentType, type ReactNode } from "react";

import { consoleCommandSurface } from "../frame/command-surface.js";
import { SurfaceAbsence } from "../frame/RouteSurface.js";
import {
  type ConsoleSurfaceContext,
  type ConsoleSurfaceDescriptor,
  type ConsoleSurfaceRegistry,
} from "../frame/surface-registry.js";
import { Nothing } from "../primitives/index.js";
import { routeSessionId } from "../routing/index.js";
import { consolePaneRegistry, type ConsolePaneContext } from "../seats/index.js";
import { registerFixtureShellRows } from "./cards/FixtureShellRows.js";
import { registerLedgerCommands } from "./structure/structure-commands.js";

import "./ledger.css";

// This door carries the family's REGISTRATIONS and no pieces.
//
// `registerLedger` claims the surfaces and contributes the family's palette rows
// and chords, and `registerFixtureShellRows` fills the row seat on its own — which a caller mounting the pane without the surfaces
// around it needs, and which the accessibility tier is. Both are acts rather than
// parts, which is what makes them the door's business.
//
// The three sub-barrels this used to re-export upward were reached by no importer
// at all: the pane, the feed, and the cards reach `cards/`, `frame/`, and
// `structure/` by their own paths, which is what an intra-family import is for. So
// re-exporting them here published seventy-six symbols nobody asked for, and the
// dead-code gate reported exactly that.

export { registerFixtureShellRows } from "./cards/FixtureShellRows.js";

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

/**
 * What the composition root supplies this family, because this file may not import it.
 *
 * The session workspace's body lives in `workspace/`, which is a VIEW FAMILY — and view
 * families are siblings rather than a ladder, so one may not import another and
 * `structure:layering`'s `console-view-family-isolation` rule reports the edge. The
 * component arrives as a parameter instead, named by `families.ts`, which sits above
 * every family and is the one file allowed to name more than one. That is the shape
 * `frame/legacy-surfaces.ts` already takes for the same reason, one layer down.
 *
 * The COMPONENT rather than a built element: which component mounts is the root's
 * decision, and what it is handed is this file's — the surface context exists only when
 * the slot renders, which is long after the root registered it.
 */
export interface LedgerComposition {
  readonly workspace: ComponentType<WorkspaceMountProps>;
}

/**
 * What the workspace slot hands its body.
 *
 * Derived from the surface context rather than restated, so a member added there is
 * carried here without a second declaration to keep in step. `sessionStoreRegistry` is
 * subtracted because the workspace renders ONE session — a surface that has to offer
 * sessions reads the registry, and this one is handed the session it is a view of.
 */
type WorkspaceMountProps = Omit<ConsoleSurfaceContext, "sessionStoreRegistry">;

/** The two slots this family claims, given the body the root composed in. */
function ledgerSurfaces(composition: LedgerComposition): readonly ConsoleSurfaceDescriptor[] {
  return [
    {
      slot: "workspace",
      owner: LEDGER_SURFACE_OWNER,
      render: (context) => mountWorkspace(context, composition.workspace),
    },
    { slot: "timeline", owner: LEDGER_SURFACE_OWNER, render: mountLedgerPane },
  ];
}

/**
 * Claim the two surfaces the ledger mounts.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsoleFamilies`' reason: a test composes into a registry it owns and an
 * auxiliary window composes a subset without a second code path.
 */
export function registerLedger(
  registry: ConsoleSurfaceRegistry,
  composition: LedgerComposition,
): void {
  // The row seat is filled here rather than by importing `FixtureShellRows.tsx` for
  // its side effect, because a module whose IMPORT registers a seat cannot be
  // composed twice and the seat's owner scoping would refuse the second composition
  // rather than replace it. Registering from this function makes it idempotent: the
  // seat admits a re-registration by the same owner, which is what a second window
  // and a hot reload both are.
  //
  // AND IT IS DELETED WITH THE SHELL. `seats/timeline-row-slot.ts` states
  // the absorb-by-import rule: the change that registers the timeline subtree's real
  // rows deletes this call, `FixtureShellRows.tsx`, and `fixture-shell-projection.ts`
  // in the same diff. A shell left registered beside the real row does not render
  // both — it refuses the real one by name, at import time.
  registerFixtureShellRows();
  // And the family's palette rows and chords, through the frame's contribution
  // door rather than through this function's argument: the surface registry it was
  // handed is the SURFACE table, and the commands go in the command table. Both
  // claims are owner-scoped, so composing this family twice replaces its rows in
  // each of them.
  //
  // What the commands act on is resolved when one is pressed, from whichever ledger
  // is mounted then (`structure/mounted-ledger.ts`) — a command contributed here
  // cannot close over a feed, because composition happens before any window has one.
  registerLedgerCommands(consoleCommandSurface);
  for (const descriptor of ledgerSurfaces(composition)) {
    registry.register(descriptor);
  }
}

/**
 * Mount the session workspace: the cast bar, the deck, and the composer's seat.
 *
 * The wrapper keeps the surface's full-height grid, which is what lets the deck
 * inside it be the thing that scrolls rather than the window.
 *
 * WHY THE KEY, AND WHY A KEY IS THE RIGHT INSTRUMENT. The workspace holds per-session
 * state that nothing else resets: the deck's arrangement, and the record of which
 * panes are showing in windows of their own. The shell deliberately OPENS session
 * stores and never closes them on navigation, so moving from one already-open session
 * to another re-renders this position rather than unmounting it — and every one of
 * those pieces would carry the first session's panes and windows into the second. A
 * key on the session is what makes the subtree's lifetime match the thing it holds
 * state about; the alternative is a reset effect per piece, which is the same rule
 * written once per field and forgotten on the next one.
 */
function mountWorkspace(
  context: ConsoleSurfaceContext,
  Workspace: ComponentType<WorkspaceMountProps>,
): ReactNode {
  return createElement(
    "div",
    { className: "meridian-ledger-surface" },
    createElement(Workspace, {
      key: routeSessionId(context.route) ?? "no-session",
      bridge: context.bridge,
      frameStore: context.frameStore,
      sessionStore: context.sessionStore,
      uiStateStore: context.uiStateStore,
      draftStore: context.draftStore,
      route: context.route,
    }),
  );
}

/**
 * Mount the ledger's pane alone, through the deck's own door.
 *
 * The pane body is resolved from the pane registry rather than imported, which is
 * `Spec-023 §The surface set`'s "one entity opens one pane, structurally (a single
 * mount door and a tripwire that fails on a second)" applied at the only place a pane is
 * mounted today. Importing
 * `panes/timeline/` here would also close a cycle the moment that body reaches back
 * into this family for the frame, which it will.
 *
 * Resolution happens during render, on `RouteSurface`'s reasoning: the pane seat
 * board is composed at module scope before any window renders, so a descriptor is
 * there to be looked up on the first pass.
 */
function mountLedgerPane(context: ConsoleSurfaceContext): ReactNode {
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
 * The `entity` member is OMITTED rather than passed as `undefined`: this timeline is
 * scoped to the session rather than to one of its entities, and an absent key is the
 * one way the address union says so. `focusHue` and `linkedSourcePaneId` are required
 * members carrying `undefined`, which is a different claim and a deliberate one — the
 * ring takes an actor's hue only where the pane's entity is a run or an agent, and this
 * pane was opened from a route rather than from another pane, so both are answered here
 * rather than left for a reader to guess whether anybody decided.
 */
function ledgerPaneContext(context: ConsoleSurfaceContext): ConsolePaneContext {
  return {
    kind: "timeline",
    paneId: LEDGER_PANE_ID,
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: context.sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    linkedSourcePaneId: undefined,
    focusHue: undefined,
  };
}
