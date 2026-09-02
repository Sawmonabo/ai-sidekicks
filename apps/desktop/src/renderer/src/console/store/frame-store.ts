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
    this.#store = createStore<FrameStoreState>(() => ({
      route: options.initialRoute ?? DEFAULT_ROUTE,
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

  public navigate(route: ConsoleRoute): void {
    this.#store.setState({ route });
  }

  /** Adopt a route parsed from the location hash. Idempotent on an unchanged hash. */
  public adoptHash(hash: string): void {
    const route = parseRoute(hash);
    const current = this.#store.getState().route;
    if (routesAreEqual(current, route)) {
      return;
    }
    this.#store.setState({ route });
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

  public dismissBanner(bannerId: string): void {
    const banners = this.#store.getState().banners.filter((banner) => banner.id !== bannerId);
    this.#store.setState({ banners });
  }
}
