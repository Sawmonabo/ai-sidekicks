// The messages this window sent into one session, from the press until the transcript lets them
// go, and the sends that failed. A message is in the transcript from the press, under the key its
// send carries, and keeps that key once the service has it, so its row never mounts twice; a
// failed send's row leaves and one line saying why stands where it stood, for the store's life. A
// sent message is let go once no row in the store's window reads its key. Held with the session
// store, so a transcript mounted again draws them as they were, and none is written anywhere.

import { Emitter } from "#renderer/lib/emitter.js";

/** One message sent from this window: its words, and the item the service queued. */
export interface SentMessage {
  readonly kind: "sent";
  /** The send's own key, which its transcript row is drawn under from the press on. */
  readonly key: string;
  readonly content: string;
  /** When Send was pressed, as an ISO-8601 instant. */
  readonly sentAt: string;
  /** The queue item the service answered with; absent until it answers. */
  readonly queueItemId?: string;
  /**
   * The waiting item an edit of this row replaces, whose place the row keeps until the reading
   * reads the item that replaced it.
   */
  readonly editOf?: string;
}

/** A send that failed: the line standing where its row stood. */
export interface FailedSend {
  readonly kind: "failed";
  /** The failed send's own key, which the line is drawn under. */
  readonly key: string;
  /** The line's words: `Send failed · <cause>`. */
  readonly label: string;
  /** When the send failed, as an ISO-8601 instant. */
  readonly failedAt: string;
  /** The newest event of the session's log when the send failed, which the line stands after. */
  readonly afterEventId: string | undefined;
}

/** What one session's store holds of this window's sends, in the order they were pressed. */
export type SentMessageEntry = SentMessage | FailedSend;

/** One session's sent messages and failed sends, published to the transcript that draws them. */
export class SentMessages {
  readonly #changes = new Emitter<void>("sent messages");
  #entries: readonly SentMessageEntry[] = [];

  /** The entries as they stand, one array between changes. */
  public snapshot = (): readonly SentMessageEntry[] => this.#entries;

  /** Watch the entries. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  /** A message left at the press: it is drawn under `message.key` from now on. */
  public press(message: Omit<SentMessage, "kind" | "queueItemId">): void {
    this.#publish([...this.#entries, { kind: "sent", ...message }]);
  }

  /** The service has the message pressed under `key`, as the queue item `queueItemId`. */
  public settle(key: string, queueItemId: string): void {
    this.#publish(
      this.#entries.map((entry) =>
        entry.kind === "sent" && entry.key === key ? { ...entry, queueItemId } : entry,
      ),
    );
  }

  /**
   * The row under `key` sent again in new words, replacing the waiting item `editOf` in its place:
   * a row this window sent keeps its entry, and a row it did not send takes one under its key.
   * Returns what puts the row back as it was, for an edit the service refuses.
   */
  public edit(key: string, content: string, sentAt: string, editOf: string): () => void {
    const before = this.#entries;
    const edited: SentMessage = { kind: "sent", key, content, sentAt, editOf };
    this.#publish(
      before.some((entry) => entry.key === key)
        ? before.map((entry) => (entry.key === key ? edited : entry))
        : [...before, edited],
    );
    return () => {
      const restored = before.find((entry) => entry.key === key);
      this.#publish(
        restored === undefined
          ? this.#entries.filter((entry) => entry.key !== key)
          : this.#entries.map((entry) => (entry.key === key ? restored : entry)),
      );
    };
  }

  /** Lets the sent messages under `keys` go: no row in the store's window reads them now. */
  public release(keys: ReadonlySet<string>): void {
    this.#publish(this.#entries.filter((entry) => entry.kind === "failed" || !keys.has(entry.key)));
  }

  /** The send pressed under its key failed: its row leaves and the line stands in its place. */
  public fail(failed: Omit<FailedSend, "kind">): void {
    this.#publish(
      this.#entries.map((entry) =>
        entry.kind === "sent" && entry.key === failed.key ? { kind: "failed", ...failed } : entry,
      ),
    );
  }

  #publish(entries: readonly SentMessageEntry[]): void {
    this.#entries = entries;
    this.#changes.emit();
  }
}
