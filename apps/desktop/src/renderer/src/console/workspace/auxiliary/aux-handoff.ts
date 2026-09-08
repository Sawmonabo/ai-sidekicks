// Moving a pane into a window of its own, and bringing it back.
//
// This file is the STATE: which panes are in windows right now, which windows were
// lost, and which subscription is open. What a hand-off is made of — the refusal
// vocabulary, the value shapes, and the route grammar the third gate runs — lives in
// `aux-handoff-contract.ts`, which holds no state and reaches no wire.
//
// `Spec-023 §The surface set`: "`timeline` and `agent-console` panes can be moved into
// their own hardened `BrowserWindow` … An auxiliary window loads the same renderer
// bundle at a window route, carries its own preload and bridge instance, subscribes to
// the daemon itself, and shares no in-memory store and no auth material with the main
// window."
//
// FOUR GATES, IN THIS ORDER, AND EACH ONE REFUSES LOCALLY BEFORE ASKING FOR A
// WINDOW. Asking first and refusing on the answer would mean a window flashes open
// for a route this build cannot render:
//
//   1. **The kind must be an auxiliary route.** `src/shared/auxiliary-routes.ts`
//      closes that set at two; a pane kind outside it has no window route to load.
//   2. **The route must be implemented in THIS build.** `IMPLEMENTED_AUXILIARY_ROUTES`
//      is a build-time fact, and opening a hardened window onto a hash route with
//      nothing behind it is the capability-claimed-but-not-built shape that module
//      exists to prevent.
//   3. **The target must satisfy the route's context grammar.** Built through
//      `formatAuxiliaryFragment`, which is the PRODUCER half of the grammar the
//      auxiliary renderer parses. Composing a fragment by hand here is exactly the
//      drift that module is written to make impossible.
//   4. **A shell must be able to open one.** `window.detachPane` is on the preload
//      contract and `src/main/auxiliary-window-ipc.ts` serves it, so this gate is the
//      plane's own answer and not a standing refusal: a renderer with an Electron main
//      process underneath gets a real `BrowserWindow`, and one without — browser-mode
//      vitest, a window whose preload never ran — gets the typed `shell-absent`
//      refusal. Either way the answer is rendered rather than swallowed, and the body
//      is suppressed only on the arm that opened something.
//
// WHAT THE MAIN WINDOW KEEPS. That same heading says it: "the main window shows the
// moved pane's slot as a placeholder with a focus control" — a slot and no projection,
// which is why `detached` records an id and a window handle rather than a copy of
// anything. The deck keeps the pane at its own width and position and suppresses only
// the body, so the way back is a control in the slot rather than a re-open that would
// land the pane somewhere else.
//
// AND A WINDOW THAT STOPS BEING OPEN COMES BACK THROUGH A SIGNAL, NOT A GUESS —
// EITHER WAY IT STOPS. A crash and a close performed from the window's OWN header are
// both facts this process cannot derive, so both arrive on a subscription.
// `aux-ending-signals.ts` owns that pair — when it opens, when it closes, and why an
// ending has to be listened for BEFORE the first window is asked for. This file holds
// the SETS those reports are written into, and decides the one thing the pair cannot:
// whether anything is still in a window at all.
//
// AND A RETURN IS MATCHED ON THE WINDOW, NOT ONLY THE PANE. A pane that came back can
// be detached again into a second window, so a report about the FIRST arriving late
// would otherwise suppress a body that is currently in the second. The handle recorded
// at detach is what the report is checked against.
//
// AND THE CRASH ITSELF IS KEPT, NOT MERELY REPORTED ONCE. The pane goes back into the
// deck the instant the signal arrives, so a reason held nowhere would be gone by the
// time the deck rendered the slot again. It is stored against the pane id, published
// with every other change, and cleared by exactly two acts: the person dismissing it,
// or the same pane being detached again — which puts its body back in a window and
// makes a note about the last one a note about nothing.

