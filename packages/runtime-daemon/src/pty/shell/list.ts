// Who follows one session's shell list, and the sending of it. Each list is the whole list, read
// once every holder in it has settled: every follower gets it after a change, and a follower that
// just joined gets its first one without the others getting anything for the joining. What comes
// while a list is being read makes one more read, never two at once.

import type { PtyListUpdate } from "@ai-sidekicks/contracts/pty";

type ShellListListener = (update: PtyListUpdate) => void;

/** The followers of one session's shell list. */
export class ShellListFollowers {
  readonly #readList: () => Promise<PtyListUpdate>;
  readonly #reportFailure: (work: Promise<void>) => void;
  readonly #listeners = new Set<ShellListListener>();
  // Followers that joined since the list was last sent and have not had their first one yet.
  readonly #awaitingFirst = new Set<ShellListListener>();
  #isStale = false;
  #isSending = false;

  /** `readList` reads the whole list; a send that fails is handed to `reportFailure`. */
  constructor(
    readList: () => Promise<PtyListUpdate>,
    reportFailure: (work: Promise<void>) => void,
  ) {
    this.#readList = readList;
    this.#reportFailure = reportFailure;
  }

  /** How many follow the list. */
  get followerCount(): number {
    return this.#listeners.size;
  }

  /** Sends `listener` the whole list now and after every change, until the returned call. */
  follow(listener: ShellListListener): () => void {
    this.#listeners.add(listener);
    this.#awaitingFirst.add(listener);
    this.#send();
    return () => {
      this.#listeners.delete(listener);
      this.#awaitingFirst.delete(listener);
    };
  }

  /** Marks the list changed and sends it to every follower. */
  markChanged(): void {
    this.#isStale = true;
    this.#send();
  }

  #send(): void {
    if (this.#isSending) {
      return;
    }
    this.#isSending = true;
    const sending = (async () => {
      try {
        while (this.#isStale || this.#awaitingFirst.size > 0) {
          const isChanged = this.#isStale;
          this.#isStale = false;
          const update = await this.#readList();
          const recipients = isChanged ? [...this.#listeners] : [...this.#awaitingFirst];
          for (const listener of recipients) {
            this.#awaitingFirst.delete(listener);
            listener(update);
          }
        }
      } finally {
        this.#isSending = false;
      }
    })();
    this.#reportFailure(sending);
  }
}
