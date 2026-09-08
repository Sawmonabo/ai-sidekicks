// The shell's answer to "put this pane in a window of its own" — Plan-023 Phase 1C.
//
// `./auxiliary-window.ts` owns WHICH window opens and on what; `./window.ts` owns
// HOW one is constructed. This module owns the third question neither of them can
// answer: which RENDERER asked, which window it got, and where the report goes when
// that window stops being open. It is the only module under `src/main/` that
// registers an `ipcMain` handler, so the preload boundary this package holds has one
// crossing point rather than one per feature.
//
// WHY IT EXISTS AT ALL. Before it, `createAuxiliaryWindow` had exactly one caller —
// the `Window` menu — and the deck's "open in window" control reached no shell in any
// build: the console's growth port refused it under the live bridge and a fixture
// model answered it with a synthetic handle. So pressing the control suppressed the
// pane's body and left a placeholder with nothing behind it. This is the handler that
// makes the control real, and the console's auxiliary-window port calls it directly.
//
// THREE PROPERTIES THE HANDLERS OWE, EACH ONE MEASURED BY ITS OWN CASE:
//
//   1. **Validation before construction.** A route is untrusted input arriving over
//      IPC and is narrowed against the closed set before a descriptor is composed;
//      every id in that descriptor, and whether the route is IMPLEMENTED, is then
//      `createAuxiliaryWindow`'s own admission — which also runs to completion before
//      it constructs anything, so a bad request costs a throw and not a live window.
//   2. **One window per pane, and a pane is a SESSION's pane.** A pane's body cannot
//      be in two windows at once, so a second detach of a pane already in one answers
//      with the handle it already has and brings that window forward. Minting a second
//      would orphan the first and leave the deck addressing a window nobody can reach.
//      Which pane that is, though, is not the local `pane-N` a deck minted: every
//      `DeckLayout` starts at `pane-1`, and this registry is one registry for the whole
//      application, so two sessions' first panes collided here — session B's detach was
//      answered with session A's window, and B's deck then suppressed its own pane in
//      favour of a window showing A's. The identity is the session-scoped one both
//      processes share (`auxiliaryPaneIdentity`), and the session half comes off the
//      ADMITTED launch descriptor rather than off the request, so a member the route
//      does not carry cannot scope a record.
//   3. **Every ending is reported, and the two endings stay apart.** A window that was
//      asked to close reports a RETURN; a window whose renderer died reports an
//      ERROR carrying the reason. Both reach the renderer that asked for the window,
//      by its own `WebContents`, because a report broadcast to every window would tell
//      three decks that a pane none of them holds has come back. Both name the WINDOW
//      as well as the pane, for the reason property 2 gives: that renderer holds every
//      session's hand-off and its decks all mint a `pane-1`, so a report naming only
//      the pane reached every session holding that local id — and the ones whose
//      windows were still open took their placeholders down over somebody else's crash.
//
// The reports travel as `webContents.send`, which is the only direction available: an
// `ipcMain.handle` reply answers the call that asked, and a window closing is not a
// call anybody made.

import { ipcMain, type BrowserWindow, type WebContents } from "electron";

import {
  AUXILIARY_WINDOW_CHANNELS,
  auxiliaryPaneIdentity,
  type AuxiliaryWindowDetachRequest,
  type AuxiliaryWindowHandle,
  type AuxiliaryWindowPaneError,
  type AuxiliaryWindowPaneReturn,
} from "@ai-sidekicks/contracts";

import { isAuxiliaryRouteName, type AuxiliaryRouteName } from "../shared/auxiliary-routes.js";
import {
  createAuxiliaryWindow,
  InvalidAuxiliaryWindowLaunchError,
  type AuxiliaryWindowLaunch,
} from "./auxiliary-window.js";

/**
 * Refusal raised when a request names a window this shell is not holding.
 *
 * A distinct class rather than a bare `Error` so the renderer's port can tell a
 * handle that has expired — a window that closed while a press was in flight — from
 * a handler that failed. The message names no handle: a value that failed a lookup is
 * caller-supplied, and echoing it into a log is how untrusted input reaches a reader.
 */
export class UnknownAuxiliaryWindowError extends Error {
  public constructor() {
    super("no auxiliary window is open under that handle");
    this.name = "UnknownAuxiliaryWindowError";
  }
}

