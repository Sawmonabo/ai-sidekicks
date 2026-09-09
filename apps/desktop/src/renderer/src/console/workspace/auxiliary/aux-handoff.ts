// Moving a pane into a window of its own, and bringing it back.
//
// This file is the ACT: the four gates, the plane calls each one guards, and the two
// subscriptions a hand-off opens and closes around them. The RECORDS those acts move —
// pending, detached, lost — live in `aux-handoff-records.ts`, which reaches no wire and
// holds no subscription; and what a hand-off is made of — the refusal vocabulary, the
// value shapes, and the route grammar the third gate runs — lives in
// `aux-handoff-contract.ts`, which holds no state at all.
//
// `Spec-023 §The surface set`: "`timeline` and `agent-console` panes can be moved into
// their own hardened `BrowserWindow` … An auxiliary window loads the same renderer
// bundle at a window route, carries its own preload and bridge instance, subscribes to
// the daemon itself, and shares no in-memory store and no auth material with the main
// window."
//
// FOUR GATES, IN THIS ORDER, AND EACH ONE REFUSES BEFORE THE NEXT IS ASKED. The first
// three are local and are `aux-handoff-contract.ts`' `admitDetachTarget`, which states
// them; the fourth is this file's, and it is the wire:
//
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
// ending has to be listened for BEFORE the first window is asked for; the records
// module owns which record a report is matched against and what it is kept for. What
// is decided HERE is the one thing neither can: whether anything is still held, which
// is what closes the pair.

import { Emitter, type Unsubscribe } from "../../core/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  IMPLEMENTED_AUXILIARY_ROUTES,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../../routing/index.js";
import { type PaneKind } from "../../seats/index.js";
import { AuxiliaryEndingSignals } from "./aux-ending-signals.js";
import { AuxiliaryPaneRecords } from "./aux-handoff-records.js";
import { type ConsoleAuxiliaryWindowPort } from "./aux-window-signal-watch.js";
import {
  admitDetachTarget,
  detachRequestFor,
  settledPlaneCall,
  type AuxiliaryHandoffOutcome,
  type AuxiliaryHandoffRefusal,
  type AuxiliaryHandoffRequest,
  type AuxiliaryHandoffSnapshot,
  type DetachedPane,
  type LostAuxiliaryWindow,
} from "./aux-handoff-contract.js";

