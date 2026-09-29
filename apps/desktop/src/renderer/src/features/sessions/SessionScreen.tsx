// The session workspace: the session header, the deck, and the composer's seat.
//
// This is what a person is looking at when they are looking at a session. It
// composes three things it does not own — `SessionHeader` (this family's), the deck's
// panes (six families', through one mount door), and the composer (the composer
// family's, through its seat) — and owns exactly one thing itself: the arrangement.
//
// THE DECISIONS THIS SURFACE MAKES:
//
//   • **The layout is restored once, at mount, and saved through the persistence
//     chokepoint.** Layout, scroll position, selection, pins, and expansion sets
//     persist per install; projections never persist and are re-derived on
//     reconnect. Nothing about a
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
//     to the deck and renders inside it; what a save refused changes what the whole
//     surface can do and takes the workspace banner.
//   • **A banner belongs to the session it was raised in.** This surface is NOT
//     remounted between two open sessions, so a column held for the life of the mount
//     went on saying what a save refused in the session somebody left, over the deck
//     of the one they are looking at. The column rides `seats/session-subject.ts` on
//     `(bridge, session)`, so the render that first sees the arriving session already
//     reads an empty one, and a bridge replacement — which retires every call the
//     refusals describe — clears it too.

import "./SessionScreen.css";

import { useCallback } from "react";

import { type ConsoleRefusal } from "@renderer/lib/refusal.js";
import { type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { routeSessionId } from "@renderer/routing/route-readers.js";
import { type ConsoleRoute } from "@renderer/routing/routes.js";
import { type FrameStore } from "@renderer/store/window/window-store.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type DraftStore } from "@renderer/store/draft-store.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";

import { SessionHeader } from "./session-header/components/SessionHeader.js";
import { WorkspaceBannerRow } from "./components/SessionBannerRow.js";
import { Deck } from "./pane-layout/components/SessionPaneLayout.js";
import { DECK_RESTORED_PANE_CAP } from "./pane-layout/pane-layout-store.js";
import { useDeckLayout } from "./pane-layout/hooks/usePaneLayoutStore.js";
import { useDeckLayoutState } from "./pane-layout/hooks/usePaneLayoutState.js";
import type { DeckPane } from "./pane-layout/pane-layout.js";
import { useDeckPersistence } from "./pane-layout/hooks/usePaneLayoutPersistence.js";
import { useFocusedPaneAddress } from "./hooks/useFocusedPaneAddress.js";
import {
  composerSeatRenderer,
  parseConsolePaneAddress,
  useSessionScopedState,
  type ConsolePaneContext,
  type ConsolePaneRegistry,
} from "@renderer/console/seats/index.js";
import {
  NO_WORKSPACE_BANNERS,
  dismissWorkspaceBanner,
  raiseWorkspaceBanner,
  workspaceBannerKey,
  type WorkspaceBanner,
} from "./session-banners.js";

/** What the workspace is handed: the stores it reads and the pane board it mounts. */
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

/** The session workspace: header, deck of panes, composer seat, and the banner column. */
export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const sessionId = routeSessionId(props.route);
  const registry = props.paneRegistry;
  const layout = useDeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  const deckState = useDeckLayoutState(layout);
  // WHAT THIS ROOM CANNOT DO, ADDRESSED BY THE SESSION IT CANNOT DO IT IN. The bridge
  // is the subject and the session the key, which is this console's one session pairing:
  // every refusal that lands here was raised by a call or a write made through that
  // transport, so a replacement retiring those calls retires their sentences with them.
  const { value: banners, settle: settleBanners } = useSessionScopedState<
    readonly WorkspaceBanner[]
  >(props.bridge, sessionId, () => NO_WORKSPACE_BANNERS);

  // CAPTURED WHEN THE REFUSAL LANDS, not when the raiser was handed over, and that is
  // forced rather than chosen: the save writer is held per STORE and built once, so
  // it closes over the raiser from the render that seeded it. A publisher captured at
  // that render names the session that was on screen then and would go on refusing
  // every later session's refusals in silence — `settle` names the visit committed at
  // the moment of the call instead, so the column stays writable for the life of the
  // mount and the refusal lands on the session a person is actually reading.
  const raise = useCallback(
    (refusal: ConsoleRefusal) => {
      const publishIntoTheVisitOnScreen = settleBanners();
      publishIntoTheVisitOnScreen((current) => raiseWorkspaceBanner(current, refusal));
    },
    [settleBanners],
  );

  const dismiss = useCallback(
    (key: string) => {
      const publishIntoTheVisitOnScreen = settleBanners();
      publishIntoTheVisitOnScreen((current) => dismissWorkspaceBanner(current, key));
    },
    [settleBanners],
  );

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
        // the neutral boundary rather than somebody else's color. Resolving that hue
        // belongs to the lane that renders run and agent panes; nothing here guesses.
        focusHue: undefined,
      };
    },
    [props.bridge, props.frameStore, props.sessionStore, props.uiStateStore, props.draftStore],
  );

  const composer = composerSeatRenderer();
  const focusedPane = useFocusedPaneAddress(deckState.panes, deckState.focusedPaneId);

  return (
    <div className="meridian-workspace">
      {banners.map((banner) => (
        <WorkspaceBannerRow
          key={workspaceBannerKey(banner.refusal)}
          banner={banner}
          onDismiss={dismiss}
        />
      ))}
      <SessionHeader sessionId={sessionId} sessionStore={props.sessionStore} />
      <Deck
        layout={layout}
        registry={registry}
        paneContextFor={paneContextFor}
        restoreRefusals={restoreRefusals}
      />
      {composer === undefined || props.sessionStore === undefined ? null : (
        <div className="meridian-workspace__composer">
          {composer({
            sessionStore: props.sessionStore,
            bridge: props.bridge,
            frameStore: props.frameStore,
            draftStore: props.draftStore,
            route: props.route,
            focusedPane,
          })}
        </div>
      )}
    </div>
  );
}
