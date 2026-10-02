// Window-level state: the route, the scheme, the palette, the banner stack.
//
// Separate from `SessionStore`: session state is per session and arrives from the bridge, while
// frame state is per window and arrives from the person. Merging them would re-render the rail on
// a session switch. Nothing here copies what
// the session store owns: `activeSessionId` is a route projection, and `lastOpenedSessionId` is
// navigation memory (where this window has been), not a record of which sessions are open.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Refusal } from "@renderer/lib/refusal.js";
import { ModalDialogClaims } from "./modal-dialog-claims.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import type { MainProcessState } from "@shared/daemon-status-topic.js";
import { UNREPORTED_MAIN_PROCESS_STATE, mainProcessReportsAreEqual } from "./main-process-state.js";
import { DEFAULT_ROUTE, parseRoute, type AppRoute } from "@renderer/routing/routes.js";
import { routeSessionId, routesAreEqual } from "@renderer/routing/route-readers.js";
import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "@renderer/styles/tokens.js";

/**
 * One frame-level banner: the banner rendering of a refusal that changes what the whole room can
 * do. It takes `code` and `detail` from `Refusal` so a producer can spread a refusal into it;
 * `origin` is not shown.
 */
export interface WindowBanner extends Pick<Refusal, "code" | "detail"> {
  readonly id: string;
  readonly dismissible: boolean;
}

/** The window store's state: route, scheme, palette, modal-dialog flag, banners, focus, report. */
export interface WindowStoreState {
  readonly route: AppRoute;
  /**
   * The session this window most recently had in hand, kept after the route stops naming one.
   * The registry does not close a session when the route leaves it, so without this the rail
   * would drop Workspace and the go-back command would have no id. Not persisted: after a reload
   * nothing is open, and a restored id could offer a way back into a session this window is not
   * in. It is re-seeded from the hash the window opens at.
   */
  readonly lastOpenedSessionId: string | undefined;
  readonly schemePreference: SchemePreference;
  readonly isPaletteOpen: boolean;
  /**
   * True while a modal dialog the frame cannot name owns the window. The dialog runs under
   * `modal="trap-focus"`, which leaves inerting the app root to `AppShell`; the frame knows the
   * palette but imports no feature, so a feature's card has to publish here. The palette is not
   * recorded here because its open state has an owner one layer up. Derived from
   * {@link WindowStore.modalDialogClaims}, which owns the only write: this cell is `size > 0`.
   */
  readonly isModalDialogOpen: boolean;
  readonly banners: readonly WindowBanner[];
  /**
   * True while the window has focus; the refresh scheduler's `window-focus` reason. Seeded from
   * the document ({@link documentReportsWindowFocus}) and moved by the frame's focus and blur
   * listeners.
   */
  readonly isWindowFocused: boolean;
  /**
   * What the main process reported about itself, folded with this window's recovery state. It is
   * window state because the supervisor, handshake, transport and keystore are facts about a
   * process. It lives in `store/` because the
   * settings pages read it and a feature may not import `layout/`.
   */
  readonly mainProcessState: MainProcessState;
}

/** Construction options for {@link WindowStore}. */
export interface WindowStoreOptions {
  readonly initialRoute?: AppRoute;
  readonly initialSchemePreference?: SchemePreference;
}

/** The per-window frame store. No setter escapes the class. */
export class WindowStore {
  readonly #store: StoreApi<WindowStoreState>;
  /**
   * The open modal dialogs this window holds, and the one writer of `isModalDialogOpen`. Built
   * here because a caller-supplied register could publish into a cell no dialog's claim reached.
   */
  readonly #modalDialogClaims: ModalDialogClaims;