/** One auxiliary window this shell is holding, and who asked for it. */
interface HeldAuxiliaryWindow {
  readonly windowId: string;
  /**
   * The session-scoped identity this window is filed under.
   *
   * Held beside {@link HeldAuxiliaryWindow.paneId} rather than instead of it, because
   * the two are asked different questions: this one answers "is that pane already in a
   * window", and the deck's own local id is what the reports name — the renderer files
   * its hand-offs per session already, so a report carrying a composite would make it
   * decode a key the shell composed.
   */
  readonly paneIdentity: string;
  readonly paneId: string;
  readonly browserWindow: BrowserWindow;
  /** The renderer that asked. Every report about this window goes to it and nowhere else. */
  readonly requester: WebContents;
}

/**
 * Every auxiliary window this shell is holding, keyed both ways.
 *
 * A class with private fields rather than two module-level `Map`s, because the two
 * indexes plus the handle counter are ONE piece of state: a window joins all three
 * together and leaves all three together, and holding them as free bindings lets a
 * later edit update one without the others — which is exactly the orphaned-handle
 * state property 2 above exists to rule out.
 */
class AuxiliaryWindowRegistry {
  readonly #byPaneIdentity = new Map<string, HeldAuxiliaryWindow>();
  readonly #byWindowId = new Map<string, HeldAuxiliaryWindow>();
  #mintedWindowCount = 0;

  /**
   * Open a window for one pane, or answer with the one it is already in.
   *
   * The handle is minted BEFORE the window is constructed, because the window's own
   * route carries it: a detached window addresses the shell about itself by that
   * handle, and one constructed without it could only ever close itself and leave the
   * deck holding a placeholder for a window that no longer exists. It is COMMITTED
   * only on the miss, so a second detach of a pane that is already in a window neither
   * mints a handle nor leaves a gap in the sequence the next one takes.
   *
   * The descriptor is composed once, ahead of the lookup, because the identity is read
   * off it: `auxiliaryLaunchFor` is what decides whether a route carries the session at
   * all, and a key composed from the raw request would file an `agent-console` detach
   * under a session its own launch dropped.
   */
  public detachPane(
    request: AuxiliaryWindowDetachRequest,
    requester: WebContents,
  ): AuxiliaryWindowHandle {
    const route = admittedRoute(request.route);
    const windowId = `auxiliary-window-${String(this.#mintedWindowCount + 1)}`;
    // Every id the descriptor carries is validated inside the factory, against the
    // shared route grammar, before a window exists — so a malformed session or agent
    // id costs a throw and not a live window pointed at a URL.
    const launch = auxiliaryLaunchFor(route, windowId, request);
    const paneIdentity = auxiliaryPaneIdentity(launch.sessionId, request.paneId);
    const existing = this.#byPaneIdentity.get(paneIdentity);
    if (existing !== undefined) {
      existing.browserWindow.focus();
      return { windowId: existing.windowId };
    }

    this.#mintedWindowCount += 1;
    const browserWindow = createAuxiliaryWindow(launch);

    const held: HeldAuxiliaryWindow = {
      windowId,
      paneIdentity,
      paneId: request.paneId,
      browserWindow,
      requester,
    };
    this.#byPaneIdentity.set(paneIdentity, held);
    this.#byWindowId.set(windowId, held);
    this.#watchEnding(held);
    return { windowId };
  }

  /** Bring one held window forward. An unheld handle refuses. */
  public focusAuxiliary(handle: AuxiliaryWindowHandle): void {
    this.#held(handle).browserWindow.focus();
  }

  /**
   * Close one held window.
   *
   * The RETURN report is left to the `closed` listener rather than sent here, so a
   * window that closes from its own header and a window the deck closed produce the
   * identical record. Reporting only the ones this handler performed would make the
   * shell's account of a window depend on who asked, which is the one fact the shell
   * is the authority on.
   */
  public closeAuxiliary(handle: AuxiliaryWindowHandle): void {
    const held = this.#held(handle);
    if (!held.browserWindow.isDestroyed()) {
      held.browserWindow.close();
    }
  }

