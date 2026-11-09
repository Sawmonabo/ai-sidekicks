// The notices the person put away with their ×, held on the open session's entry so a dismissed
// banner stays away however the person leaves the session and comes back. Keyed by the notice's
// event, so a later notice of the same kind, a new crash loop or a new start still on defaults,
// raises its banner again.

/** The dismissed notices of one open session, by event id. */
export class DismissedSessionNotices {
  #eventIds: ReadonlySet<string> = new Set();

  /** The events whose banners the person dismissed: a new set after each dismissal. */
  public get eventIds(): ReadonlySet<string> {
    return this.#eventIds;
  }

  /** Puts the banner `eventId` raised away. */
  public dismiss(eventId: string): void {
    this.#eventIds = new Set(this.#eventIds).add(eventId);
  }
}
