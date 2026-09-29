// The transcript's two screens: the session's workspace and the full-screen transcript
// window.
//
// THE TWO SLOTS, AND WHY THEY DO NOT MOUNT THE SAME THING. `workspace` is the session's
// own surface: the session header, the deck, and the composer's seat, which the
// composition root hands in. `timeline` is the full-screen transcript WINDOW — a
// transcript pane moved into its own hardened `BrowserWindow`, loading the same renderer
// bundle at a window route — so it mounts the pane alone: no deck around it, because an
// auxiliary window holds one pane, and no composer, because the composer is the session
// workspace's chrome and this window is not that workspace. The find bar is the pane's
// own chrome and travels with it into that window.

import { createElement, type ComponentType, type ReactNode } from "react";

import { Nothing, SurfaceAbsence } from "@renderer/console/primitives/index.js";
import { routeSessionId } from "@renderer/routing/route-readers.js";
import {
  type ConsolePaneContext,
  type ConsoleSurfaceContext,
  type ConsoleSurfaceRegistration,
  type ConsoleSurfaceRegistry,
} from "@renderer/console/seats/index.js";
import { SessionResumeDegraded } from "../components/ResumeRefusalBanner.js";

/**
 * What the composition root supplies this feature, because this file may not import it.
 *
 * The session workspace's body belongs to another feature, and no feature imports
 * another, so the component arrives as a parameter named by the composition root, which
 * sits above every feature and is the one place allowed to name more than one.
 *
 * The COMPONENT rather than a built element: which component mounts is the root's
 * decision, and what it is handed is this file's — the surface context exists only when
 * the slot renders, which is long after the root registered it.
 */
export interface LedgerComposition {
  readonly workspace: ComponentType<WorkspaceMountProps>;
}

/**
 * Claim the two surfaces the transcript mounts.
 *
 * Takes the registry rather than reaching for the module-scope singleton: a test
 * composes into a registry it owns and an auxiliary window composes a subset without a
 * second code path. The transcript's commands are registered by their own contribution,
 * `registerLedgerCommands`, which the composition root calls beside this.
 */
export function registerLedger(
  registry: ConsoleSurfaceRegistry,
  composition: LedgerComposition,
): void {
  for (const descriptor of ledgerSurfaces(composition)) {
    registry.register(descriptor);
  }
}

/**
 * The owner string every transcript claim carries, surfaces and pane alike.
 *
 * One binding rather than a literal per descriptor: the surface registry's
 * duplicate policy is owner-scoped, so re-registering under the same owner replaces
 * and a different owner is refused by name. Two spellings of this feature's own name
 * would make a hot reload a collision.
 */
export const LEDGER_SURFACE_OWNER = "ledger";

/**
 * The deck's single pane, while the deck holds exactly one.
 *
 * `ConsolePaneContext.paneId` is a pane's identity across a layout restore, so it is
 * a value rather than an index: the lane that ships the deck mints one per pane and
 * this constant retires with the single-pane arm.
 */
const LEDGER_PANE_ID = "ledger-timeline";

/**
 * What the workspace slot hands its body.
 *
 * Derived from the surface context rather than restated, so a member added there is
 * carried here without a second declaration to keep in step. `sessionStoreRegistry` is
 * subtracted because the workspace renders ONE session — a surface that has to offer
 * sessions reads the registry, and this one is handed the session it is a view of.
 */
type WorkspaceMountProps = Omit<ConsoleSurfaceContext, "sessionStoreRegistry">;

/** The two slots this feature claims, given the body the root composed in. */
function ledgerSurfaces(composition: LedgerComposition): readonly ConsoleSurfaceRegistration[] {
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
 * Mount the session workspace: the session header, the deck, and the composer's seat.
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
  const sessionId = routeSessionId(context.route);
  return createElement(
    "div",
    { className: "meridian-ledger-surface" },
    // ABOVE the workspace body and never in place of it. The refused arm says the
    // position this session was last read up to could not be resolved and the log was
    // re-read from the beginning of its window, which the surface below is unaffected
    // by: the store projects, the subscription tails, and what was lost is a remembered
    // place. The component is conditional rather than its hooks, which is the only
    // shape React allows for a reading whose session id may not exist.
    sessionId === undefined
      ? null
      : createElement(SessionResumeDegraded, {
          registry: context.sessionStoreRegistry,
          sessionId,
        }),
    createElement(Workspace, {
      key: sessionId ?? "no-session",
      bridge: context.bridge,
      frameStore: context.frameStore,
      sessionStore: context.sessionStore,
      uiStateStore: context.uiStateStore,
      draftStore: context.draftStore,
      route: context.route,
      paneRegistry: context.paneRegistry,
    }),
  );
}

/**
 * Mount the ledger's pane alone, through the deck's own door.
 *
 * The pane body is resolved from the pane registry rather than built here, which is one
 * entity opening one pane structurally — a single mount door and a tripwire that fails
 * on a second — applied at the only place a pane is mounted today. It is also what keeps
 * the body single-sourced: the descriptor `registerLedgerPanes` files is the one
 * composition of this pane, so this slot mounts it rather than building a second one.
 *
 * Resolution happens during render, on `RouteSurface`'s reasoning: the pane seat
 * board is composed at module scope before any window renders, so a descriptor is
 * there to be looked up on the first pass. The board read is the one on the context —
 * the board THIS composition filled — rather than the process-wide singleton, so a
 * window composed with its own board mounts its own body and not production's.
 */
function mountLedgerPane(context: ConsoleSurfaceContext): ReactNode {
  const descriptor = context.paneRegistry.descriptorFor("timeline");
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
    // Keyed on the route's session, exactly as the workspace slot beside it is and
    // for the same reason: this position holds strictly more per-session state —
    // chapter disclosure, row retention, the reveal engine's lanes,
    // the viewport's reading anchor and row leases, the find query, the pending jump
    // — and moving between two already-open sessions re-renders it rather than
    // unmounting it. The key is what makes the subtree's lifetime match the thing it
    // holds state about.
    { className: "meridian-ledger-surface", key: routeSessionId(context.route) ?? "no-session" },
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
