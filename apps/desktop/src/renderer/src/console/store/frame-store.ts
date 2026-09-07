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
import type { SessionDegradedCause } from "./degradation.js";
import { toReadableStore, type ConsoleReadableStore } from "./readable.js";
import {
  UNREPORTED_SHELL_STATE,
  shellReportsAreEqual,
  type ShellReport,
  type ShellState,
} from "./shell-state.js";
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
  /**
   * True while a modal surface the frame cannot NAME owns the window.
   *
   * WHY THE FRAME CANNOT ASK. `Spec-023 §Console Libraries` adopts the dialog family
   * under `modal="trap-focus"`, which traps focus and leaves inerting the app root to
   * the shell — so the shell has to know that a dialog is up. It knows that for the
   * palette, whose open state it owns. It cannot know it for a card a VIEW family
   * renders: `console-view-family-isolation` forbids the frame from importing one, so
   * there is no seam for the frame to read and the family has to publish. This is
   * that seam, and it is on the WINDOW store because that is what the fact is about —
   * a window with a card up, not a session with one.
   *
   * THE PALETTE IS DELIBERATELY NOT RECORDED HERE. Its open state already has an
   * owner one layer up, and a copy of it in this cell would be a second record free
   * to disagree with the first. The frame folds the two at the one place that reads
   * both.
   *
   * ONE CELL RATHER THAN A REGISTRY OF OPEN SURFACES, because the console has exactly
   * one such surface today. A SECOND publisher makes this a keyed set rather than a
   * boolean: two cards up and whichever closed first would clear the cell under the
   * one still open, and the background would come back reachable underneath it.
   */
  readonly isModalSurfaceOpen: boolean;
  readonly banners: readonly FrameBanner[];
  /** True while the window has focus; the refresh scheduler's `window-focus` reason. */
  readonly isWindowFocused: boolean;
  /**
   * What the shell has reported about itself, folded with this window's own
   * recovery state.
   *
   * WINDOW STATE AND NOT SESSION STATE, which is why it is here rather than on a
   * session store: the daemon supervisor, the handshake, the transport, and the
   * keystore are facts about this PROCESS, and an auxiliary window — which shares no
   * store with the main one (I-023-12) — has its own bridge and therefore its own
   * report.
   *
   * `store/shell-state.ts` owns the vocabulary and the two derivations every reader
   * shares; this store owns the one copy. It is here rather than in the frame family
   * because its readers span the DAG in both directions — the palette below the
   * frame, the settings pages and the sessions list above it — and a value declared
   * in `frame/` is one none of them may import.
   */
  readonly shellState: ShellState;
  /**
   * How many sessions the attention projection reports as needing a person, or
   * `undefined` where nothing is reading the projection.
   *
   * `undefined` IS NOT ZERO, and the distinction is the whole reason this is not a
   * number. `Spec-023 §The surface set` puts an attention count on the sessions
   * destination "taken from the daemon's attention projection, never counted in the
   * renderer", and the design's degraded rule says the count is suppressed while the
   * projection is unreachable — "the rail says nothing rather than showing a stale
   * number". A zero would say the daemon answered and nothing needs you.
   *
   * The count is PUBLISHED by whoever holds the projection read rather than read
   * here, because the console performs that read exactly once per window and a second
   * one would be a second answer to "what needs me".
   */
  readonly railAttentionCount: number | undefined;
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
      isModalSurfaceOpen: false,
      banners: [],
      isWindowFocused: true,
      shellState: UNREPORTED_SHELL_STATE,
      railAttentionCount: undefined,
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

  /**
   * Publish whether a family-owned modal surface has the window.
   *
   * The one writer of {@link FrameStoreState.isModalSurfaceOpen}, and the surface
   * that opens the card is the caller: it writes `true` while the card is up and
   * `false` both when the card closes and when it unmounts, so a card React discards
   * mid-ceremony cannot leave the window inert with nothing on screen to close.
   *
   * Compared before it is written, on {@link setWindowFocused}'s reasoning: the
   * publisher writes from an effect that re-runs whenever its own inputs move, and an
   * unguarded write on an unchanged value would re-render the rail, the surface, and
   * every banner for a fact that did not move.
   */
  public setModalSurfaceOpen(isModalSurfaceOpen: boolean): void {
    if (this.#store.getState().isModalSurfaceOpen === isModalSurfaceOpen) {
      return;
    }
    this.#store.setState({ isModalSurfaceOpen });
  }

  /**
   * Record what the shell says about itself.
   *
   * Compared before it is written, because the subscription behind it answers with a
   * fresh object per frame: an unguarded write on every heartbeat would re-render the
   * chip, the banner stack, and every control that reads the block for a value that
   * did not move. The comparison is written over the connection union in
   * `shell-state.ts`, so a new arm fails to compile there rather than comparing
   * false forever.
   *
   * The window's own recovery fold is NOT overwritten here: the report is the shell's
   * half of the value and {@link publishSessionRecovery} is the window's, so neither
   * owner has to carry the other's fields to write its own.
   */
  public publishShellReport(report: ShellReport): void {
    const { shellState } = this.#store.getState();
    if (shellReportsAreEqual(shellState, report)) {
      return;
    }
    this.#store.setState({
      shellState: { ...report, sessionRecovery: shellState.sessionRecovery },
    });
  }

  /**
   * Record the worst degraded cause standing across this window's open sessions.
   *
   * The store-layer ladder finally reaching a person: `worstDegradedCause` decides
   * which of several standing causes survives, the session stores decide when one is
   * standing, and this is where the answer becomes something the frame can render.
   */
  public publishSessionRecovery(sessionRecovery: SessionDegradedCause | undefined): void {
    const { shellState } = this.#store.getState();
    if (shellState.sessionRecovery === sessionRecovery) {
      return;
    }
    this.#store.setState({ shellState: { ...shellState, sessionRecovery } });
  }

  /**
   * Record how many sessions the attention projection reports as needing a person.
   *
   * `undefined` clears it, which is what a surface publishes when it stops reading
   * the projection or when the read refused — the rail then says nothing rather than
   * holding the last number it was given.
   */
  public publishRailAttentionCount(railAttentionCount: number | undefined): void {
    if (this.#store.getState().railAttentionCount === railAttentionCount) {
      return;
    }
    this.#store.setState({ railAttentionCount });
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

  public dismissBanner(bannerId: string): void {
    const banners = this.#store.getState().banners.filter((banner) => banner.id !== bannerId);
    this.#store.setState({ banners });
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