  /**
   * Register the two endings, and forget the window when either arrives.
   *
   * A crash is recorded on `render-process-gone` and REPORTED on `closed`, in that
   * order and never in one: `./auxiliary-window.ts` destroys a window whose renderer
   * died, so the crash always reaches `closed` too, and a report sent from each
   * listener would send two. Which of the two reports goes out is decided by whether a
   * reason was recorded, so the ordering is the discriminator rather than a flag any
   * later edit could set from a third place.
   */
  #watchEnding(held: HeldAuxiliaryWindow): void {
    let lostReason: string | undefined;
    held.browserWindow.webContents.on("render-process-gone", (_event, details) => {
      lostReason = `The window's renderer stopped (${details.reason}).`;
    });
    held.browserWindow.on("closed", () => {
      this.#forget(held);
      if (held.requester.isDestroyed()) {
        // The deck that asked has gone. Nothing to tell, and `send` on a destroyed
        // `WebContents` throws.
        return;
      }
      if (lostReason === undefined) {
        const report: AuxiliaryWindowPaneReturn = {
          windowId: held.windowId,
          paneId: held.paneId,
        };
        held.requester.send(AUXILIARY_WINDOW_CHANNELS.paneReturn, report);
        return;
      }
      const report: AuxiliaryWindowPaneError = {
        windowId: held.windowId,
        paneId: held.paneId,
        reason: lostReason,
      };
      held.requester.send(AUXILIARY_WINDOW_CHANNELS.paneError, report);
    });
  }

  #held(handle: AuxiliaryWindowHandle): HeldAuxiliaryWindow {
    const held = this.#byWindowId.get(handle.windowId);
    if (held === undefined) {
      throw new UnknownAuxiliaryWindowError();
    }
    return held;
  }

  #forget(held: HeldAuxiliaryWindow): void {
    this.#byWindowId.delete(held.windowId);
    this.#byPaneIdentity.delete(held.paneIdentity);
  }
}

/**
 * The route a request names, narrowed — or a refusal.
 *
 * A NARROWING and not a second admission check. `AuxiliaryWindowLaunch` is a union
 * discriminated on the route literal, so a descriptor cannot be composed from the
 * `string` a request carries at all: this guard is what the type system requires
 * before {@link auxiliaryLaunchFor} can build one, and removing it is a compile error
 * rather than a behaviour a test has to catch.
 *
 * It deliberately does NOT re-check `IMPLEMENTED_AUXILIARY_ROUTES`. That question —
 * whether a route this build carries has a renderer body behind it — is
 * `resolveAuxiliaryLaunch`'s, which refuses it with this same error class before
 * constructing anything, and asking it twice would be two copies of one rule with two
 * places to edit when the implemented set moves.
 */
function admittedRoute(route: string): AuxiliaryRouteName {
  if (!isAuxiliaryRouteName(route)) {
    throw new InvalidAuxiliaryWindowLaunchError("unknown route");
  }
  return route;
}

/**
 * The launch descriptor for one admitted detach.
 *
 * A switch rather than a spread, for the reason the shared route grammar states:
 * `AuxiliaryWindowLaunch` is discriminated ON the route, and a value typed
 * `{ route: "timeline" | "agent-console" }` is assignable to no single member of it.
 * The optional members are set conditionally rather than passed as `undefined`,
 * because `exactOptionalPropertyTypes` distinguishes an absent member from a present
 * one holding `undefined` and the grammar's bare arm is the absent one.
 */
function auxiliaryLaunchFor(
  route: AuxiliaryRouteName,
  windowId: string,
  request: AuxiliaryWindowDetachRequest,
): AuxiliaryWindowLaunch {
  const { sessionId, agentId } = request;
  if (route === "timeline") {
    return sessionId === undefined ? { route, windowId } : { route, sessionId, windowId };
  }
  if (sessionId === undefined || agentId === undefined) {
    return { route, windowId };
  }
  return { route, sessionId, agentId, windowId };
}

/**
 * Register the three auxiliary-window handlers on `ipcMain`.
 *
 * Called once, from the ready continuation, after the renderer protocol is installed
 * and before the first window exists — so a renderer cannot reach an unregistered
 * channel, and `invoke` never rejects with the missing-handler message that reads
 * like a missing feature.
 *
 * Idempotent by construction: `ipcMain.handle` throws on a second registration for
 * one channel, so a second call is a startup defect this reports rather than a
 * silently stacked listener. The registry is minted here rather than at module scope
 * because a module-level singleton is exactly the free binding {@link
 * AuxiliaryWindowRegistry} exists to avoid.
 */
export function installAuxiliaryWindowControls(): void {
  const registry = new AuxiliaryWindowRegistry();

  ipcMain.handle(
    AUXILIARY_WINDOW_CHANNELS.detachPane,
    (event, request: AuxiliaryWindowDetachRequest) => registry.detachPane(request, event.sender),
  );
  ipcMain.handle(
    AUXILIARY_WINDOW_CHANNELS.focusAuxiliary,
    (_event, handle: AuxiliaryWindowHandle) => {
      registry.focusAuxiliary(handle);
    },
  );
  ipcMain.handle(
    AUXILIARY_WINDOW_CHANNELS.closeAuxiliary,
    (_event, handle: AuxiliaryWindowHandle) => {
      registry.closeAuxiliary(handle);
    },
  );
}
