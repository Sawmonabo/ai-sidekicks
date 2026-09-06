// The session workspace: the cast bar, the deck, and the composer's seat.
//
// This is what a person is looking at when they are looking at a session. It
// composes three things it does not own — `CastBar` (this family's), the deck's
// panes (six families', through one mount door), and the composer (the composer
// family's, through its seat) — and owns exactly one thing itself: the arrangement.
//
// THE DECISIONS THIS SURFACE MAKES:
//
//   • **The layout is restored once, at mount, and saved through the persistence
//     chokepoint.** `Spec-023 §Persistence on the renderer scheme`: "Layout, scroll
//     position, selection, pins, and expansion sets persist per install", and
//     "Projections never persist and are re-derived on reconnect". Nothing about a
//     session's own state is written — the snapshot holds pane ids, kinds, entity
//     refs, and widths, which is the `layout` value class and nothing beyond it.
//   • **Saves are coalesced by the write itself.** Dragging a separator produces a
//     transition per frame, and one durable write per frame would spend the store's
//     whole budget on a gesture. `layout-writer.ts` holds one write in
//     flight and one pending snapshot, so a drag costs what the database can absorb
//     and every record it writes is the newest arrangement rather than a stale one.
//   • **An empty deck opens the ledger.** This surface's own empty state, because no
//     committed document states one: the workspace shows the ledger alone at full
//     width, which is a `timeline` pane rather than a special case in the renderer.
//   • **Refusals are rendered where they happened.** What a restore dropped belongs
//     to the deck and renders inside it; what a detach or a save refused changes
//     what the whole surface can do and takes the workspace banner: the refusal
//     grammar of `Spec-023 §Meridian, the design language` renders a refusal of that
//     reach "as a **banner** across the workspace when it changes what the whole room
//     can do".
//   • **The sidebar is the outer split, and the deck's own group is untouched.**
//     `Spec-023 §Console Design (Meridian)` §Layout grammar: "The workspace is a cast
//     bar on top, the deck of panes below it, and a collapsible session sidebar". Two
//     nested panel groups rather than one: the deck owns the arrangement of its panes
//     and this surface owns the split between the deck and the sidebar, so a sidebar
//     resize is not a deck layout and never reaches the deck's own record.
//   • **A detached pane keeps its slot.** `Spec-023 §The surface set`: "the main
//     window shows the moved pane's slot as a placeholder with a focus control". That
//     suppresses the BODY, not the pane: closing the pane would delete its width and
//     its position, and the window closing or crashing would then have nowhere to put
//     it back. The hand-off's own lifecycle — its detached set, its crash records, and
//     the four acts a slot offers — is `workspace/auxiliary/auxiliary-panes.ts`'; this surface
//     passes what that publishes down to the deck and raises what it refuses.

