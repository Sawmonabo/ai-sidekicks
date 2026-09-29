// The session screen: the session header, the pane layout, and the composer's region.
//
// This is what a person is looking at when they are looking at a session. It
// composes three things it does not own — `SessionHeader` (this feature's), the pane layout's
// panes (six features', through the pane registry), and the composer (the composer
// feature's, through its registered renderer) — and owns exactly one thing itself: the
// arrangement.
//
// THE DECISIONS THIS SCREEN MAKES:
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
//   • **An empty pane layout opens the transcript.** This screen's own empty state, because no
//     committed document states one: the session screen shows the transcript alone at full
//     width, which is a `transcript` pane rather than a special case in the renderer.
//   • **Refusals are rendered where they happened.** What a restore dropped belongs
//     to the pane layout and renders inside it; what a save refused changes what the whole
//     screen can do and takes the session screen banner.
//   • **A banner belongs to the session it was raised in.** This screen is NOT
//     remounted between two open sessions, so a column held for the life of the mount
//     would go on saying what a save refused in the session somebody left, over the pane layout
//     of the one they are looking at. The column rides `store/subject-scoped/session-subject.ts` on
//     `(bridge, session)`, so the render that first sees the arriving session already
//     reads an empty one, and a bridge replacement — which retires every call the
//     refusals describe — clears it too.

import "./SessionScreen.css";

import { useCallback } from "react";

import { type Refusal } from "@renderer/lib/refusal.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { routeSessionId } from "@renderer/routing/route-readers.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { type WindowStore } from "@renderer/store/window/window-store.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type DraftStore } from "@renderer/store/draft-store.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";

import { SessionHeader } from "./session-header/components/SessionHeader.js";
import { SessionBannerRow } from "./components/SessionBannerRow.js";
import { SessionPaneLayout } from "./pane-layout/components/SessionPaneLayout.js";
import { PANE_LAYOUT_RESTORED_PANE_CAP } from "./pane-layout/pane-layout-store.js";
import { usePaneLayoutStore } from "./pane-layout/hooks/usePaneLayoutStore.js";
import { usePaneLayoutState } from "./pane-layout/hooks/usePaneLayoutState.js";
import type { SessionPane } from "./pane-layout/pane-layout.js";
import { usePaneLayoutPersistence } from "./pane-layout/hooks/usePaneLayoutPersistence.js";
import { useFocusedPaneAddress } from "./hooks/useFocusedPaneAddress.js";
import { findComposerRenderer } from "@renderer/registries/composer/composer-registry.js";
import { parsePaneAddress } from "@renderer/routing/panes/parse-pane-address.js";
import { useSessionScopedState } from "@renderer/store/subject-scoped/useSessionScopedState.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import {
  NO_SESSION_BANNERS,
  dismissSessionBanner,
  raiseSessionBanner,
  sessionBannerKey,
  type SessionBanner,
} from "./session-banners.js";

/** What the session screen is handed: the stores it reads and the pane board it mounts. */
export interface SessionScreenProps {
  readonly bridge: PlatformBridge;
  readonly frameStore: WindowStore;
  /** `undefined` on a route that names no session, or before its store opens. */
  readonly sessionStore: SessionStore | undefined;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  readonly route: AppRoute;
  /**
   * The pane board THIS composition filled, the same fact `ScreenContext`
   * carries and on the same terms: required rather than defaulted to the process-wide
   * singleton, because a default is the same hard-coding one parameter along and a
   * caller that forgets it still mounts production's bodies into a composed window.
   */
  readonly paneRegistry: PaneRegistry;
}

/** The session screen: header, pane layout, composer region, and the banner column. */
export function SessionScreen(props: SessionScreenProps): React.JSX.Element {
  const sessionId = routeSessionId(props.route);
  const registry = props.paneRegistry;
  const layout = usePaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  const paneLayoutState = usePaneLayoutState(layout);
  // WHAT THIS ROOM CANNOT DO, ADDRESSED BY THE SESSION IT CANNOT DO IT IN. The bridge
  // is the subject and the session the key, which is this console's one session pairing:
  // every refusal that lands here was raised by a call or a write made through that
  // transport, so a replacement retiring those calls retires their sentences with them.
  const { value: banners, settle: settleBanners } = useSessionScopedState<readonly SessionBanner[]>(
    props.bridge,
    sessionId,
    () => NO_SESSION_BANNERS,
  );

  // CAPTURED WHEN THE REFUSAL LANDS, not when the raiser was handed over, and that is
  // forced rather than chosen: the save writer is held per STORE and built once, so
  // it closes over the raiser from the render that seeded it. A publisher captured at
  // that render names the session that was on screen then and would go on refusing
  // every later session's refusals in silence — `settle` names the visit committed at
  // the moment of the call instead, so the column stays writable for the life of the
  // mount and the refusal lands on the session a person is actually reading.
  const raise = useCallback(
    (refusal: Refusal) => {
      const publishIntoTheVisitOnScreen = settleBanners();
      publishIntoTheVisitOnScreen((current) => raiseSessionBanner(current, refusal));
    },
    [settleBanners],
  );

  const dismiss = useCallback(
    (key: string) => {
      const publishIntoTheVisitOnScreen = settleBanners();
      publishIntoTheVisitOnScreen((current) => dismissSessionBanner(current, key));
    },
    [settleBanners],
  );

  const restoreRefusals = usePaneLayoutPersistence({
    layout,
    uiStateStore: props.uiStateStore,
    sessionId,
    onSaveRefused: raise,
  });

  const paneContextFor = useCallback(
    (pane: SessionPane): PaneContext | Refusal => {
      // The kind and the entity arrived as a loose pair — off a restored snapshot, or
      // off a route somebody typed — so they become an ADDRESS here or they become a
      // refusal here. `parsePaneAddress` owns that rule and this screen applies it; deciding it
      // again would be a second answer to which entities a pane kind is a view of.
      const address = parsePaneAddress(pane.kind, pane.entity);
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
        // Fail-closed, per `PaneContext`'s own rule: the ring takes an actor's hue only
        // where the pane's entity is a run or an agent, and an unattributed pane takes
        // the neutral boundary rather than somebody else's color. Resolving that hue
        // belongs to the lane that renders run and agent panes; nothing here guesses.
        focusHue: undefined,
      };
    },
    [props.bridge, props.frameStore, props.sessionStore, props.uiStateStore, props.draftStore],
  );

  const composer = findComposerRenderer();
  const focusedPane = useFocusedPaneAddress(paneLayoutState.panes, paneLayoutState.focusedPaneId);

  return (
    <div className="meridian-session-screen">
      {banners.map((banner) => (
        <SessionBannerRow
          key={sessionBannerKey(banner.refusal)}
          banner={banner}
          onDismiss={dismiss}
        />
      ))}
      <SessionHeader sessionId={sessionId} sessionStore={props.sessionStore} />
      <SessionPaneLayout
        layout={layout}
        registry={registry}
        paneContextFor={paneContextFor}
        restoreRefusals={restoreRefusals}
      />
      {composer === undefined || props.sessionStore === undefined ? null : (
        <div className="meridian-session-screen__composer">
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
