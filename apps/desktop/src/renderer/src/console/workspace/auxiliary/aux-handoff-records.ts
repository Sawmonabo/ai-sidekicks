// Which panes are in windows, which windows were lost, and which detach is in flight.
//
// SPLIT FROM `aux-handoff.ts`, WHICH PERFORMS A HAND-OFF. That file runs the four
// gates, calls the plane, and owns the window signals' lifetime; this one is the state
// those acts move, and it reaches no wire and holds no subscription — so every rule
// below can be driven without a shell. It is the third piece of the same subsystem,
// beside `aux-handoff-contract.ts`, which holds the value shapes and no state at all.
//
// THE ONE IDEA HERE: A DETACH HAS THREE STATES AND NOT TWO, and the third is what the
// records exist to make representable. A pane is
//
//   • PENDING — the gates passed and the shell has been asked for a window. Nothing is
//     on screen yet: the deck still draws the pane's body, because as far as anything
//     above is concerned nothing has happened.
//   • DETACHED — the shell answered with a window, and the deck draws a placeholder.
//   • LOST — a window that was open stopped being open, so the pane is back in the deck
//     carrying a note about why.
//
// AND THE PENDING STATE IS THE ONE AN ENDING CAN ARRIVE IN. The shell creates the
// window and then answers, so a window can crash — or be closed from its own header —
// between those two moments. Both ending handlers used to require a DETACHED record,
// which the hand-off only wrote at fulfillment, so a report in that gap was discarded
// and the fulfillment then filed a detached pane for a window that was already gone:
// a placeholder over nothing, with the crash noted nowhere and no control to clear it.
//
// AND THE CRASH ITSELF IS KEPT, NOT MERELY REPORTED ONCE. The pane goes back into the
// deck the instant the signal arrives, so a reason held nowhere would be gone by the
// time the deck rendered the slot again. It is stored against the pane id, published
// with every other change, and cleared by exactly two acts: the person dismissing it,
// or the same pane going back into a window — which makes a note about the last one a
// note about nothing.
//
// AND AN ENDING IS MATCHED ON THE WINDOW, NOT ONLY THE PANE. Two things make the pane
// id alone ambiguous: a pane that came back can be detached again, so a late report
// about the FIRST window would suppress a body now in the second; and one renderer
// holds every session's hand-off while every deck mints its own `pane-1`, so a report
// named by the pane alone reaches sessions that had nothing to do with it.
//
// SO AN ENDING THAT LANDS ON A PENDING RECORD IS BUFFERED UNDER THE WINDOW IT NAMES,
// and the settlement reads it. Under the WINDOW rather than under the pane, because
// that is the same rule the detached arm has always enforced: one renderer holds every
// session's hand-off and every deck mints its own `pane-1`, and a pane that came back
// can be detached again — so a report named by the pane alone would let a stale ending
// about one window close a record about another. Matching the buffered ending against
// the window the plane actually returned keeps the settlement exact, and every other
// buffered report is dropped with the pending record, exactly as stale as it was.

import {
  type AuxiliaryWindowEnding,
  type DetachedPane,
  type LostAuxiliaryWindow,
} from "./aux-handoff-contract.js";

/**
 * The three record sets one hand-off holds, and the acts that move a pane between them.
 *
 * THE PUBLISHED ARRAYS ARE HELD RATHER THAN COMPOSED PER READ, because the hand-off
 * publishes a snapshot a React store reads by identity: a getter that spread a `Map`
 * on every call would hand `useSyncExternalStore` a new value every time it asked and
 * loop the render it is supposed to settle.
 */
export class AuxiliaryPaneRecords {
  readonly #detachedByPaneId = new Map<string, DetachedPane>();
  /**
   * The windows that were lost, by the pane each one had. A SECOND map rather than a
   * flag on the first, because the two hold panes in opposite states: a detached pane's
   * body is elsewhere, and a lost window's pane is back in the deck. One record in both
   * would mean the deck read a member to decide which of the two it was looking at.
   */
  readonly #lostByPaneId = new Map<string, LostAuxiliaryWindow>();
  /**
   * One entry per detach in flight, holding whatever endings arrived while it was.
   *
   * BOUNDED BY THE CALL IT BELONGS TO: the entry is minted when the plane is asked and
   * dropped the moment it answers, and only a report naming this pane can write into
   * it, so the map inside one entry holds at most the windows this pane's shell ended
   * during a single round trip.
   */
  readonly #endingsByPendingPaneId = new Map<string, Map<string, AuxiliaryWindowEnding>>();
  #detached: readonly DetachedPane[] = [];
  #lostWindows: readonly LostAuxiliaryWindow[] = [];

  /** Every pane currently shown in a window, in detach order. */
  public get detached(): readonly DetachedPane[] {
    return this.#detached;
  }

  /**
   * Every pane whose window was lost and has not been answered, in loss order.
   *
   * Held rather than handed back once: the crash is noticed by a subscription and the
   * slot that has to show it renders on a later frame, so a record given only to the
   * drain loop would reach nobody.
   */
  public get lostWindows(): readonly LostAuxiliaryWindow[] {
    return this.#lostWindows;
  }

