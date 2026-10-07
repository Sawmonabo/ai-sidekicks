// Window-level state: the route, the modal-dialog flag, the banner stack, which list the sessions
// track holds, the pane a screen asked a session to open, and the guard a screen holding unsaved
// edits keeps over leaving it. The appearance is not here: main keeps it, and the window applies
// what main kept (`app/hooks/useAppearance.ts`).
//
// Separate from `SessionStore`: session state is per session and arrives from the bridge, while
// frame state is per window and arrives from the person. Merging them would re-render the rail on
// a session switch. Nothing here copies what the session store owns: `activeSessionId` is a route
// projection, and `lastOpenedSessionId` is navigation memory (where this window has been), not a
// record of which sessions are open.

import { createStore, type StoreApi } from "zustand/vanilla";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import type { ExtendedRefusal, RefusalExtensions } from "#renderer/lib/refusal/extensions.js";
import { ModalDialogClaims } from "./modal-dialog-claims.js";
import { PaneOpenRequests } from "./pane-open-requests.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import type { MainProcessState } from "#shared/daemon/status-topic.js";
import { UNREPORTED_MAIN_PROCESS_STATE, mainProcessReportsAreEqual } from "./main-process-state.js";
import { LeaveGuard } from "#renderer/routing/leave-guard.js";
import { DEFAULT_ROUTE, parseRoute, type AppRoute } from "#renderer/routing/routes.js";
import { routeSessionId, routesAreEqual } from "#renderer/routing/readers.js";

/**
 * One frame-level banner: the banner rendering of a refusal that changes what the whole room can
 * do. It takes `code` and `detail` from `Refusal` so a producer can spread a refusal into it, and
 * the listed `reason` where the refusal carried one; `origin` is not shown.
 */
export interface WindowBanner extends Pick<Refusal, "code" | "detail"> {
  readonly id: string;
  readonly dismissible: boolean;
  readonly reason?: RefusalExtensions["reason"];
}

/**
 * How a route reaches the window's history: a new entry Back returns from, or a replacement of
 * the current one, for a move that only follows a cursor or one an address change already entered.
 */
export type RouteHistoryWrite = "push" | "replace";

/** A list the sessions track beside the rail can hold. */
export type SessionsTrackList = "notifications";

/** The window store's state: route, modal-dialog flag, banners, sessions track, focus, report. */
export interface WindowStoreState {
  readonly route: AppRoute;
  /** How the current route is written to the window's history. */
  readonly routeHistoryWrite: RouteHistoryWrite;
  /**
   * The session this window most recently had in hand, kept after the route stops naming one.
   * The registry does not close a session when the route leaves it, so without this the rail
   * would lose the session and the go-back command would have no id. Not persisted: after a reload
   * nothing is open, and a restored id could offer a way back into a session this window is not
   * in. It is re-seeded from the hash the window opens at.
   */
  readonly lastOpenedSessionId: string | undefined;
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
   * The list the sessions track holds, or `undefined` while the track is closed. One cell, so the
   * track never holds two lists at once.
   */
  readonly sessionsTrackList: SessionsTrackList | undefined;
  /**
   * True while the window has focus; the refresh scheduler's `window-focus` reason. Seeded from
   * the document ({@link documentReportsWindowFocus}) and moved by the frame's focus and blur
   * listeners.
   */
  readonly isWindowFocused: boolean;
  /**
   * What the main process reported about itself, folded with this window's recovery state. It is
   * window state because the supervisor and the handshake are facts about a process. It lives in
   * `store/` because the settings pages read it and a feature may not import `layout/`.
   */
  readonly mainProcessState: MainProcessState;
}

/** Construction options for {@link WindowStore}. */
export interface WindowStoreOptions {
  readonly initialRoute?: AppRoute;
  /** The document of the window this store is for; absent, this realm's own. */
  readonly ownerDocument?: Document;
}

