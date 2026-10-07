// What a screen is handed.
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type DraftStore } from "#renderer/store/drafts.js";
import { type UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { type LastSettingsPage } from "#renderer/store/last-settings-page.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { SchemePreference } from "#renderer/styles/tokens.js";
import type { PaneRegistry } from "../panes/registry.js";

/** Everything a screen is handed; all of it is per window. */
export interface ScreenContext {
  readonly route: AppRoute;
  readonly bridge: PlatformBridge;
  readonly frameStore: WindowStore;
  /** The session store for the route's session, or `undefined` on a bare route. */
  readonly sessionStore: SessionStore | undefined;
  /**
   * Every session this window has open, the only session set the renderer can name (no bridge
   * member lists a node's sessions). A screen that offers sessions reads it.
   */
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /**
   * The pane registry this composition registered its bodies into. A screen that opens a pane must
   * resolve it from here, not the process-wide singleton, so a test or another window composing its
   * own registry never gets a production body. Required, since a default would still read
   * production.
   */
  readonly paneRegistry: PaneRegistry;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  /** The settings page last open on this device, which Settings records as its page changes. */
  readonly lastSettingsPage: LastSettingsPage;
  /**
   * This window's one act for choosing a color scheme: it asks main, which keeps the appearance,
   * and says so on the window's banner when main refuses.
   */
  readonly chooseScheme: (preference: SchemePreference) => void;
}