  /**
   * Whether nothing is in a window and nothing is on its way into one.
   *
   * THE PENDING SET COUNTS, which is what the detached set alone could not say: the
   * window signals are closed on this reading, and closing them while a detach is in
   * flight would drop the ending for the very window that detach is opening.
   */
  public get isIdle(): boolean {
    return this.#detachedByPaneId.size === 0 && this.#endingsByPendingPaneId.size === 0;
  }

  public detachedPane(paneId: string): DetachedPane | undefined {
    return this.#detachedByPaneId.get(paneId);
  }

  public lostWindow(paneId: string): LostAuxiliaryWindow | undefined {
    return this.#lostByPaneId.get(paneId);
  }

  /**
   * A detach is in flight for this pane — open the record its endings land in.
   *
   * Called BEFORE the shell is asked for a window, which is the whole mechanism: a
   * record opened after the answer could not hold a report that arrived before it.
   * A second detach of the same pane replaces the entry rather than joining it: the
   * endings buffered for the first call are about windows the second is not opening.
   */
  public beginDetach(paneId: string): void {
    this.#endingsByPendingPaneId.set(paneId, new Map());
  }

  /** The detach opened nothing, so its record is dropped rather than left standing. */
  public abandonDetach(paneId: string): void {
    this.#endingsByPendingPaneId.delete(paneId);
  }

  /**
   * The shell answered with a window. Record the pane as detached, or as already gone.
   *
   * Answers WHICH of the two happened, so the caller can tell a hand-off that put a
   * pane in a window from one whose window ended before it heard about it — and never
   * reports a detached pane for a window that is not open.
   */
  public settleDetach(detached: DetachedPane): AuxiliaryWindowEnding | undefined {
    const ending = this.#endingsByPendingPaneId.get(detached.paneId)?.get(detached.windowId);
    this.#endingsByPendingPaneId.delete(detached.paneId);
    if (ending === undefined) {
      this.#detachedByPaneId.set(detached.paneId, detached);
    }
    if (ending?.ending === "lost") {
      this.#lostByPaneId.set(detached.paneId, { ...detached, lostReason: ending.reason });
    } else {
      // The pane went into a window, so a note about the LAST window it was in is a note
      // about nothing — whether it is still in this one or came straight back out of it.
      this.#lostByPaneId.delete(detached.paneId);
    }
    this.#refresh();
    return ending;
  }

  /**
   * Record that a window was lost rather than closed.
   *
   * The pane returns to the deck — a crashed auxiliary window returns its pane with
   * the crash noted in the pane's error slot — and the reason is STORED for that slot
   * in the same act, because a reason handed back to the caller and nowhere else is
   * one the slot never sees, and a pane that reappears in silence tells the person
   * nothing about why.
   */
  public noteWindowLost(
    paneId: string,
    windowId: string,
    reason: string,
  ): LostAuxiliaryWindow | undefined {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined || detached.windowId !== windowId) {
      this.#bufferEnding(paneId, windowId, { ending: "lost", reason });
      return undefined;
    }
    const lost: LostAuxiliaryWindow = { ...detached, lostReason: reason };
    this.#lostByPaneId.set(paneId, lost);
    this.#detachedByPaneId.delete(paneId);
    this.#refresh();
    return lost;
  }

  /**
   * Record that a window closed in an orderly way, giving its pane back.
   *
   * NO NOTE IS KEPT, which is the whole difference from {@link noteWindowLost}: the
   * pane came back because somebody asked for it, and a note about that would be a
   * report of a fault where there was none. The body simply stops being suppressed.
   */
  public noteWindowReturned(paneId: string, windowId: string): DetachedPane | undefined {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined || detached.windowId !== windowId) {
      this.#bufferEnding(paneId, windowId, { ending: "returned" });
      return undefined;
    }
    this.#detachedByPaneId.delete(paneId);
    this.#refresh();
    return detached;
  }

  /** Clear one pane's crash record, because the person has read it. */
  public dismissLostWindow(paneId: string): boolean {
    if (!this.#lostByPaneId.delete(paneId)) {
      return false;
    }
    this.#refresh();
    return true;
  }

  /** Take a pane out of its window's record, for the deck's own return. */
  public removeDetached(paneId: string): DetachedPane | undefined {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    this.#detachedByPaneId.delete(paneId);
    this.#refresh();
    return detached;
  }

  /**
   * Hold an ending a detach in flight may be about, and drop every other one.
   *
   * The optional call is the rule rather than a convenience: with no detach in flight
   * for this pane there is nothing the report can be about, and it is exactly as stale
   * as it was before this record existed.
   */
  #bufferEnding(paneId: string, windowId: string, ending: AuxiliaryWindowEnding): void {
    this.#endingsByPendingPaneId.get(paneId)?.set(windowId, ending);
  }

  #refresh(): void {
    this.#detached = [...this.#detachedByPaneId.values()];
    this.#lostWindows = [...this.#lostByPaneId.values()];
  }
}
