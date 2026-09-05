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
//   4. **The wire must exist.** It does not: `window.detachPane` is on
//      `Plan-023 §Console growth slate` and reaches the console only through the
//      growth port, which refuses by name. That refusal is rendered, not swallowed.
//
// WHAT THE MAIN WINDOW KEEPS. That same heading says it: "the main window shows the
// moved pane's slot as a placeholder with a focus control" — a slot and no projection,
// which is why `detached` records an id and a window handle rather than a copy of
// anything. The deck keeps the pane at its
// own width and position; only the body is suppressed, so the way back is a control
// in the slot rather than a re-open that would land the pane somewhere else.
//
// AND A CRASHED WINDOW COMES BACK THROUGH A SIGNAL, NOT A GUESS. The same heading's
// "a crashed auxiliary window returns the pane to the deck with the crash noted in the
// pane's error slot" needs something to notice the crash, and
// the growth registry carries exactly one: a window pane-error subscription whose
// value is a pane id and a reason — the pair `noteWindowLost` already takes. It is
// watched only while something is detached, because a subscription held over an
// empty detached set can report nothing and its refusal would be a permanent notice
// about a hazard the window does not currently have. A refused subscription is
// rendered in the placeholder it belongs to: it does not mean "no crashes".
//
// AND THE CRASH ITSELF IS KEPT, NOT MERELY REPORTED ONCE. The pane goes back into
// the deck the instant the signal arrives, so a reason handed to the caller of
// `noteWindowLost` and held nowhere would be gone by the time the deck rendered the
// slot again. The reason is therefore stored against the pane id, published with
// every other change, and cleared by exactly two acts: the person dismissing it, or
// the same pane being detached again — which puts its body back in a window and
// makes a note about the last one a note about nothing.

import { Emitter, type Unsubscribe } from "../core/index.js";
import { GenerationLatch } from "../store/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  IMPLEMENTED_AUXILIARY_ROUTES,
  isAuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";
import { type PaneKind } from "../seats/index.js";
import { lossyStringify } from "../../../../shared/wire-errors.js";
import {
  auxiliaryTarget,
  formatAuxiliaryTargetOrRefuse,
  refuseHandoff,
  type AuxiliaryHandoffOutcome,
  type AuxiliaryHandoffRefusal,
  type AuxiliaryHandoffRequest,
  type DetachedPane,
  type LostAuxiliaryWindow,
} from "./aux-handoff-contract.js";

/**
 * The growth port, reached as the bridge's own member rather than by importing the
 * port type.
 *
 * `bridge/index.ts` exports the bridge and not the port, deliberately — the port is
 * reached THROUGH a bridge and never held on its own — so this alias takes the type
 * off the door that is open rather than asking for a second one.
 */
type ConsoleGrowthPort = ConsoleBridge["growth"];

/**
 * The served value of the pane-error subscription, taken off the port for the same
 * reason `ConsoleGrowthPort` is: the bridge door exports the bridge and not the
 * stream shape, and a second import for a type the open door already carries would
 * be a second name for one wire fact.
 */
type PaneErrorSignal = Extract<
  Awaited<ReturnType<ConsoleGrowthPort["windowSubscribePaneErrors"]>>,
  { readonly status: "served" }
>["value"];

/**
 * The one key the pane-error watch is claimed under.
 *
 * There is exactly one signal per hand-off, so one key: the latch's subject is the
 * hand-off itself and the register never holds more than this.
 */
const PANE_ERROR_WATCH_KEY = "pane-error-watch";

export class AuxiliaryHandoff {
  readonly #growth: ConsoleGrowthPort;
  readonly #detachedByPaneId = new Map<string, DetachedPane>();
  /**
   * The windows that were lost, by the pane each one had.
   *
   * A SECOND map rather than a flag on the first, because the two hold panes in
   * opposite states: a detached pane's body is elsewhere, and a lost window's pane
   * is back in the deck. Keeping one record in both would mean the deck had to read
   * a member to decide which of the two it was looking at.
   */
  readonly #lostByPaneId = new Map<string, LostAuxiliaryWindow>();
  readonly #changes = new Emitter<readonly DetachedPane[]>("auxiliary hand-off change");
  #paneErrorStream: PaneErrorSignal | undefined;
  #paneErrorRefusal: AuxiliaryHandoffRefusal | undefined;
  /**
   * Whether a start for the pane-error watch is in flight, and which round it is.
   *
   * THE SUBSTRATE'S REGISTER RATHER THAN A COUNTER PAIR. This used to be a watch
   * generation beside the generation a start was pending for, compared as
   * `#pendingStartGeneration === #paneErrorWatchGeneration`; the latch says that
   * once — a taken key IS a start in flight, and a superseded key IS a start whose
   * settlement installs nothing. A boolean captured per call could not be reached
   * from the stop that has to invalidate it, which is why the pair existed at all,
   * and the latch keeps that property without the arithmetic.
   */
  readonly #paneErrorWatch = new GenerationLatch();

  public constructor(options: { readonly growth: ConsoleGrowthPort }) {
    this.#growth = options.growth;
  }