  public constructor(options: WindowStoreOptions = {}) {
    const initialRoute = options.initialRoute ?? DEFAULT_ROUTE;
    this.#store = createStore<WindowStoreState>(() => ({
      route: initialRoute,
      // Seeded from the opening route so a window opened at a session has it in hand at once.
      lastOpenedSessionId: routeSessionId(initialRoute),
      schemePreference: options.initialSchemePreference ?? SYSTEM_SCHEME_PREFERENCE,
      isPaletteOpen: false,
      isModalDialogOpen: false,
      banners: [],
      isWindowFocused: documentReportsWindowFocus(),
      mainProcessState: UNREPORTED_MAIN_PROCESS_STATE,
    }));
    this.#modalDialogClaims = new ModalDialogClaims((isAnyHeld) => {
      this.#setModalDialogOpen(isAnyHeld);
    });
  }

  /** Read-only handle for components. No setter escapes the class. */
  public get readable(): ReadableStore<WindowStoreState> {
    return toReadableStore(this.#store);
  }

  public getState(): WindowStoreState {
    return this.#store.getState();
  }

  /** The session the route names, or `undefined`. A projection, never a copy. */
  public get activeSessionId(): string | undefined {
    return routeSessionId(this.#store.getState().route);
  }

  /**
   * The session the session screen returns to: the last one this window opened, whether or
   * not the current route still names it. `undefined` until one has been opened.
   */
  public get lastOpenedSessionId(): string | undefined {
    return this.#store.getState().lastOpenedSessionId;
  }

  public navigate(route: AppRoute): void {
    this.#setRoute(route);
  }

  /** Adopt a route parsed from the location hash. Idempotent on an unchanged hash. */
  public adoptHash(hash: string): void {
    const route = parseRoute(hash);
    const current = this.#store.getState().route;
    if (routesAreEqual(current, route)) {
      return;
    }
    this.#setRoute(route);
  }

  public setSchemePreference(schemePreference: SchemePreference): void {
    this.#store.setState({ schemePreference });
  }

  public setPaletteOpen(isPaletteOpen: boolean): void {
    this.#store.setState({ isPaletteOpen });
  }

  /**
   * Where a feature's modal dialog takes and gives up its claim. Handed out rather than wrapped
   * in methods so a claim is something a dialog holds; the register has no clear-all.
   */
  public get modalDialogClaims(): ModalDialogClaims {
    return this.#modalDialogClaims;
  }

  /**
   * Record what the main process says about itself. Compared first: the subscription answers with
   * a fresh object per frame, so a heartbeat would otherwise re-render every reader.
   */
  public publishMainProcessReport(report: MainProcessState): void {
    const { mainProcessState } = this.#store.getState();
    if (mainProcessReportsAreEqual(mainProcessState, report)) {
      return;
    }
    this.#store.setState({ mainProcessState: report });
  }

  public setWindowFocused(isWindowFocused: boolean): void {
    if (this.#store.getState().isWindowFocused === isWindowFocused) {
      return;
    }
    this.#store.setState({ isWindowFocused });
  }

  /** Raise a banner. A second banner with the same id replaces the first. */
  public raiseBanner(banner: WindowBanner): void {
    const banners = this.#store.getState().banners.filter((existing) => existing.id !== banner.id);
    this.#store.setState({ banners: [...banners, banner] });
  }

  /**
   * Raise a refusal as the banner rendering, the only one available to an act with no control or
   * card of its own. Keyed on origin and code together, so a repeat failure replaces its banner
   * and two subsystems sharing a code do not overwrite each other.
   */
  public raiseRefusalBanner(refusal: Refusal): void {
    this.raiseBanner({
      id: `${refusal.origin}:${refusal.code}`,
      dismissible: true,
      code: refusal.code,
      detail: refusal.detail,
    });
  }

  /**
   * Dismiss a banner by id. A miss publishes nothing, so a caller that dismisses on every mount
   * does not notify subscribers about a set that did not move.
   */
  public dismissBanner(bannerId: string): void {
    const banners = this.#store.getState().banners;
    if (!banners.some((banner) => banner.id === bannerId)) {
      return;
    }
    this.#store.setState({ banners: banners.filter((banner) => banner.id !== bannerId) });
  }

  /**
   * Write what the register says, once it has moved. Compared first, as in
   * {@link setWindowFocused}, so an unchanged value does not re-render the rail, screen or
   * banners.
   */
  #setModalDialogOpen(isModalDialogOpen: boolean): void {
    if (this.#store.getState().isModalDialogOpen === isModalDialogOpen) {
      return;
    }
    this.#store.setState({ isModalDialogOpen });
  }

  /**
   * The one route writer, so the retained session cannot be left behind by `navigate` or
   * `adoptHash`. A route that names no session leaves it alone.
   */
  #setRoute(route: AppRoute): void {
    const sessionId = routeSessionId(route);
    this.#store.setState(
      sessionId === undefined ? { route } : { route, lastOpenedSessionId: sessionId },
    );
  }
}

/**
 * Whether somebody is looking at this window right now, asked of its own document.
 *
 * A seed only; the frame's focus and blur listeners keep the cell current. It is read rather than
 * assumed because a window opened without focus (behind another, minimized, or while the person
 * is in another application) never receives the `blur` that would correct a `true` seed. Both
 * readings must hold: `hasFocus()` says this document holds the keyboard and `visibilityState`
 * says it is on screen, and neither implies the other.
 */
function documentReportsWindowFocus(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}