export class AuxiliaryHandoff {
  readonly #auxiliaryWindows: ConsoleAuxiliaryWindowPort;
  /**
   * Which panes are pending, detached and lost. A COLLABORATOR rather than three maps
   * here, because those three are one state machine and this class is the acts that
   * move it: a record set beside the plane calls invited a detach to write a pane in
   * while a report about the same pane was being dropped for want of one.
   */
  readonly #records = new AuxiliaryPaneRecords();
  readonly #changes = new Emitter<readonly DetachedPane[]>("auxiliary hand-off change");
  /**
   * The last thing this hand-off published, held so a store read is stable.
   *
   * REBUILT ONLY IN {@link publish}, which is what makes it a snapshot rather than a
   * view: `useSyncExternalStore` compares by identity, so a value composed per read
   * would never settle. The two refusals are captured HERE rather than read live for
   * the same reason, and it changes nothing a surface saw — the projection above has
   * always been rebuilt on a publish and never between two.
   */
  #snapshot: AuxiliaryHandoffSnapshot;
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
      onWindowLost: (paneId, windowId, reason) => {
        this.noteWindowLost(paneId, windowId, reason);
      },
      onWindowReturned: (paneId, windowId) => {
        this.noteWindowReturned(paneId, windowId);
      },
      onChanged: () => {
        this.#publish();
      },
    });
    this.#snapshot = this.#composeSnapshot();
  }

  /**
   * Everything this hand-off publishes, as one value held across a change.
   *
   * The read a React store takes. It is the SAME value the last publish emitted, so a
   * subscriber that re-reads on notification and one that reads before subscribing see
   * one answer rather than two.
   */
  public get snapshot(): AuxiliaryHandoffSnapshot {
    return this.#snapshot;
  }

  /**
   * Why the crashed-window signal is not being received, where it is not.
   *
   * LIVE off the signals rather than off the snapshot, because a stop clears a refusal
   * without publishing — the subscription is gone, so there is nothing left to refuse —
   * and a caller asking this question directly is asking about now.
   */
  public get paneErrorRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#endingSignals.lostWindowRefusal;
  }

  /** Why the orderly-return signal is not being received, where it is not. */
  public get paneReturnRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#endingSignals.returnedWindowRefusal;
  }

  /** Every pane currently shown in a window, in detach order. */
  public detached(): readonly DetachedPane[] {
    return this.#snapshot.detached;
  }

  public detachedPane(paneId: string): DetachedPane | undefined {
    return this.#records.detachedPane(paneId);
  }

  /** Every pane whose window was lost and has not been answered, in loss order. */
  public lostWindows(): readonly LostAuxiliaryWindow[] {
    return this.#snapshot.lostWindows;
  }

  public lostWindow(paneId: string): LostAuxiliaryWindow | undefined {
    return this.#records.lostWindow(paneId);
  }

  /**
   * Clear one pane's crash record, because the person has read it. The other way it
   * clears is a fresh {@link detach} of the same pane: a pane whose body has just gone
   * back into a window is not one carrying a note about the last window it was in.
   */
  public dismissLostWindow(paneId: string): void {
    if (this.#records.dismissLostWindow(paneId)) {
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
    const admitted = admitDetachTarget(request, this.#implementedRoutes);
    if ("refusal" in admitted) {
      return { outcome: "refused", refusal: admitted.refusal };
    }
    const { route, fragment } = admitted;

    // BEFORE THE WINDOW IS ASKED FOR, per `aux-ending-signals.ts`: the shell reports
    // an ending exactly once, and a window that dies between the reply and the deck's
    // next commit would otherwise report it to nobody.
    this.#endingSignals.openWithoutWaiting();
    // AND BEFORE IT TOO, THE RECORD THAT ENDING LANDS IN. Listening is not enough on its
    // own: both ending handlers match a report against a record, and the only record
    // this hand-off used to write was the one the fulfillment below makes — so a window
    // that ended while the reply was in flight was heard and then dropped, and the
    // fulfillment filed a detached pane for a window that was already gone.
    this.#records.beginDetach(request.paneId);

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
      // Nothing was opened, so the record that would have caught a report about it goes
      // too — and nothing is being watched for: the subscriptions this detach installed
      // would otherwise stand for the window's life, reporting their own refusal in a
      // placeholder no pane has.
      this.#records.abandonDetach(request.paneId);
      this.#stopWatchingWhileNothingIsHeld();
      return { outcome: "refused", refusal: answer.refusal };
    }

    const detached: DetachedPane = {
      paneId: request.paneId,
      route,
      windowId: answer.value.windowId,
      fragment,
      lostReason: undefined,
    };
    // The records decide which settlement this is, because they hold whatever the shell
    // reported about this window while the reply was in flight.
    const ending = this.#records.settleDetach(detached);
    this.#publish();
    if (ending === undefined) {
      return { outcome: "detached", detached };
    }
    // The window is already gone, so the pane is in the deck rather than behind a
    // placeholder — and there is nothing left in a window to keep the signals open for.
    this.#stopWatchingWhileNothingIsHeld();
    return { outcome: "window-ended", ending };
  }

  /** Bring the window to the front. The placeholder's one control. */
  public async focus(paneId: string): Promise<AuxiliaryHandoffRefusal | undefined> {
    const detached = this.#records.detachedPane(paneId);
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
    const detached = this.#records.removeDetached(paneId);
    if (detached === undefined) {
      return undefined;
    }
    this.#stopWatchingWhileNothingIsHeld();
    this.#publish();
    const answer = await settledPlaneCall(() =>
      this.#auxiliaryWindows.closeAuxiliary({ windowId: detached.windowId }),
    );
    return answer.status === "unavailable" ? answer.refusal : undefined;
  }

  /**
   * A window was lost rather than closed — the pane comes back, carrying why.
   *
   * The recording itself is `aux-handoff-records.ts`'; what this method adds is the two
   * consequences only a hand-off can draw: the signals close once nothing is held, and
   * subscribers hear about it. Matched on the window as well as the pane, per this
   * file's header — and this report used to carry no window to match on.
   */
  public noteWindowLost(
    paneId: string,
    windowId: string,
    reason: string,
  ): LostAuxiliaryWindow | undefined {
    const lost = this.#records.noteWindowLost(paneId, windowId, reason);
    if (lost === undefined) {
      // Either buffered against a detach still in flight or about no window this
      // hand-off holds. Nothing anybody can see moved, so nothing is published.
      return undefined;
    }
    this.#stopWatchingWhileNothingIsHeld();
    this.#publish();
    return lost;
  }

  /**
   * A window closed in an orderly way, giving its pane back.
   *
   * NO NOTE IS KEPT, which is the whole difference from {@link noteWindowLost}: the
   * pane came back because somebody asked for it, and a note about that would be a
   * report of a fault where there was none. The body simply stops being suppressed.
   *
   * A pane that is not detached at all is the ordinary case for the deck's own
   * {@link returnToDeck}, which drops its record before the close it asked for is even
   * acknowledged — so the report about it arrives to nothing, which is exactly right.
   */
  public noteWindowReturned(paneId: string, windowId: string): DetachedPane | undefined {
    const returned = this.#records.noteWindowReturned(paneId, windowId);
    if (returned === undefined) {
      return undefined;
    }
    this.#stopWatchingWhileNothingIsHeld();
    this.#publish();
    return returned;
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
   * Close both signals once nothing is in a window and nothing is on its way into one.
   *
   * Called by every act that can empty the records — the deck's own return, a crash, a
   * window that closed itself, and a detach the plane refused. Held HERE rather than by
   * whatever renders the set, because the set is what the condition is about: a reader
   * deciding it acts one commit late in both directions, and the commit it is late by
   * is the one an ending can arrive in.
   *
   * A DETACH IN FLIGHT KEEPS THEM OPEN, which is the half the detached set alone could
   * not say: closing the signals while the shell is opening a window would drop the
   * ending for the very window this hand-off is waiting on.
   */
  #stopWatchingWhileNothingIsHeld(): void {
    if (this.#records.isIdle) {
      this.stopWatchingWindowSignals();
    }
  }

  #publish(): void {
    this.#snapshot = this.#composeSnapshot();
    this.#changes.emit(this.#snapshot.detached);
  }

  #composeSnapshot(): AuxiliaryHandoffSnapshot {
    return {
      detached: this.#records.detached,
      lostWindows: this.#records.lostWindows,
      paneErrorRefusal: this.#endingSignals.lostWindowRefusal,
      paneReturnRefusal: this.#endingSignals.returnedWindowRefusal,
    };
  }
}
