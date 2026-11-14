// Keystrokes and pastes on their way to one shell, in the order they were typed and pasted.
//
// Every write is bound to the pane's open output subscription; while none is open (before the
// first open, and between a stream's end and its re-open) what is typed waits here and goes once
// the new subscription is bound. At most `TERMINAL_WRITES_WAITING_PER_SHELL` writes wait for the
// daemon's answer at once, counted over every pane in the window, and the client helper holds a
// write past the same figure counted over every window on the connection, as the daemon counts
// them; keys typed past that are joined and sent as answers return. An interrupt, quit or suspend
// key is sent at once with everything before it while fewer than `TERMINAL_WRITES_WAITING_LIMIT`
// wait, so Ctrl-C reaches a program that stopped reading. A paste goes as one paste of one or more
// parts, never joined with keys. Each write carries at most `TERMINAL_WRITE_MAX_BYTES` of UTF-8,
// never cut inside a character.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  TERMINAL_WRITE_MAX_BYTES,
  TERMINAL_WRITES_WAITING_LIMIT,
  TERMINAL_WRITES_WAITING_PER_SHELL,
  type TerminalWriteRequest,
} from "@ai-sidekicks/contracts/terminal";

import { carriesSignalKey } from "#shared/terminal-signal-keys.js";

import type { WindowShell } from "./window-shells.js";

/** One write as the queue holds it: the request without the shell and the subscription. */
export type ShellWrite = TerminalWriteRequest extends infer Write
  ? Write extends unknown
    ? Omit<Write, "sessionId" | "terminalId" | "outputSubscriptionId">
    : never
  : never;

/**
 * One pane's typed keys and pastes for one shell, sent in order through `send` with the
 * subscription bound when each goes; `send` settles once the daemon answers and never rejects.
 */
export class ShellInputQueue {
  readonly #windowShell: () => WindowShell;
  readonly #send: (write: ShellWrite, outputSubscriptionId: SubscriptionId) => Promise<void>;
  /** What waits to be sent, oldest first; a keys write at the end takes the next keys. */
  #waiting: ShellWrite[] = [];
  #outputSubscriptionId: SubscriptionId | undefined;
  #stopFollowingAnswers: (() => void) | undefined;

  public constructor(
    windowShell: () => WindowShell,
    send: (write: ShellWrite, outputSubscriptionId: SubscriptionId) => Promise<void>,
  ) {
    this.#windowShell = windowShell;
    this.#send = send;
  }

  /**
   * Bind later writes to the open subscription and send what waited, sending more as any of the
   * window's panes has a write answered; `undefined` holds them.
   */
  public bind(outputSubscriptionId: SubscriptionId | undefined): void {
    this.#outputSubscriptionId = outputSubscriptionId;
    if (outputSubscriptionId === undefined) {
      this.#stopFollowingAnswers?.();
      this.#stopFollowingAnswers = undefined;
      return;
    }
    this.#stopFollowingAnswers ??= this.#windowShell().followWriteAnswers(() => {
      this.#sendWaiting(TERMINAL_WRITES_WAITING_PER_SHELL);
    });
    this.#sendWaiting(TERMINAL_WRITES_WAITING_PER_SHELL);
  }

  /** Queue what was typed and send what the waiting caps allow. */
  public type(data: string): void {
    const last = this.#waiting.at(-1);
    if (last?.kind === "keys") {
      this.#waiting[this.#waiting.length - 1] = { kind: "keys", data: last.data + data };
    } else {
      this.#waiting.push({ kind: "keys", data });
    }
    this.#sendWaiting(
      carriesSignalKey(data) ? TERMINAL_WRITES_WAITING_LIMIT : TERMINAL_WRITES_WAITING_PER_SHELL,
    );
  }

  /** Queue one paste, in as many parts as the write cap needs, all naming one fresh paste id. */
  public paste(text: string): void {
    if (text === "") {
      return;
    }
    const pasteId = crypto.randomUUID();
    let rest = text;
    while (rest !== "") {
      const end = writeEndOf(rest);
      this.#waiting.push({
        kind: "paste",
        data: rest.slice(0, end),
        pasteId,
        isLastPart: end === rest.length,
      });
      rest = rest.slice(end);
    }
    this.#sendWaiting(TERMINAL_WRITES_WAITING_PER_SHELL);
  }

  #sendWaiting(waitingCap: number): void {
    const outputSubscriptionId = this.#outputSubscriptionId;
    if (outputSubscriptionId === undefined) {
      return;
    }
    // Looked up on each send, since an idle shell is let go; a followed one is kept.
    const windowShell = this.#windowShell();
    while (windowShell.writesWaitingCount < waitingCap) {
      const write = this.#takeNextWrite();
      if (write === undefined) {
        return;
      }
      windowShell.sendWrite();
      // The answer wakes every bound pane's queue, this one among them.
      void this.#send(write, outputSubscriptionId).finally(() => {
        windowShell.answerWrite();
      });
    }
  }

  // A paste part is already within the cap; joined keys are cut at it, the rest left first.
  #takeNextWrite(): ShellWrite | undefined {
    const [first, ...later] = this.#waiting;
    if (first === undefined) {
      return undefined;
    }
    if (first.kind === "paste") {
      this.#waiting = later;
      return first;
    }
    const end = writeEndOf(first.data);
    this.#waiting =
      end === first.data.length ? later : [{ kind: "keys", data: first.data.slice(end) }, ...later];
    return { kind: "keys", data: first.data.slice(0, end) };
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