import { Emitter, type Unsubscribe } from "../../core/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  IMPLEMENTED_AUXILIARY_ROUTES,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../../routing/index.js";
import { type PaneKind } from "../../seats/index.js";
import { AuxiliaryEndingSignals } from "./aux-ending-signals.js";
import { type ConsoleAuxiliaryWindowPort } from "./aux-window-signal-watch.js";
import {
  auxiliaryTarget,
  detachRequestFor,
  formatAuxiliaryTargetOrRefuse,
  refuseHandoff,
  settledPlaneCall,
  type AuxiliaryHandoffOutcome,
  type AuxiliaryHandoffRefusal,
  type AuxiliaryHandoffRequest,
  type DetachedPane,
  type LostAuxiliaryWindow,
} from "./aux-handoff-contract.js";

export class AuxiliaryHandoff {
  readonly #auxiliaryWindows: ConsoleAuxiliaryWindowPort;
  readonly #detachedByPaneId = new Map<string, DetachedPane>();
  /**
   * The windows that were lost, by the pane each one had. A SECOND map rather than a
   * flag on the first, because the two hold panes in opposite states: a detached pane's
   * body is elsewhere, and a lost window's pane is back in the deck. One record in both
   * would mean the deck read a member to decide which of the two it was looking at.
   */
  readonly #lostByPaneId = new Map<string, LostAuxiliaryWindow>();
  readonly #changes = new Emitter<readonly DetachedPane[]>("auxiliary hand-off change");
  /**
   * Both window-ending signals, as one collaborator rather than as four more fields.
   * It holds no set of its own: a lost or returned window is recorded HERE, by the
   * same methods a caller would use, so the two arms cannot drift into two spellings
   * of one act.
   */
  readonly #endingSignals: AuxiliaryEndingSignals;
  /**
   * Which routes this build implements, as gate 2 reads them.
   *
   * A CONSTRUCTOR SEAM rather than a direct read of the module constant, and the
   * `Workspace` registry prop beside it is the same shape for the same reason: every
   * route in the closed set is implemented on this build, so gate 2's refusal is
   * unreachable through the public API today and would be covered by nothing until a
   * third route lands unimplemented. Production passes nothing and gets the constant;
   * it holds a LIST rather than a decision, so a test can move the fact without
   * owning a second copy of the rule.
   */
  readonly #implementedRoutes: readonly AuxiliaryRouteName[];

