// Keystrokes on their way to one shell, in the order they were typed.
//
// At most `TERMINAL_WRITES_WAITING_PER_SHELL` writes wait for the daemon's answer at once; keys
// typed past that are joined and sent as answers return. An interrupt, quit or suspend key is sent
// at once with the keys before it while fewer than `TERMINAL_WRITES_WAITING_LIMIT` wait, so Ctrl-C
// reaches a program that stopped reading. Each write carries at most `TERMINAL_WRITE_MAX_BYTES` of
// UTF-8, so a long paste goes as several writes, never cut inside a character.

import {
  TERMINAL_WRITE_MAX_BYTES,
  TERMINAL_WRITES_WAITING_LIMIT,
  TERMINAL_WRITES_WAITING_PER_SHELL,
} from "@ai-sidekicks/contracts/terminal";

/** The keys that reach a program as its signal: Ctrl-C, Ctrl-\ and Ctrl-Z. */
const SIGNAL_KEYS: readonly string[] = ["\u0003", "\u001c", "\u001a"];

/**
 * One shell's typed keys, sent in order through `send`, which settles once the daemon answers and
 * never rejects.
 */
export class ShellInputQueue {
  readonly #send: (data: string) => Promise<void>;
  #joined = "";
  #waitingCount = 0;

  public constructor(send: (data: string) => Promise<void>) {
    this.#send = send;
  }

  /** Queue what was typed and send what the waiting caps allow. */
  public type(data: string): void {
    this.#joined += data;
    this.#sendJoined(
      SIGNAL_KEYS.some((key) => data.includes(key))
        ? TERMINAL_WRITES_WAITING_LIMIT
        : TERMINAL_WRITES_WAITING_PER_SHELL,
    );
  }

  #sendJoined(waitingCap: number): void {
    while (this.#joined !== "" && this.#waitingCount < waitingCap) {
      const end = writeEndOf(this.#joined);
      const piece = this.#joined.slice(0, end);
      this.#joined = this.#joined.slice(end);
      this.#waitingCount += 1;
      void this.#send(piece).finally(() => {
        this.#waitingCount -= 1;
        this.#sendJoined(TERMINAL_WRITES_WAITING_PER_SHELL);
      });
    }
  }
}

/** Where the first write of `text` ends: its longest prefix of whole characters within the cap. */
function writeEndOf(text: string): number {
  let byteCount = 0;
  let end = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    // UTF-8's own lengths; a lone surrogate is sent as the three-byte replacement character.
    const characterBytes =
      codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (byteCount + characterBytes > TERMINAL_WRITE_MAX_BYTES) {
      break;
    }
    byteCount += characterBytes;
    end += character.length;
  }
  return end;
}
