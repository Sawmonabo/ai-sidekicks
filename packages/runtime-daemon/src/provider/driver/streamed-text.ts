// The text a provider streams while it writes a reply, a reasoning summary or a plan, handed on as
// stored pieces of one message: the deltas of each message are joined and sent as one piece per
// interval, and its final text sends only what the pieces have not yet carried, so every piece
// of a message, joined in order, is the provider's final text.

// The longest a streamed delta waits before it goes out as a piece. A reply of about 1,000 tokens
// written over 10 s, which Codex sends as about 1,000 deltas, becomes at most 100 stored pieces.
const STREAMED_TEXT_PIECE_INTERVAL_MS = 100;

/** Where one message's pieces go, each as one stored row. */
export type StreamedTextSink = (piece: string) => void;

interface StreamedMessage {
  /** The turn the message belongs to, whose end sends what is still waiting. */
  readonly turnId: string;
  readonly sink: StreamedTextSink;
  /** Everything already sent as pieces. */
  sent: string;
  /** Deltas that arrived since the last piece. */
  waiting: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The messages a provider is streaming on one session, by the provider's message key. */
export class StreamedText {
  readonly #messages = new Map<string, StreamedMessage>();

  /** Adds a delta to the message `key`, opening it on `sink`; the delta goes out within the interval. */
  append(key: string, turnId: string, delta: string, sink: StreamedTextSink): void {
    if (delta === "") {
      return;
    }
    const message = this.#messages.get(key) ?? {
      turnId,
      sink,
      sent: "",
      waiting: "",
      timer: undefined,
    };
    this.#messages.set(key, message);
    message.waiting += delta;
    message.timer ??= setTimeout(() => {
      this.#send(message);
    }, STREAMED_TEXT_PIECE_INTERVAL_MS);
  }

  /**
   * Ends the message `key` with the provider's final text: what streamed and the rest of the final
   * text go out as the last piece, or the whole text as the only one when nothing streamed.
   * Returns `false` when the streamed text is no prefix of the final text; the pieces already sent
   * stand, nothing more is sent, and the caller reports it.
   */
  complete(key: string, finalText: string, sink: StreamedTextSink): boolean {
    const message = this.#messages.get(key);
    this.#messages.delete(key);
    if (message === undefined) {
      if (finalText !== "") {
        sink(finalText);
      }
      return true;
    }
    const streamed = message.sent + message.waiting;
    if (!finalText.startsWith(streamed)) {
      this.#send(message);
      return false;
    }
    message.waiting += finalText.slice(streamed.length);
    this.#send(message);
    return true;
  }

  /**
   * Drops the message `key` and what is still waiting on it, which the provider says it will never
   * finish. Returns whether pieces of it were already sent, which stay.
   */
  discard(key: string): boolean {
    const message = this.#messages.get(key);
    if (message === undefined) {
      return false;
    }
    this.#messages.delete(key);
    clearTimeout(message.timer);
    return message.sent !== "";
  }

  /** Sends what is still waiting on every message of `turnId`, which ended without finishing them. */
  endTurn(turnId: string): void {
    for (const [key, message] of this.#messages) {
      if (message.turnId === turnId) {
        this.#messages.delete(key);
        this.#send(message);
      }
    }
  }

  /** Sends what is still waiting on every message, once the session's stream ends. */
  endAll(): void {
    for (const message of this.#messages.values()) {
      this.#send(message);
    }
    this.#messages.clear();
  }

  #send(message: StreamedMessage): void {
    clearTimeout(message.timer);
    message.timer = undefined;
    if (message.waiting === "") {
      return;
    }
    const piece = message.waiting;
    message.sent += piece;
    message.waiting = "";
    message.sink(piece);
  }
}
