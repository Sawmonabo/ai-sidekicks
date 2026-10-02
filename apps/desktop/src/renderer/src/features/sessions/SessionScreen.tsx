// The session screen: the header with its banners and catching-up line, the pane layout,
// and the composer's region. It owns only the arrangement; panes and the composer come
// through their registries.
//
// The layout is restored once at mount and saved through the persistence hook. An empty
// layout opens the transcript alone at full width. A save that failed raises one banner
// under the header; its code goes to the window's diagnostic capture, as does every part of
// a saved arrangement the restore left closed. The screen is not
// remounted between two open sessions, so banners are scoped to (bridge, session): the
// arriving session reads an empty column, and a bridge replacement clears it too.

import "./SessionScreen.css";

import { useCallback } from "react";

import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { type Clock } from "@renderer/lib/clock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { routeSessionId } from "@renderer/routing/route-readers.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { type WindowStore } from "@renderer/store/window/window-store.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type DraftStore } from "@renderer/store/draft-store.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";

import { SessionHeader } from "./session-header/components/SessionHeader.js";
import { SessionBannerRow } from "./components/SessionBannerRow.js";
import { SessionCatchUpLine } from "./components/SessionCatchUpLine.js";
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
  PANE_LAYOUT_NOT_SAVED_BANNER,
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
   * The pane registry this composition filled, required rather than defaulted to the
   * process-wide one. The composer still comes from the process-wide composer registry.
   */
  readonly paneRegistry: PaneRegistry;
  /**
   * Reads one session again, for a person's press. A refusal comes back when that
   * session is not open, and this screen sends it to the window's diagnostic capture.
   */
  readonly rereadSession: (sessionId: string) => Refusal | undefined;
}

/** The session screen: header, banners, catching-up line, pane layout and composer region. */
export function SessionScreen(props: SessionScreenProps): React.JSX.Element {
  const sessionId = routeSessionId(props.route);
  const registry = props.paneRegistry;
  const layout = usePaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  const paneLayoutState = usePaneLayoutState(layout);
  const clock = useClock();
  // The bridge is the subject and the session the key: every refusal here came through that
  // transport, so replacing it retires their banners with them.
  const { value: banners, settle: settleBanners } = useSessionScopedState<readonly SessionBanner[]>(
    props.bridge,
    sessionId,
    () => NO_SESSION_BANNERS,
  );

  // The save writer is built once per store and closes over the handler from its first
  // render, so the publisher is taken with `settle` when the failure lands. Taking it at
  // render would drop every later session's banner.
  const saveRefused = useCallback(
    (refusal: Refusal, savedSessionId: string) => {
      recordRefusal(clock, "pane-layout-not-saved", savedSessionId, refusal);
      const publishIntoTheVisitOnScreen = settleBanners();
      publishIntoTheVisitOnScreen((current) =>
        raiseSessionBanner(current, PANE_LAYOUT_NOT_SAVED_BANNER),
      );
    },
    [clock, settleBanners],
  );

  const dismiss = useCallback(
    (key: string) => {
      const publishIntoTheVisitOnScreen = settleBanners();
      publishIntoTheVisitOnScreen((current) => dismissSessionBanner(current, key));
    },
    [settleBanners],
  );

  const restoreRefused = useCallback(
    (refusal: Refusal, restoredSessionId: string) => {
      recordRefusal(clock, "pane-layout-not-restored", restoredSessionId, refusal);
    },
    [clock],
  );

  usePaneLayoutPersistence({
    layout,
    uiStateStore: props.uiStateStore,
    sessionId,
    onSaveRefused: saveRefused,
    onRestoreRefused: restoreRefused,
  });

  const paneContextFor = useCallback(
    (pane: SessionPane): PaneContext | Refusal => {
      // The kind and entity arrive as a loose pair (a restored snapshot or a typed route),
      // so `parsePaneAddress` turns them into an address or a refusal here.
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
        // An identifier, never a handle, so a linked pane stays independently movable.
        linkedSourcePaneId: pane.sourcePaneId,
      };
    },
    [props.bridge, props.frameStore, props.sessionStore, props.uiStateStore, props.draftStore],
  );

  const rereadSession = props.rereadSession;
  const tryAgain = useCallback(
    (sessionIdToReread: string) => {
      const refusal = rereadSession(sessionIdToReread);
      if (refusal !== undefined) {
        recordRefusal(clock, "session-reread-refused", sessionIdToReread, refusal);
      }
    },
    [rereadSession, clock],
  );

  const composer = findComposerRenderer();
  const focusedPane = useFocusedPaneAddress(paneLayoutState.panes, paneLayoutState.focusedPaneId);

  return (
    <div className="meridian-session-screen">
      <div className="meridian-session-screen__head">
        <SessionHeader sessionId={sessionId} sessionStore={props.sessionStore} />
        {banners.map((banner) => (
          <SessionBannerRow key={sessionBannerKey(banner)} banner={banner} onDismiss={dismiss} />
        ))}
        {props.sessionStore === undefined ? null : (
          <SessionCatchUpLine sessionStore={props.sessionStore} onTryAgain={tryAgain} />
        )}
      </div>
      <SessionPaneLayout layout={layout} registry={registry} paneContextFor={paneContextFor} />
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

/**
 * One warning in the window's diagnostic capture for a refusal this screen does not
 * draw, naming the session and the refusal's code.
 */
function recordRefusal(
  clock: Clock,
  kind: string,
  refusedSessionId: string,
  refusal: Refusal,
): void {
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(clock),
    severity: "warning",
    source: "features/sessions",
    kind,
    detail: `session ${refusedSessionId}: ${refusal.code}`,
  });
}