/** The per-window frame store. No setter escapes the class. */
export class WindowStore {
  readonly #store: StoreApi<WindowStoreState>;
  /**
   * The open modal dialogs this window holds, and the one writer of `isModalDialogOpen`. Built
   * here because a caller-supplied register could publish into a cell no dialog's claim reached.
   */
  readonly #modalDialogClaims: ModalDialogClaims;
  readonly #paneOpenRequests = new PaneOpenRequests();
  readonly #leaveGuard = new LeaveGuard((failure) => {
    // The person waits on the question, so the banner says it failed; the cause, a screen's
    // defect with no words the person can act on, goes to the diagnostic capture.
    this.raiseRefusalBanner(LEAVE_NOT_ASKED);
    recordRejectedRequest("store/window", "leave-ask-failed", failure);
  });

  public constructor(options: WindowStoreOptions = {}) {
    const initialRoute = options.initialRoute ?? DEFAULT_ROUTE;
    this.#store = createStore<WindowStoreState>(() => ({
      route: initialRoute,
      routeHistoryWrite: "push",
      // Seeded from the opening route so a window opened at a session has it in hand at once.
      lastOpenedSessionId: routeSessionId(initialRoute),
      isModalDialogOpen: false,
      banners: [],
      sessionsTrackList: undefined,
      isWindowFocused: documentReportsWindowFocus(options.ownerDocument ?? document),
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

  /** The current state, read once. */
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

  /**
   * Move this window to a route, as a new history entry Back returns from. A move off a screen
   * holding unsaved edits waits for its answer ({@link leaveGuard}); `afterCommit` runs only once
   * the move has happened, never after a no.
   */
  public navigate(route: AppRoute, afterCommit?: () => void): void {
    this.#moveTo(route, "push", afterCommit);
  }

  /**
   * Move this window to a route in place of the current history entry, waiting on the leave guard
   * as `navigate` does.
   */
  public replaceRoute(route: AppRoute): void {
    this.#moveTo(route, "replace");
  }

  /**
   * Adopt a route parsed from the location hash. Idempotent on an unchanged hash. Returns false
   * while the move waits on the leave guard's ask or was dropped by it, so the hash no longer
   * names the route shown; a yes later commits the route the hash named.
   */
  public adoptHash(hash: string): boolean {
    const route = parseRoute(hash);
    const current = this.#store.getState().route;
    if (routesAreEqual(current, route)) {
      return true;
    }
    // The address change already made its own history entry, so the route writes in place.
    return this.#moveTo(route, "replace");
  }

  /**
   * The guard every move away from a screen holding unsaved edits waits on; that screen
   * registers its ask here while its edits are unsaved.
   */
  public get leaveGuard(): LeaveGuard {
    return this.#leaveGuard;
  }

  /**
   * Where a feature's modal dialog takes and gives up its claim. Handed out rather than wrapped
   * in methods so a claim is something a dialog holds; the register has no clear-all.
   */
  public get modalDialogClaims(): ModalDialogClaims {
    return this.#modalDialogClaims;
  }

  /**
   * The pane this window was asked to open in a session's pane layout, held until that layout
   * takes it: how a screen with no layout of its own opens a pane in a session.
   */
  public get paneOpenRequests(): PaneOpenRequests {
    return this.#paneOpenRequests;
  }

  /**
   * Record what the main process says about itself. Compared first: every frame is a fresh
   * object, so a report equal to the last would otherwise re-render every reader.
   */
  public publishMainProcessReport(report: MainProcessState): void {
    const { mainProcessState } = this.#store.getState();
    if (mainProcessReportsAreEqual(mainProcessState, report)) {
      return;
    }
    this.#store.setState({ mainProcessState: report });
  }

  /** Record whether the window has focus; an unchanged value publishes nothing. */
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
  public raiseRefusalBanner(refusal: ExtendedRefusal): void {
    this.raiseBanner({
      id: `${refusal.origin}:${refusal.code}`,
      dismissible: true,
      code: refusal.code,
      detail: refusal.detail,
      ...(refusal.reason === undefined ? {} : { reason: refusal.reason }),
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

  /** Open the notifications list in the sessions track, or close the track while it holds it. */
  public toggleNotificationsList(): void {
    const { sessionsTrackList } = this.#store.getState();
    this.#store.setState({
      sessionsTrackList: sessionsTrackList === "notifications" ? undefined : "notifications",
    });
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

  /** Send a move through the leave guard; true when it committed now. */
  #moveTo(
    route: AppRoute,
    routeHistoryWrite: RouteHistoryWrite,
    afterCommit?: () => void,
  ): boolean {
    return this.#leaveGuard.leave(route, () => {
      this.#setRoute(route, routeHistoryWrite);
      afterCommit?.();
    });
  }

  /**
   * The one route writer, so the retained session cannot be left behind by `navigate` or
   * `adoptHash`. A route that names no session leaves it alone.
   */
  #setRoute(route: AppRoute, routeHistoryWrite: RouteHistoryWrite): void {
    const sessionId = routeSessionId(route);
    this.#store.setState(
      sessionId === undefined
        ? { route, routeHistoryWrite }
        : { route, routeHistoryWrite, lastOpenedSessionId: sessionId },
    );
  }
}

/** What the window's banner says when a screen's question about its unsaved edits failed. */
const LEAVE_NOT_ASKED = refuse(
  "navigation",
  "leave-not-asked",
  "Could not ask about the unsaved changes, so the screen stayed open.",
);

/**
 * Whether somebody is looking at this window right now, asked of its own document.
 *
 * A seed only; the frame's focus and blur listeners keep the cell current. It is read rather than
 * assumed because a window opened without focus (behind another, minimized, or while the person
 * is in another application) never receives the `blur` that would correct a `true` seed. Both
 * readings must hold: `hasFocus()` says this document holds the keyboard and `visibilityState`
 * says it is on screen, and neither implies the other.
 */
function documentReportsWindowFocus(ownerDocument: Document): boolean {
  return ownerDocument.hasFocus() && ownerDocument.visibilityState === "visible";
}
