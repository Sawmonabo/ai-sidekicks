import type { ReactNode } from "react";

import { type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import type { SettingsSectionId } from "@renderer/console/settings/settings-sections.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import type { ShellState } from "@renderer/store/window/main-process-state.js";

/**
 * Everything a settings page is handed.
 *
 * Deliberately narrower than `ConsoleSurfaceContext`: a page reads its own wire and
 * navigates the rail, and handing it the session stores would invite a page to hold
 * session state the settings surface has no session for.
 */
export interface SettingsPageContext {
  readonly bridge: ConsoleBridge;
  /** Renderer-local rail navigation — the deep-link grammar's other half. */
  readonly openSection: (section: SettingsSectionId) => void;
  /**
   * What the address asked this page to be opened FOR, where it asked for anything.
   *
   * `#/settings/<page>/<selection>`'s second segment, carried through untouched. It is
   * how a surface elsewhere in the console hands a page its subject — the onboarding
   * walkthrough's provider row deep-links here naming the provider whose remedy the
   * person pressed — so a page opened from a row and the same page opened from the
   * rail are the same page with and without a subject, rather than two entry points.
   *
   * A BARE STRING AND NEVER A NARROWED ONE. `routing/` sits below this family and owns
   * only the grammar; what the segment MEANS is the page's, and the page that reads it
   * narrows it against its own vocabulary fail-closed. A selection this build does not
   * recognize is therefore a page opened for nothing, which is what the rail hands it
   * anyway — never a page that refuses to open.
   *
   * It authorizes nothing and selects nothing on its own: a page reads it to say what
   * it was opened for, and every read it performs is the read it would have performed
   * from the rail.
   */
  readonly selection: string | undefined;
  /**
   * The session this window most recently opened, or `undefined` where it has
   * opened none.
   *
   * The frame store's RETAINED id and deliberately not its route projection. Every
   * settings address is `kind: "settings"` and names no session, so the projection
   * is `undefined` on every one of them — a session-scoped page handed it would
   * render its no-session arm forever, which is a constant wearing an absence's
   * clothes rather than a reading. The retained id is the fact that answers the
   * question these pages are actually asking: which session this window is working
   * in, whether or not the address it is parked on says so.
   *
   * `undefined` stays a real answer: a window that has opened no session hands the
   * pages nothing, and a page that ASKED and was told nothing renders an honest
   * absence. It is deliberately NOT the session STORE: a settings page that could
   * reach the projection could hold session state, and the settings surface has no
   * session to hold it for.
   */
  readonly retainedSessionId: string | undefined;
  /**
   * That session's store, where this window has it open.
   *
   * A page that reads a session-scoped wire needs a push signal or it goes stale
   * with nothing on screen saying so, and the session's own event stream is the
   * one the console already subscribes to — exactly once, in the frame's binder.
   * Handing the STORE here is what lets a page bind to that stream rather than
   * open a second `daemon.subscribe`, which would be a second copy of one feed.
   *
   * It is the retained session's store and never a store a page may open: the
   * registry resolves it, `undefined` means this window has that session closed,
   * and a page reads that as one refresh signal fewer rather than as a failure.
   */
  readonly retainedSessionStore: SessionStore | undefined;
  /**
   * What this window has been told about the shell it is running against.
   *
   * READ FROM THE WINDOW'S OWN STORE, never re-read here. The frame opens exactly one
   * subscription for it and every consumer — the frame's chip, the palette's
   * read-only line, and the local-runtime page — renders the same value, so the three
   * surfaces cannot report different supervisor states in one window.
   */
  readonly shellState: ShellState;
  /**
   * This window's durable store, for the one page that reports on the store itself.
   *
   * Required rather than optional, because the surface that builds this context is
   * handed one and every window has exactly one. An optional member would be a type
   * saying a page might have to do without a store the composition always supplies,
   * and the page reporting the store's own state would then carry an absence arm
   * that is unreachable — an absence nothing can produce reads as a state a person
   * might one day see.
   *
   * A page reaching for it to hold its OWN durable state is not what this admits:
   * the chokepoint's value classes are closed, and a page storing something outside
   * them is refused by the store rather than by this comment.
   */
  readonly uiStateStore: UiStateStore;
}

/** What a page renders. A function rather than a component type, as the seats are. */
export type SettingsPageBody = (context: SettingsPageContext) => ReactNode;