  /**
   * Why the crashed-window signal is not being received, where it is not.
   *
   * Rendered in the placeholder rather than swallowed: a subscription this build
   * cannot open is not the same fact as a window that has not crashed, and a slot
   * that showed nothing would be claiming the second.
   */
  public get paneErrorRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#paneErrorRefusal;
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
   * Clear one pane's crash record, because the person has read it.
   *
   * The other way it clears is a fresh {@link detach} of the same pane: a pane whose
   * body has just gone back into a window is not a pane carrying a note about the
   * last window it was in.
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
   * Whether this build could detach a pane of `kind` at all.
   *
   * Gates 1 and 2, without gate 3 or 4: a caller renders an open-in-window control
   * from this and would otherwise have to attempt a detach to find out whether to
   * draw one. Gates 3 and 4 depend on the target and on the daemon, and both are
   * answered at the moment of the act.
   */
  public canDetach(kind: PaneKind): boolean {
    return isAuxiliaryRouteName(kind) && IMPLEMENTED_AUXILIARY_ROUTES.includes(kind);
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
    if (!IMPLEMENTED_AUXILIARY_ROUTES.includes(request.kind)) {
      return {
        outcome: "refused",
        refusal: refuseHandoff(
          "route-not-implemented",
          `This build cannot open a ${AUXILIARY_ROUTE_LABELS[request.kind].toLowerCase()} in its own window yet.`,
        ),
      };
    }

    const fragment = formatAuxiliaryTargetOrRefuse(auxiliaryTarget(request.kind, request));
    if (typeof fragment !== "string") {
      return { outcome: "refused", refusal: fragment.refusal };
    }

    const answer = await this.#growth.windowDetachPane({ paneId: request.paneId });
    if (answer.status === "unavailable") {
      return { outcome: "refused", refusal: refuseHandoff("wire-unregistered", answer.detail) };
    }

    const detached: DetachedPane = {
      paneId: request.paneId,
      route: request.kind,
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
    const answer = await this.#growth.windowFocusAuxiliary({ windowId: detached.windowId });
    return answer.status === "unavailable"
      ? refuseHandoff("wire-unregistered", answer.detail)
      : undefined;
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
    this.#publish();
    const answer = await this.#growth.windowCloseAuxiliary({ windowId: detached.windowId });
    return answer.status === "unavailable"
      ? refuseHandoff("wire-unregistered", answer.detail)
      : undefined;
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
    this.#publish();
    return lost;
  }

  /**
   * Watch the pane-error signal, so a window that crashed returns its pane.
   *
   * Idempotent across BOTH states a watch can be in, which is the half this used to
   * miss. A second call while a stream is open is a no-op, because the deck detaching
   * a second pane must not open a second subscription to the same signal — and a
   * second call while the FIRST request is still in flight is a no-op for exactly the
   * same reason, which a guard reading only the installed stream cannot say.
   *
   * AND A REQUEST THAT OUTLIVES ITS WATCH INSTALLS NOTHING. The subscription is
   * asked for over a process boundary, so the last pane can come back while the
   * request is in flight; without the generation the response then installed a
   * stream and drained it for a window with nothing detached, which is the
   * permanent-notice-about-a-hazard-the-window-does-not-have shape this file's header
   * rules out. A stale response closes what it opened and installs nothing.
   */
  public async watchPaneErrors(): Promise<void> {
    if (this.#paneErrorStream !== undefined) {
      return;
    }
    const claim = this.#paneErrorWatch.claim(this, PANE_ERROR_WATCH_KEY);
    if (claim === undefined) {
      return;
    }

    const answer = await this.#growth.windowSubscribePaneErrors({});
    let installed = false;
    claim.settle(() => {
      installed = true;
    });
    // Released whether or not the settlement ran: a claim superseded by a stop no
    // longer owns the key, so this cannot take back a watch a later detach started,
    // and a claim that did settle has to free the key or no later detach could
    // start one at all.
    claim.release();
    if (!installed) {
      // Stopped while this was in flight, so the stream this reply carries is one
      // nothing will ever drain.
      if (answer.status === "served") {
        answer.value.close();
      }
      return;
    }

    if (answer.status === "unavailable") {
      this.#paneErrorRefusal = refuseHandoff("wire-unregistered", answer.detail);
      this.#publish();
      return;
    }
    this.#paneErrorRefusal = undefined;
    this.#paneErrorStream = answer.value;
    await this.#drainPaneErrors(answer.value);
  }

  /**
   * Close the signal. Called when the last pane comes back, and on teardown.
   *
   * The round is superseded FIRST, so a request still in flight is invalidated by
   * the same act that closes an installed stream — a stop that reached only what was
   * installed left the pending one to arrive afterwards and re-open the watch it had
   * just closed. Superseding also frees the key, so a detach arriving right behind
   * this stop starts a new subscription rather than being turned away into no watch
   * at all.
   */
  public stopWatchingPaneErrors(): void {
    this.#paneErrorWatch.supersede(this, PANE_ERROR_WATCH_KEY);
    this.#paneErrorStream?.close();
    this.#paneErrorStream = undefined;
    this.#paneErrorRefusal = undefined;
  }

  async #drainPaneErrors(stream: PaneErrorSignal): Promise<void> {
    try {
      for await (const paneError of stream.events) {
        this.noteWindowLost(paneError.paneId, paneError.reason);
      }
    } catch (error) {
      // A signal that ended in a failure is not a signal that reported no crashes,
      // so the placeholder says so rather than the stream ending in silence.
      this.#paneErrorRefusal = refuseHandoff(
        "wire-unregistered",
        `The signal that reports a lost window stopped: ${describeStreamFailure(error)}`,
      );
    }
    if (this.#paneErrorStream === stream) {
      this.#paneErrorStream = undefined;
    }
    this.#publish();
  }

  #publish(): void {
    this.#changes.emit(this.detached());
  }
}

/**
 * An unknown thrown value as one sentence, without inventing a shape for it.
 *
 * `lossyStringify` rather than `String`: a caught value may be a revoked proxy, a
 * null-prototype object, or a `toString` that throws, and `String` on any of those
 * throws out of the very handler written to keep a failed signal from escaping.
 */
function describeStreamFailure(error: unknown): string {
  return error instanceof Error ? error.message : lossyStringify(error);
}