import { useCallback, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { DECK_RESTORED_PANE_CAP, type ConsoleRefusal } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { consoleCommandSurface } from "../palette/index.js";
import { useAnnounce } from "../primitives/index.js";
import { routeSessionId, type ConsoleRoute } from "../routing/index.js";
import { type FrameStore, type SessionStore } from "../store/index.js";
import { type DraftStore, type UiStateStore } from "../persistence/index.js";

import {
  DECK_MINIMUM_WIDTH_PERCENT,
  SIDEBAR_COLLAPSED_WIDTH_PX,
  SIDEBAR_MINIMUM_WIDTH_PERCENT,
} from "./workspace-bounds.js";
import { CastBar } from "./cast-bar/CastBar.js";
import { WorkspaceBannerRow } from "./banners/WorkspaceBannerRow.js";
import { useAuxiliaryPanes } from "./auxiliary/auxiliary-panes.js";
import { Deck } from "./deck/Deck.js";
import { useDeckLayout, useDeckLayoutState } from "./deck/deck-layout.js";
import type { DeckPane } from "./deck/deck-model.js";
import { useSeparatorValueBoundsCorrection } from "./deck/separator-aria.js";
import { useDeckPersistence } from "./layout/layout-persistence.js";
import { SessionSidebar } from "./sidebar/SessionSidebar.js";
import { registerSidebarCommands } from "./sidebar/sidebar-commands.js";
import { useSidebarLayout } from "./sidebar/sidebar-state.js";
import {
  composerSeatRenderer,
  parseConsolePaneAddress,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type ConsolePaneOpener,
  type ConsolePaneRegistry,
} from "../seats/index.js";
import { useActorFollow } from "./cast-bar/actor-follow.js";
import {
  dismissWorkspaceBanner,
  raiseWorkspaceBanner,
  workspaceBannerKey,
  type WorkspaceBanner,
} from "./banners/workspace-banners.js";

/**
 * The sidebar's two palette rows, contributed the moment this module is evaluated.
 *
 * COMPOSITION TIME, and this is the module that reaches it. A family's commands are
 * contributed before any window renders, so they are in the palette and its chord
 * table from the first frame and the frame's single revision bump covers them; a
 * registration made later from an effect would land after that bump on every
 * navigation into a session. The ledger's barrel is where a family ordinarily makes
 * this call, and it cannot make this one: `ledger/` and `workspace/` are sibling VIEW
 * families and `console-view-family-isolation` fails an import between two of them, so
 * the surface that owns the acts contributes them itself. The composition root imports
 * this module, so "when this module is evaluated" is that same moment.
 */
registerSidebarCommands(consoleCommandSurface);

/** The panel ids the outer split reports its layout under. */
const DECK_PANEL_ID = "workspace-deck";
const SIDEBAR_PANEL_ID = "workspace-sidebar";

export interface WorkspaceProps {
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  /** `undefined` on a route that names no session, or before its store opens. */
  readonly sessionStore: SessionStore | undefined;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  readonly route: ConsoleRoute;
  /**
   * The pane board THIS composition filled, the same fact `ConsoleSurfaceContext`
   * carries and on the same terms: required rather than defaulted to the process-wide
   * singleton, because a default is the same hard-coding one parameter along and a
   * caller that forgets it still mounts production's bodies into a composed window.
   */
  readonly paneRegistry: ConsolePaneRegistry;
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const sessionId = routeSessionId(props.route);
  const registry = props.paneRegistry;
  const layout = useDeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  const deckState = useDeckLayoutState(layout);
  // Read HERE and not inside the follow callback: a hook may not be called from one,
  // and a workspace mounted outside `LiveAnnouncerProvider` should fail on this line
  // rather than the first time somebody presses a chip.
  const announce = useAnnounce();
  const sessionStore = props.sessionStore;
  const [banners, setBanners] = useState<readonly WorkspaceBanner[]>([]);

  const raise = useCallback((refusal: ConsoleRefusal) => {
    setBanners((current) => raiseWorkspaceBanner(current, refusal));
  }, []);

  const dismiss = useCallback((key: string) => {
    setBanners((current) => dismissWorkspaceBanner(current, key));
  }, []);

  const restoreRefusals = useDeckPersistence({
    layout,
    uiStateStore: props.uiStateStore,
    sessionId,
    onSaveRefused: raise,
  });

  const paneContextFor = useCallback(
    (pane: DeckPane): ConsolePaneContext | ConsoleRefusal => {
      // The kind and the entity arrived as a loose pair — off a restored snapshot, or
      // off a route somebody typed — so they become an ADDRESS here or they become a
      // refusal here. The seat owns that rule and this surface applies it; deciding it
      // again would be a second answer to which entities a pane kind is a view of.
      const address = parseConsolePaneAddress(pane.kind, pane.entity);
      if ("code" in address) {
        return address;
      }
      return {
        ...address,
        paneId: pane.paneId,
        bridge: props.bridge,
        frameStore: props.frameStore,
        sessionStore: props.sessionStore,
        uiStateStore: props.uiStateStore,
        draftStore: props.draftStore,
        // The pane this one was opened beside, passed as an identifier and never as a
        // handle, so a linked pane stays independently movable and closable.
        linkedSourcePaneId: pane.sourcePaneId,
        // Fail-closed, per the seat's own rule: the ring takes an actor's hue only
        // where the pane's entity is a run or an agent, and an unattributed pane takes
        // the neutral boundary rather than somebody else's colour. Resolving that hue
        // belongs to the lane that renders run and agent panes; nothing here guesses.
        focusHue: undefined,
      };
    },
    [props.bridge, props.frameStore, props.sessionStore, props.uiStateStore, props.draftStore],
  );

  const auxiliaryPanes = useAuxiliaryPanes({ bridge: props.bridge, sessionId, onRefused: raise });
  const onFollow = useActorFollow({ layout, sessionStore, announce });

  const composer = composerSeatRenderer();
  const focusedPane = useFocusedPaneAddress(deckState.panes, deckState.focusedPaneId);

  // How a sidebar section opens a pane: through THIS deck, handed down rather than
  // reached for, so a sidebar rendered in an auxiliary window opens panes in that
  // window's deck. The address arrives kind-scoped, so the entity is read where the
  // arm carries one and is absent where the kind has none.
  const openPane = useCallback<ConsolePaneOpener>(
    (address, link) => {
      layout.open({
        kind: address.kind,
        entity: "entity" in address ? address.entity : undefined,
        ...(link === undefined ? {} : { sourcePaneId: link.linkedSourcePaneId }),
      });
    },
    [layout],
  );

  const sidebar = useSidebarLayout({
    uiStateStore: props.uiStateStore,
    sessionId,
    onSaveRefused: raise,
  });
  const splitReference = useRef<HTMLDivElement>(null);
  // The deck's own correction, reused over the outer group rather than written again.
  // `separator-aria.ts` swaps only a CROSSED pair, so running it across a subtree the
  // deck has already corrected leaves the deck's separators exactly as they are. The
  // outer group holds exactly ONE separator, which is the first — the position the
  // library gets right — so this is the same guard applied to a second group and not a
  // second claim about it.
  useSeparatorValueBoundsCorrection(splitReference, deckState.revision);

  return (
    <div className="meridian-workspace">
      {banners.map((banner) => (
        <WorkspaceBannerRow
          key={workspaceBannerKey(banner.refusal)}
          banner={banner}
          onDismiss={dismiss}
        />
      ))}
      <CastBar sessionId={sessionId} sessionStore={props.sessionStore} onFollow={onFollow} />
      <Group
        className="meridian-workspace__split"
        elementRef={splitReference}
        orientation="horizontal"
        onLayoutChanged={(percentages) => {
          const sidebarPercent = percentages[SIDEBAR_PANEL_ID];
          if (sidebarPercent !== undefined) {
            sidebar.layout.recordWidthPercent(sidebarPercent);
          }
        }}
      >
        <Panel id={DECK_PANEL_ID} minSize={`${String(DECK_MINIMUM_WIDTH_PERCENT)}%`}>
          <Deck
            layout={layout}
            registry={registry}
            paneContextFor={paneContextFor}
            onOpenInWindow={auxiliaryPanes.openInWindow}
            restoreRefusals={restoreRefusals}
            detachedPaneIds={auxiliaryPanes.paneIds}
            onFocusDetachedWindow={auxiliaryPanes.focusWindow}
            onReturnToDeck={auxiliaryPanes.returnToDeck}
            lostWindowNoticesByPaneId={auxiliaryPanes.lostWindowNoticesByPaneId}
            onDismissLostWindow={auxiliaryPanes.dismissLostWindow}
            {...(auxiliaryPanes.signalRefusal === undefined
              ? {}
              : { detachedSignalRefusal: auxiliaryPanes.signalRefusal })}
          />
        </Panel>
        {props.sessionStore === undefined ? null : (
          <>
            <Separator
              className="meridian-workspace__separator"
              aria-label="Resize the session sidebar"
            />
            {/* One panel in both states rather than two arrangements: a collapsed
                sidebar is this panel pinned to the rail's width, so collapsing never
                adds or removes a panel and the deck beside it is never remounted. */}
            <Panel
              id={SIDEBAR_PANEL_ID}
              className="meridian-workspace__sidebar"
              defaultSize={`${String(sidebar.snapshot.state.widthPercent)}%`}
              minSize={
                sidebar.snapshot.state.isCollapsed
                  ? SIDEBAR_COLLAPSED_WIDTH_PX
                  : `${String(SIDEBAR_MINIMUM_WIDTH_PERCENT)}%`
              }
              {...(sidebar.snapshot.state.isCollapsed
                ? { maxSize: SIDEBAR_COLLAPSED_WIDTH_PX }
                : {})}
            >
              <SessionSidebar
                sessionStore={props.sessionStore}
                bridge={props.bridge}
                openPane={openPane}
                layout={sidebar.layout}
                snapshot={sidebar.snapshot}
              />
            </Panel>
          </>
        )}
      </Group>
      {composer === undefined || props.sessionStore === undefined ? null : (
        <div className="meridian-workspace__composer">
          {composer({
            sessionStore: props.sessionStore,
            bridge: props.bridge,
            draftStore: props.draftStore,
            route: props.route,
            focusedPane,
          })}
        </div>
      )}
    </div>
  );
}

/** The focused pane's address, for the composer's send router. */
function useFocusedPaneAddress(
  panes: readonly DeckPane[],
  focusedPaneId: string | undefined,
): ConsolePaneAddress | undefined {
  return useMemo(() => {
    const pane = panes.find((candidate) => candidate.paneId === focusedPaneId);
    if (pane === undefined) {
      return undefined;
    }
    // Parsed rather than composed, for `paneContextFor`'s reason: the pair is not an
    // address until the seat says it is. A pane whose address the seat refuses routes
    // nothing — which is the same answer as no focused pane, and is the honest one:
    // the composer has no place to send to.
    const address = parseConsolePaneAddress(pane.kind, pane.entity);
    return "code" in address ? undefined : address;
  }, [panes, focusedPaneId]);
}
