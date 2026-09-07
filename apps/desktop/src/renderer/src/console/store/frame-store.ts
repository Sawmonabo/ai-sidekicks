// Window-level state: the route, the scheme, the palette, the banner stack.
//
// Kept separate from `SessionStore` on purpose. Session state is per session and
// arrives from the bridge through the apply chokepoint; frame state is per WINDOW
// and arrives from the person using it. Folding them together would mean a session
// switch re-rendering the icon rail, and an auxiliary window — which by I-023-12
// shares no store with the main one — inheriting a route it does not have.
//
// Nothing here polls, and nothing here holds a copy of anything the session store
// owns. `activeSessionId` is a route projection, not a second record of which
// session is open.
//
// `lastOpenedSessionId` is the one piece of session-shaped state this store does
// keep, and it is neither of those things: it is a fact about where this WINDOW has
// been, which no other module records. It is written only by a route transition
// that names a session and read only to answer "which session does Workspace go
// back to" — so it is a navigation memory, not a second answer to "which sessions
// are open", which stays the registry's alone.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { ConsoleRefusal } from "../core/index.js";
import { toReadableStore, type ConsoleReadableStore } from "./readable.js";
import {
  DEFAULT_ROUTE,
  parseRoute,
  routeSessionId,
  routesAreEqual,
  type ConsoleRoute,
} from "../routing/index.js";
import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "../tokens/index.js";

/**
 * One frame-level banner — the third of the three refusal RENDERINGS named by
 * `Spec-023 §Console Design (Meridian)` rule 9: a refusal that changes what the
 * whole room can do goes across the workspace rather than inline on a control.
 *
 * The two rendered fields are taken from `ConsoleRefusal` rather than re-declared
 * beside it, so a producer spreads a refusal straight into a banner
 * (`{ id, dismissible, ...refusal }`) and the three renderings cannot drift into
 * three shapes. `origin` is deliberately NOT picked up: rule 9 fixes on-screen
 * refusal content at the code and the message, and the inline renderer made the
 * same choice — a banner is a rendering, not a second copy of the refusal record.
 *
 * A type-only import, so this adds no runtime edge from `store/` into `core/`.
 */
export interface FrameBanner extends Pick<ConsoleRefusal, "code" | "detail"> {
  readonly id: string;
  readonly dismissible: boolean;
}

export interface FrameStoreState {
  readonly route: ConsoleRoute;
  /**
   * The session this window most recently had in hand, kept after the route stops
   * naming one.
   *
   * WHY IT IS KEPT. `SessionStoreRegistry` deliberately does not close a session
   * when the route leaves it, so a person who opens a session and then goes to
   * Settings still HAS that session open — but every consumer that asked the route
   * was told otherwise, so the rail dropped its Workspace entry and the command
   * that would have gone back had no id to go back with. A session that is open and
   * unreachable is the worst of the three states.
   *
   * WHY IT IS NOT PERSISTED. It is window-lifetime state, beside `isPaletteOpen`
   * and `isWindowFocused` rather than beside the colour scheme. After a reload
   * nothing is open — the registry is fresh — so a restored id would offer a way
   * back into a session this window is not in, which may since have been deleted,
   * archived, or moved to another node; the frame would be promising something only
   * the daemon can honour. The window re-seeds this from the hash it opens at, which
   * is the one session a reload genuinely does restore.
   */
  readonly lastOpenedSessionId: string | undefined;
  readonly schemePreference: SchemePreference;
  readonly isPaletteOpen: boolean;
  readonly banners: readonly FrameBanner[];
  /** True while the window has focus; the refresh scheduler's `window-focus` reason. */
  readonly isWindowFocused: boolean;
}

export interface FrameStoreOptions {
  readonly initialRoute?: ConsoleRoute;
  readonly initialSchemePreference?: SchemePreference;
}

export class FrameStore {
  readonly #store: StoreApi<FrameStoreState>;

  public constructor(options: FrameStoreOptions = {}) {
    const initialRoute = options.initialRoute ?? DEFAULT_ROUTE;
    this.#store = createStore<FrameStoreState>(() => ({
      route: initialRoute,
      // Seeded from the opening route rather than left empty and filled by the
      // first transition: a window opened AT a session has that session in hand on
      // its first render, and a rail that hid Workspace until the person navigated
      // away and back would be hiding a destination the window is already on.
      lastOpenedSessionId: routeSessionId(initialRoute),
      schemePreference: options.initialSchemePreference ?? SYSTEM_SCHEME_PREFERENCE,
      isPaletteOpen: false,
      banners: [],
      isWindowFocused: true,
    }));
  }

  /** Read-only handle for components. No setter escapes the class. */
  public get readable(): ConsoleReadableStore<FrameStoreState> {
    return toReadableStore(this.#store);
  }

  public getState(): FrameStoreState {
    return this.#store.getState();
  }

  /** The session the route names, or `undefined`. A projection, never a copy. */
  public get activeSessionId(): string | undefined {
    return routeSessionId(this.#store.getState().route);
  }

  /**
   * The session Workspace goes back to: the last one this window opened, whether or
   * not the current route still names it. `undefined` until one has been opened.
   */
  public get lastOpenedSessionId(): string | undefined {
    return this.#store.getState().lastOpenedSessionId;
  }

  public navigate(route: ConsoleRoute): void {
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

  public setWindowFocused(isWindowFocused: boolean): void {
    if (this.#store.getState().isWindowFocused === isWindowFocused) {
      return;
    }
    this.#store.setState({ isWindowFocused });
  }

  /** Raise a banner. A second banner with the same id replaces the first. */
  public raiseBanner(banner: FrameBanner): void {
    const banners = this.#store.getState().banners.filter((existing) => existing.id !== banner.id);
    this.#store.setState({ banners: [...banners, banner] });
  }

  /**
   * Raise a refusal as the banner rendering — the third of rule 9's three, and the
   * only one available to an act with no surface of its own.
   *
   * The banner is keyed on the refusal's ORIGIN and CODE together, so a second
   * failure of one act replaces its own banner rather than stacking a duplicate of
   * the same sentence, and two subsystems that happen to share a code word do not
   * overwrite each other. The code alone was enough while one producer existed;
   * it stopped being enough the moment a second one did.
   */
  public raiseRefusalBanner(refusal: ConsoleRefusal): void {
    this.raiseBanner({
      id: `${refusal.origin}:${refusal.code}`,
      dismissible: true,
      code: refusal.code,
      detail: refusal.detail,
    });
  }

  /**
   * Dismiss a banner by id. A miss publishes nothing: the version banner's effect
   * dismisses on every mount and every subject re-address before it has raised
   * anything, and a new `banners` array on each of those is a notification to every
   * frame subscriber about a set that did not move.
   */
  public dismissBanner(bannerId: string): void {
    const banners = this.#store.getState().banners;
    if (!banners.some((banner) => banner.id === bannerId)) {
      return;
    }
    this.#store.setState({ banners: banners.filter((banner) => banner.id !== bannerId) });
  }

  /**
   * The one route writer.
   *
   * Both directions of the route — the rail's `navigate` and the hash's
   * `adoptHash` — pass through here so the retained session cannot be left behind
   * by one of them. A route that names no session leaves it alone, which is the
   * whole behaviour: leaving a workspace does not make it unreachable.
   */
  #setRoute(route: ConsoleRoute): void {
    const sessionId = routeSessionId(route);
    this.#store.setState(
      sessionId === undefined ? { route } : { route, lastOpenedSessionId: sessionId },
    );
  }
}
