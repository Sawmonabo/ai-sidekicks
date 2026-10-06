import type { ReactNode } from "react";

import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { MainProcessState } from "#shared/daemon/status-topic.js";
import type { SchemePreference } from "#renderer/styles/tokens.js";

/**
 * Everything a settings page is handed.
 *
 * Deliberately narrower than `ScreenContext`: a page reads its own wire and
 * navigates the rail, and handing it the session stores would invite a page to hold
 * session state the settings screen has no session for.
 */
export interface SettingsPageContext {
  readonly bridge: PlatformBridge;
  /** Renderer-local rail navigation — the deep-link grammar's other half. */
  readonly openPage: (section: SettingsPageId) => void;
  /**
   * What the address asked this page to be opened for, where it asked for anything.
   *
   * The second segment of `#/settings/<page>/<selection>`, carried through untouched; it is
   * how a view elsewhere hands a page its subject (`#/settings/providers/codex`). A bare
   * string, never a narrowed one: `routing/` owns only the grammar, and the page narrows it
   * against its own vocabulary, fail-closed, so an unrecognized selection is a page opened
   * for nothing rather than one that refuses to open. It authorizes and selects nothing on
   * its own.
   */
  readonly selection: string | undefined;
  /**
   * The session this window most recently opened, or `undefined` where it has opened none.
   *
   * The frame store's retained id, not its route projection: every settings address is
   * `kind: "settings"` and names no session, so the projection is `undefined` on all of them
   * and a session-scoped page handed it would render its no-session arm forever. `undefined`
   * is still a real answer: a page that asked and was told nothing renders an honest empty state.
   */
  readonly retainedSessionId: string | undefined;
  /**
   * That session's store, where this window has it open.
   *
   * A session-scoped read needs a push signal or it goes stale silently, and the session's
   * event stream is the one the console already subscribes to, once, in the frame's subscriber.
   * Handing the store lets a page bind to that stream instead of opening a second
   * `daemon.subscribe`. It is the retained session's store only: `undefined` means this
   * window has that session closed, and a page reads that as one refresh signal fewer, not a
   * failure.
   */
  readonly retainedSessionStore: SessionStore | undefined;
  /**
   * What this window has been told about the main process it is running against.
   *
   * Read from the window's own store, never re-read here: the frame opens one subscription
   * for it, and the frame's chip, the palette's read-only line and the Runtime page all
   * render the same value.
   */
  readonly mainProcessState: MainProcessState;
  /** This window's act for choosing a color scheme, which asks main to keep it. */
  readonly chooseScheme: (preference: SchemePreference) => void;
}

/** What a page renders: a function, as a screen's and a pane's render are. */
export type SettingsPageBody = (context: SettingsPageContext) => ReactNode;
