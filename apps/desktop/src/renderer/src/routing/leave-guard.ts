// The one seam a screen holding unsaved edits uses to be asked before the window leaves it. The
// window's route writer sends every move through it, so a rail press, a palette act or chord, an
// address change and Back all wait on the same answer. It asks nothing of its own: the screen's
// ask puts the question in its own words.

import type { AppRoute } from "./routes.js";

/**
 * What a screen holding unsaved edits registers: its ask, resolving `true` to leave and drop the
 * edits or `false` to stay with them, and which routes it stays mounted on with those edits (another
 * file of the same skill folder), so a move between them asks nothing.
 */
export interface LeaveGuardRegistration {
  readonly ask: () => Promise<boolean>;
  readonly isStayingOn: (route: AppRoute) => boolean;
}

/**
 * One window's leave guard: at most one screen's ask registered, and at most one ask in flight.
 * With nothing registered every move commits at once.
 */
export class LeaveGuard {
  readonly #reportAskFailure: (failure: unknown) => void;
  #registration: LeaveGuardRegistration | undefined;
  #isAsking = false;

  /** `reportAskFailure` hears an ask that rejected; the window stays where it was. */
  public constructor(reportAskFailure: (failure: unknown) => void) {
    this.#reportAskFailure = reportAskFailure;
  }

  /**
   * Register the mounted screen's guard and return the call that removes it. A screen registers
   * while its edits are unsaved and unregisters once they are saved or discarded or it unmounts;
   * a second registration while one stands throws.
   */
  public register(registration: LeaveGuardRegistration): () => void {
    if (this.#registration !== undefined) {
      throw new Error("a leave guard is already registered in this window");
    }
    this.#registration = registration;
    return () => {
      // Identity, so a late unregister never drops a registration made after it.
      if (this.#registration === registration) {
        this.#registration = undefined;
      }
    };
  }

  /**
   * Move to `to`, returning whether `commit` ran now: at once when no screen is registered or the
   * registered one stays on `to`, after a yes otherwise, never on a no, and never for a move made
   * while an ask is in flight, which is dropped.
   */
  public leave(to: AppRoute, commit: () => void): boolean {
    if (this.#isAsking) {
      return false;
    }
    const registration = this.#registration;
    if (registration === undefined || registration.isStayingOn(to)) {
      commit();
      return true;
    }
    // Called before the flag is raised, so an ask that throws as it is called reaches the mover
    // and leaves no ask in flight.
    const answer = registration.ask();
    this.#isAsking = true;
    void answer.then(
      (isLeaving) => {
        this.#isAsking = false;
        if (isLeaving) {
          commit();
        }
      },
      (failure: unknown) => {
        this.#isAsking = false;
        this.#reportAskFailure(failure);
      },
    );
    return false;
  }
}
