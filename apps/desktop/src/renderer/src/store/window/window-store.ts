// Window-level state: the route, the scheme, the palette, the banner stack.
//
// Kept separate from `SessionStore` on purpose. Session state is per session and
// arrives from the bridge through the apply chokepoint; frame state is per WINDOW and
// arrives from the person using it. Folding them together would mean a session switch
// re-rendering the icon rail, and an auxiliary window — which shares no store with the
// main one — inheriting a route it does not have.
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
import type { Refusal } from "@renderer/lib/refusal.js";
import { ModalDialogClaims } from "./modal-dialog-claims.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import {
  UNREPORTED_MAIN_PROCESS_STATE,
  mainProcessReportsAreEqual,
  type MainProcessState,
} from "./main-process-state.js";
import { DEFAULT_ROUTE, parseRoute, type AppRoute } from "@renderer/routing/routes.js";
import { routeSessionId, routesAreEqual } from "@renderer/routing/route-readers.js";
import { SYSTEM_SCHEME_PREFERENCE, type SchemePreference } from "@renderer/styles/tokens.js";

/**
 * One frame-level banner — the third of the three refusal RENDERINGS: a refusal that
 * changes what the whole room can do goes across the session screen rather than inline on a
 * control.
 *
 * The two rendered fields are taken from `Refusal` rather than re-declared
 * beside it, so a producer spreads a refusal straight into a banner
 * (`{ id, dismissible, ...refusal }`) and the three renderings cannot drift into
 * three shapes. `origin` is deliberately NOT picked up: rule 9 fixes on-screen
 * refusal content at the code and the message, and the inline renderer made the
 * same choice — a banner is a rendering, not a second copy of the refusal record.
 *
 * A type-only import, so this adds no runtime edge from `store/` into `core/`.
 */
export interface WindowBanner extends Pick<Refusal, "code" | "detail"> {
  readonly id: string;
  readonly dismissible: boolean;
}

export interface WindowStoreState {
  readonly route: AppRoute;
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
   * and `isWindowFocused` rather than beside the color scheme. After a reload
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
   * WHY THE FRAME CANNOT ASK. The adopted dialog family runs under `modal="trap-focus"`,
   * which traps focus and leaves inerting the app root to the shell — so the shell has to
   * know that a dialog is up. It knows that for the palette, whose open state it owns. It
   * cannot know it for a card a feature renders: the frame imports no feature, so there
   * is no seam for the frame to read and the feature has to publish. This is that seam, and it is on the WINDOW store because
   * that is what the fact is about — a window with a card up, not a session with one.
   *
   * THE PALETTE IS DELIBERATELY NOT RECORDED HERE. Its open state already has an
   * owner one layer up, and a copy of it in this cell would be a second record free
   * to disagree with the first. The frame folds the two at the one place that reads
   * both.
   *
   * DERIVED FROM A REGISTER AND WRITTEN BY NOBODY. Two window-scoped surfaces can be
   * up at once, and while each published this cell directly the first to close cleared
   * it under the one still open. {@link WindowStore.modalDialogClaims} holds the
   * claimants and owns the only write; this cell is `size > 0` and nothing else.
   */
  readonly isModalDialogOpen: boolean;
  readonly banners: readonly WindowBanner[];
  /**
   * True while the window has focus; the refresh scheduler's `window-focus` reason.
   *
   * SEEDED FROM THE DOCUMENT AND NEVER ASSUMED — {@link documentReportsWindowFocus}
   * states why — and moved afterwards by the frame's focus and blur listeners.
   */
  readonly isWindowFocused: boolean;
  /**
   * What the main process has reported about itself, folded with this window's own
   * recovery state.
   *
   * WINDOW STATE AND NOT SESSION STATE, which is why it is here rather than on a
   * session store: the daemon supervisor, the handshake, the transport, and the
   * keystore are facts about this PROCESS, and an auxiliary window — which shares no
   * store with the main one — has its own bridge and therefore its own
   * report.
   *
   * `store/window/main-process-state.ts` owns the vocabulary and the two derivations every reader
   * shares; this store owns the one copy. It is here rather than in the frame family
   * because its readers span the DAG in both directions — the palette below the
   * frame, the settings pages and the sessions list above it — and a value declared
   * in `frame/` is one none of them may import.
   */
  readonly mainProcessState: MainProcessState;
}

export interface WindowStoreOptions {
  readonly initialRoute?: AppRoute;
  readonly initialSchemePreference?: SchemePreference;
}

