// The one seam a screen holding unsaved edits uses to be asked before the window leaves it. The
// window's route writer sends every move through it, so a rail press, a palette act or chord, an
// address change and Back all wait on the same answer. It asks nothing of its own: the screen's
// ask puts the question in its own words.

import type { AppRoute } from "./routes.js";

/**
 * What a screen holding unsaved edits registers: its ask, resolving `true` to leave and drop the
 * edits or `false` to stay with them, and which routes it stays mounted on with those edits
 * (another file of the same skill folder), so a move between them asks nothing.
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
  // The registration whose ask is in flight; cleared by its answer or its removal.
  #askingRegistration: LeaveGuardRegistration | undefined;

  /** `reportAskFailure` hears an ask that threw or rejected; the window stays where it was. */
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
      if (this.#askingRegistration === registration) {
        this.#askingRegistration = undefined;
      }
    };
  }

  /**
   * Move to `to`, returning whether `commit` ran now: at once when no screen is registered or the
   * registered one stays on `to`, after a yes otherwise, never on a no, never for a move made
   * while an ask is in flight, which is dropped, and never once the asking screen unregistered.
   */
  public leave(to: AppRoute, commit: () => void): boolean {
    if (this.#askingRegistration !== undefined) {
      return false;
    }
    const registration = this.#registration;
    if (registration === undefined || registration.isStayingOn(to)) {
      commit();
      return true;
    }
    let answer: Promise<boolean>;
    try {
      answer = registration.ask();
    } catch (failure: unknown) {
      this.#reportAskFailure(failure);
      return false;
    }
    this.#askingRegistration = registration;
    void answer.then(
      (isLeaving) => {
        if (this.#settleAsk(registration) && isLeaving) {
          commit();
        }
      },
      (failure: unknown) => {
        this.#settleAsk(registration);
        this.#reportAskFailure(failure);
      },
    );
    return false;
  }

  /** End the ask in flight if it is `registration`'s; false for an answer from a removed one. */
  #settleAsk(registration: LeaveGuardRegistration): boolean {
    if (this.#askingRegistration !== registration) {
      return false;
    }
    this.#askingRegistration = undefined;
    return true;
  }
}