  public constructor(options: {
    readonly auxiliaryWindows: ConsoleAuxiliaryWindowPort;
    readonly implementedRoutes?: readonly AuxiliaryRouteName[];
  }) {
    this.#auxiliaryWindows = options.auxiliaryWindows;
    this.#implementedRoutes = options.implementedRoutes ?? IMPLEMENTED_AUXILIARY_ROUTES;
    this.#endingSignals = new AuxiliaryEndingSignals({
      auxiliaryWindows: options.auxiliaryWindows,
      onWindowLost: (paneId, reason) => {
        this.noteWindowLost(paneId, reason);
      },
      onWindowReturned: (paneId, windowId) => {
        this.noteWindowReturned(paneId, windowId);
      },
      onChanged: () => {
        this.#publish();
      },
    });
  }

  /** Why the crashed-window signal is not being received, where it is not. */
  public get paneErrorRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#endingSignals.lostWindowRefusal;
  }

  /** Why the orderly-return signal is not being received, where it is not. */
  public get paneReturnRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#endingSignals.returnedWindowRefusal;
  }

  /** Every pane currently shown in a window, in detach order. */
  public detached(): readonly DetachedPane[] {
    return [...this.#detachedByPaneId.values()];
  }

  public detachedPane(paneId: string): DetachedPane | undefined {
    return this.#detachedByPaneId.get(paneId);
  }

  /**
   * Every pane whose window was lost and has not been answered, in loss order.
   *
   * Published rather than returned-and-forgotten: the crash is noticed by a
   * subscription and the slot that has to show it renders on a later frame, so a
   * record handed back to the drain loop would reach nobody.
   */
  public lostWindows(): readonly LostAuxiliaryWindow[] {
    return [...this.#lostByPaneId.values()];
  }

  public lostWindow(paneId: string): LostAuxiliaryWindow | undefined {
    return this.#lostByPaneId.get(paneId);
  }

  /**
   * Clear one pane's crash record, because the person has read it. The other way it
   * clears is a fresh {@link detach} of the same pane: a pane whose body has just gone
   * back into a window is not one carrying a note about the last window it was in.
   */
  public dismissLostWindow(paneId: string): void {
    if (this.#lostByPaneId.delete(paneId)) {
      this.#publish();
    }
  }

  public subscribe(listener: (detached: readonly DetachedPane[]) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Whether this build could detach a pane of `kind` at all — gates 1 and 2, without
   * gate 3 or 4. A caller renders an open-in-window control from this and would
   * otherwise have to attempt a detach to find out whether to draw one; the other two
   * gates depend on the target and on the shell, and are answered at the act.
   */
  public canDetach(kind: PaneKind): boolean {
    return isAuxiliaryRouteName(kind) && this.#implementedRoutes.includes(kind);
  }

  /** The label the control uses, or `undefined` where the kind is not detachable. */
  public routeLabel(kind: PaneKind): string | undefined {
    return isAuxiliaryRouteName(kind) ? AUXILIARY_ROUTE_LABELS[kind] : undefined;
  }

  /** Run all four gates and, if they pass, ask for the window. */
  public async detach(request: AuxiliaryHandoffRequest): Promise<AuxiliaryHandoffOutcome> {
    if (!isAuxiliaryRouteName(request.kind)) {
      return {
        outcome: "refused",
        refusal: refuseHandoff(
          "kind-not-detachable",
          "Only a timeline and an agent console can move into a window of their own.",
        ),
      };
    }
    // Bound to its own name because the narrowing gate 1 just made does not survive
    // into the closure below: `request.kind` is a property read, which the checker
    // re-widens inside a function expression, so the plane call would be composing a
    // request against the whole pane-kind set.
    const route: AuxiliaryRouteName = request.kind;
    if (!this.#implementedRoutes.includes(route)) {
      return {
        outcome: "refused",
        refusal: refuseHandoff(
          "route-not-implemented",
          `This build cannot open a ${AUXILIARY_ROUTE_LABELS[route].toLowerCase()} in its own window yet.`,
        ),
      };
    }

    const fragment = formatAuxiliaryTargetOrRefuse(auxiliaryTarget(route, request));
    if (typeof fragment !== "string") {
      return { outcome: "refused", refusal: fragment.refusal };
    }

    // BEFORE THE WINDOW IS ASKED FOR, per `aux-ending-signals.ts`: the shell reports
    // an ending exactly once, and a window that dies between the reply and the deck's
    // next commit would otherwise report it to nobody.
    this.#endingSignals.openWithoutWaiting();

    // THE ROUTE AND ITS CONTEXT TRAVEL, not just the pane id. The shell builds the
    // window's own hash route from them through the same producer half of the grammar
    // gate 3 just ran, so what the window loads is what the deck resolved rather than
    // a second composition of it — and a main process handed only a pane id could not
    // open anything at all. The plane is total over failure, so a shell that rejected
    // lands in the same arm as a build with no shell: without that a rejection left
    // the detach half done — no window, no placeholder, no refusal, and the person's
    // press answered by nothing at all — surfacing only as an unhandled rejection.
    const answer = await settledPlaneCall(() =>
      this.#auxiliaryWindows.detachPane(detachRequestFor(request, route)),
    );
    if (answer.status === "unavailable") {
      // Nothing was opened, so nothing is being watched for: the subscriptions this
      // detach installed would otherwise stand for the window's life, reporting their
      // own refusal in a placeholder no pane has.
      this.#stopWatchingWhenNothingIsDetached();
      return { outcome: "refused", refusal: answer.refusal };
    }

    const detached: DetachedPane = {
      paneId: request.paneId,
      route,
      windowId: answer.value.windowId,
      fragment,
      lostReason: undefined,
    };
    this.#detachedByPaneId.set(request.paneId, detached);
    // The pane is in a window again, so the note about the last window it was in is
    // no longer about anything on screen.
    this.#lostByPaneId.delete(request.paneId);
    this.#publish();
    return { outcome: "detached", detached };
  }

  /** Bring the window to the front. The placeholder's one control. */
  public async focus(paneId: string): Promise<AuxiliaryHandoffRefusal | undefined> {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    const answer = await settledPlaneCall(() =>
      this.#auxiliaryWindows.focusAuxiliary({ windowId: detached.windowId }),
    );
    return answer.status === "unavailable" ? answer.refusal : undefined;
  }

  /**
   * Return the pane to the deck, closing its window.
   *
   * The local record is dropped whether or not the close succeeded. A window this
   * process can no longer reach is a window whose pane must come back — leaving the
   * placeholder up would strand the pane in a window nobody can focus, which is
   * strictly worse than one stray window.
   */
  public async returnToDeck(paneId: string): Promise<AuxiliaryHandoffRefusal | undefined> {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    this.#detachedByPaneId.delete(paneId);
    this.#stopWatchingWhenNothingIsDetached();
    this.#publish();
    const answer = await settledPlaneCall(() =>
      this.#auxiliaryWindows.closeAuxiliary({ windowId: detached.windowId }),
    );
    return answer.status === "unavailable" ? answer.refusal : undefined;
  }

  /**
   * Record that a window was lost rather than closed.
   *
   * The pane returns to the deck — `Spec-023 §The surface set`: "a crashed auxiliary
   * window returns the pane to the deck with the crash noted in the pane's error slot"
   * — and the reason is kept for that slot, because a pane
   * that silently reappears tells the person nothing about why.
   *
   * The record is STORED before the placeholder is removed, and in the same act: a
   * reason returned to the caller and nowhere else is a reason the slot never sees,
   * which is what the second half of that sentence asks for and what this method
   * used to leave undone.
   */
  public noteWindowLost(paneId: string, reason: string): LostAuxiliaryWindow | undefined {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    const lost: LostAuxiliaryWindow = { ...detached, lostReason: reason };
    this.#lostByPaneId.set(paneId, lost);
    this.#detachedByPaneId.delete(paneId);
    this.#stopWatchingWhenNothingIsDetached();
    this.#publish();
    return lost;
  }

  /**
   * Record that a window closed in an orderly way, giving its pane back.
   *
   * NO NOTE IS KEPT, which is the whole difference from {@link noteWindowLost}: the
   * pane came back because somebody asked for it, and a note about that would be a
   * report of a fault where there was none. The body simply stops being suppressed.
   *
   * THE HANDLE IS CHECKED, NOT ONLY THE PANE. A report naming a window this pane is no
   * longer in is ignored: the pane may have been detached again, and restoring it here
   * would put a deck slot back while its body is in a window that is still open. A pane
   * that is not detached at all is the ordinary case for the deck's own {@link
   * returnToDeck}, which drops its record before the close it asked for is even
   * acknowledged — so the report about it arrives to nothing, which is exactly right.
   */
  public noteWindowReturned(paneId: string, windowId: string): DetachedPane | undefined {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined || detached.windowId !== windowId) {
      return undefined;
    }
    this.#detachedByPaneId.delete(paneId);
    this.#stopWatchingWhenNothingIsDetached();
    this.#publish();
    return detached;
  }

  /**
   * Watch both window signals, so a window that stopped being open gives its pane back.
   *
   * Opened by {@link detach} before it asks for the first window; the pair's own
   * module states why that ordering is the whole mechanism. Idempotent, and it
   * resolves when both drains have ENDED rather than when they are installed — so a
   * caller that only needs the installation dispatches it rather than awaiting it.
   *
   * PUBLIC AS THE PAIR TO {@link stopWatchingWindowSignals} and deliberately called
   * from no surface. A reader of the published set decides one commit late in both
   * directions, and that commit is the one an ending can arrive in; the window-lifetime
   * registry does not re-arm through it either, because a hand-off handed back with
   * panes still in windows has never stopped, and a re-arm per read would re-request a
   * refused subscription, publish the refusal, and be read again on that publish.
   */
  public async watchWindowSignals(): Promise<void> {
    await this.#endingSignals.open();
  }

  /** Close both signals. Called when the last pane comes back, and on teardown. */
  public stopWatchingWindowSignals(): void {
    this.#endingSignals.close();
  }

  /**
   * Close both signals once the last pane has come back.
   *
   * Called by every act that can empty the detached set — the deck's own return, a
   * crash, a window that closed itself, and a detach the plane refused. Held HERE
   * rather than by whatever renders the set, because the set is what the condition is
   * about: a reader deciding it acts one commit late in both directions, and the
   * commit it is late by is the one an ending can arrive in.
   */
  #stopWatchingWhenNothingIsDetached(): void {
    if (this.#detachedByPaneId.size === 0) {
      this.stopWatchingWindowSignals();
    }
  }

  #publish(): void {
    this.#changes.emit(this.detached());
  }
}
