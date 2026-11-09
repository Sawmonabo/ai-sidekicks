// The notices the person put away with their ×, per session, held by the screen across the
// sessions it shows: a dismissed banner stays away when the person leaves its session and comes
// back. Keyed by the notice's event, so a later notice of the same kind, a new crash loop or a new
// start still on defaults, raises its banner again.

/** The dismissed notices of each session the screen has shown, by event id. */
export class DismissedSessionNotices {
  readonly #eventIdsBySession = new Map<string, ReadonlySet<string>>();

  /**
   * The events whose banners the person dismissed in `sessionId`, `undefined` before the first: a
   * new set after each dismissal, so a reader keyed on it folds again.
   */
  public dismissedIn(sessionId: string): ReadonlySet<string> | undefined {
    return this.#eventIdsBySession.get(sessionId);
  }

  /** Puts the banner `eventId` raised in `sessionId` away. */
  public dismiss(sessionId: string, eventId: string): void {
    this.#eventIdsBySession.set(sessionId, new Set(this.dismissedIn(sessionId)).add(eventId));
  }
}
