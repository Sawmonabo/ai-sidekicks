// One pane's keystrokes and pastes on their way to its shell, in the order they were typed and
// pasted. Each goes through the pane's input bound to its open output subscription; while none is
// open (before the first open, and between a stream's end and its re-open) what is typed waits
// here and goes, in order, once the new subscription is bound.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { ShellInput } from "#shared/preload-api.js";

/** A pane's input to its shell, opened anew through `open` for each subscription it is bound to. */
export class ShellInputBinding {
  readonly #open: (outputSubscriptionId: SubscriptionId) => ShellInput;
  #input: ShellInput | undefined;
  /** What was typed or pasted while no subscription was bound, oldest first. */
  #held: HeldInput[] = [];

  public constructor(open: (outputSubscriptionId: SubscriptionId) => ShellInput) {
    this.#open = open;
  }

  /** Bind later input to the open subscription and send what was held; `undefined` holds it. */
  public bind(outputSubscriptionId: SubscriptionId | undefined): void {
    this.#input?.close();
    this.#input = undefined;
    if (outputSubscriptionId === undefined) {
      return;
    }
    const input = this.#open(outputSubscriptionId);
    this.#input = input;
    for (const held of this.#held.splice(0)) {
      if (held.kind === "keys") {
        input.typeKeys(held.data);
      } else {
        input.pasteText(held.text);
      }
    }
  }

  /** Send what was typed, or hold it until a subscription is bound. */
  public type(data: string): void {
    if (this.#input === undefined) {
      this.#held.push({ kind: "keys", data });
    } else {
      this.#input.typeKeys(data);
    }
  }

  /** Send one paste, or hold it until a subscription is bound. */
  public paste(text: string): void {
    if (this.#input === undefined) {
      this.#held.push({ kind: "paste", text });
    } else {
      this.#input.pasteText(text);
    }
  }
}

/** One input held while no subscription is bound. */
type HeldInput =
  | { readonly kind: "keys"; readonly data: string }
  | { readonly kind: "paste"; readonly text: string };
