// One pane's keystrokes and pastes on their way to its shell, in the order they were typed and
// pasted. Each goes through the pane's input bound to its open output subscription; while none is
// open (before the first open, and between a stream's end and its re-open) what is typed waits
// here and goes, in order, once the new subscription is bound. What the ended subscription's input
// hands back unsent, all of it typed before anything held, waits at the head and goes first; that
// input stays open until the re-open, since what it hands back arrives after its stream's end.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { ShellInput, UnsentShellInput } from "#shared/preload-api.js";

/** A pane's input to its shell, opened anew through `open` for each subscription it is bound to. */
export class ShellInputBinding {
  readonly #open: (outputSubscriptionId: SubscriptionId) => ShellInput;
  /** The newest subscription's input, open until the next one is bound or the pane closes. */
  #input: ShellInput | undefined;
  #isBound = false;
  /** What waits for the next subscription, oldest first: what came back, then what was typed. */
  #held: UnsentShellInput[] = [];
  /** How many of `#held`, at its head, were handed back. */
  #handedBackCount = 0;

  public constructor(open: (outputSubscriptionId: SubscriptionId) => ShellInput) {
    this.#open = open;
  }

  /**
   * Bind later input to the open subscription and send what was held, what came back first;
   * `undefined` holds it, the ended subscription's input still hearing what comes back.
   */
  public bind(outputSubscriptionId: SubscriptionId | undefined): void {
    if (outputSubscriptionId === undefined) {
      this.#isBound = false;
      return;
    }
    this.#input?.close();
    const input = this.#open(outputSubscriptionId);
    this.#input = input;
    this.#isBound = true;
    this.#handedBackCount = 0;
    for (const held of this.#held.splice(0)) {
      sendHeld(input, held);
    }
  }

  /** Send what was typed, or hold it until a subscription is bound. */
  public type(data: string): void {
    this.#send({ kind: "keys", data });
  }

  /** Send one paste, or hold it until a subscription is bound. */
  public paste(text: string): void {
    this.#send({ kind: "paste", text });
  }

  /** Hold input handed back unsent, after what came back before it and ahead of what was typed. */
  public takeBack(input: UnsentShellInput): void {
    this.#held.splice(this.#handedBackCount, 0, input);
    this.#handedBackCount += 1;
  }

  /** Let go of everything held, for a shell that is gone; answers whether anything was held. */
  public dropHeld(): boolean {
    const hadHeld = this.#held.length > 0;
    this.#held = [];
    this.#handedBackCount = 0;
    return hadHeld;
  }

  /** The pane closed: its input closes and nothing held goes. */
  public close(): void {
    this.#input?.close();
    this.#input = undefined;
    this.#isBound = false;
    this.dropHeld();
  }

  #send(typed: UnsentShellInput): void {
    if (this.#isBound && this.#input !== undefined) {
      sendHeld(this.#input, typed);
    } else {
      this.#held.push(typed);
    }
  }
}

function sendHeld(input: ShellInput, held: UnsentShellInput): void {
  switch (held.kind) {
    case "keys":
      input.typeKeys(held.data);
      return;
    case "paste":
      input.pasteText(held.text);
      return;
    case "queued":
      input.resubmit(held.writes);
      return;
  }
}