export class WindowStore {
  readonly #store: StoreApi<WindowStoreState>;
  /**
   * The open modal surfaces this window holds, and the one writer of the cell above.
   *
   * Constructed here rather than handed in, because its lifetime is this store's: the
   * register and the cell it derives are two halves of one fact, and a caller able to
   * supply a second register could publish into a cell no surface's claim reached.
   */
  readonly #modalDialogClaims: ModalDialogClaims;

  public constructor(options: WindowStoreOptions = {}) {
    const initialRoute = options.initialRoute ?? DEFAULT_ROUTE;
    this.#store = createStore<WindowStoreState>(() => ({
      route: initialRoute,
      // Seeded from the opening route rather than left empty and filled by the
      // first transition: a window opened AT a session has that session in hand on
      // its first render, and a rail that hid Workspace until the person navigated
      // away and back would be hiding a destination the window is already on.
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
   * Where a family-owned modal surface takes and gives up its claim on the window.
   *
   * Handed out rather than wrapped in a pair of methods on this class, so a claim is
   * something a surface HOLDS: `modal-dialog-claims.ts` states why the register can
   * add and remove only the caller's own id and offers no clear-all.
   */
  public get modalDialogClaims(): ModalDialogClaims {
    return this.#modalDialogClaims;
  }

  /**
   * Record what the main process says about itself.
   *
   * Compared before it is written, because the subscription behind it answers with a
   * fresh object per frame: an unguarded write on every heartbeat would re-render
   * every reader of the state for a value that did not move. The comparison is written
   * over the connection union in `main-process-state.ts`, so a new arm fails to compile there
   * rather than comparing false forever.
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
   * Raise a refusal as the banner rendering — the third of rule 9's three, and the
   * only one available to an act with no surface of its own.
   *
   * The banner is keyed on the refusal's ORIGIN and CODE together, so a second
   * failure of one act replaces its own banner rather than stacking a duplicate of
   * the same sentence, and two subsystems that happen to share a code word do not
   * overwrite each other. The code alone was enough while one producer existed;
   * it stopped being enough the moment a second one did.
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
   * Write what the register says, once it has moved.
   *
   * Compared before it is written, on {@link setWindowFocused}'s reasoning: the
   * publisher writes from an effect that re-runs whenever its own inputs move, and an
   * unguarded write on an unchanged value would re-render the rail, the surface, and
   * every banner for a fact that did not move.
   */
  #setModalDialogOpen(isModalDialogOpen: boolean): void {
    if (this.#store.getState().isModalDialogOpen === isModalDialogOpen) {
      return;
    }
    this.#store.setState({ isModalDialogOpen });
  }

  /**
   * The one route writer.
   *
   * Both directions of the route — the rail's `navigate` and the hash's
   * `adoptHash` — pass through here so the retained session cannot be left behind
   * by one of them. A route that names no session leaves it alone, which is the
   * whole behavior: leaving a session screen does not make it unreachable.
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
 * THE ONE READING OF THAT QUESTION, and it is a seed rather than a subscription: what
 * keeps the cell current afterwards is the frame's focus and blur pair, and a second
 * reader here would be a second answer free to disagree with the transitions.
 *
 * IT IS READ RATHER THAN ASSUMED, which is the whole of why it exists. The cell was
 * seeded `true` and moved only on a later transition, so a window that opened WITHOUT
 * focus — an auxiliary window placed behind the one a person is in, a main window
 * restored minimised, any window opened while the person was in another application —
 * never received the `blur` that would have corrected it and spent its whole life
 * claiming an audience it did not have. That is not cosmetic: the attention emitter
 * withholds a banner about the session a FOCUSED window is already showing, so every
 * new item of such a window's active session was dropped and nobody was told.
 *
 * BOTH READINGS, CONJOINED, because neither implies the other and the audience rule
 * means both. `hasFocus()` answers whether this document holds the keyboard —
 * a visible window beside a focused one does not — and `visibilityState` answers
 * whether it is on screen at all, which a minimised window that had focus when it went
 * down is not. The conjunction also fails in the safer direction: a banner about
 * something already on screen is a smaller harm than silence about something that is
 * not.
 *
 * PER WINDOW BY CONSTRUCTION. An auxiliary window is its own renderer process with its
 * own document and its own store, so this reads that window's own state and
 * no other's — there is no window identifier to thread and nothing to key on.
 */
function documentReportsWindowFocus(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}
