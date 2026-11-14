// One pane's keystrokes and pastes on their way to its shell, in the order they were typed and
// pasted. Each goes through the pane's input bound to its open output subscription. A stream's
// end closes that input at once: the client helper hands back unsent what it still holds of it,
// and says the input is closed once its writes are answered, its shell ends or its connection
// does. While no subscription is bound, and while a closed input has not said so, what is typed
// waits here, so what comes back, even after the next subscription is bound, goes first, in the
// order it came, then what was typed since. A pane closed while something waits keeps its binding,
// and its output stream open, until it can send all of it on a bound subscription; then it closes
// that stream, which sends what the input queued. A shell found gone lets go of what waits and of
// what is still to come.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { ShellInput, UnsentShellInput } from "#shared/preload-api.js";
import type { ShellInputListener } from "#renderer/services/daemon/terminal/input.js";

/** A pane's input to its shell, opened anew through `open` for each subscription it is bound to. */
export class ShellInputBinding {
  readonly #open: (
    outputSubscriptionId: SubscriptionId,
    handBack: ShellInputHandBack,
  ) => ShellInput;
  /** The open subscription's input, while one is bound. */
  #bound: OpenedInput | undefined;
  /** The inputs closed for their stream's end that may still hand something back. */
  readonly #closing = new Set<OpenedInput["token"]>();
  /** What waits to be sent, oldest first: what came back, then what was typed. */
  #held: UnsentShellInput[] = [];
  /** How many of `#held`, at its head, were handed back. */
  #handedBackCount = 0;
  /** Closes the pane's output stream, once a closed pane has sent everything that waited. */
  #finish: (() => void) | undefined;

  public constructor(
    open: (outputSubscriptionId: SubscriptionId, handBack: ShellInputHandBack) => ShellInput,
  ) {
    this.#open = open;
  }

  /**
   * Close the input bound to the ended subscription, and bind later input to the open one, if any;
   * what waits goes once every closed input has handed back all it held.
   */
  public bind(outputSubscriptionId: SubscriptionId | undefined): void {
    const ended = this.#bound;
    if (ended !== undefined) {
      this.#bound = undefined;
      this.#closing.add(ended.token);
      ended.input.close();
    }
    if (outputSubscriptionId === undefined) {
      return;
    }
    const token = {};
    const input = this.#open(outputSubscriptionId, {
      onUnsent: (unsent) => {
        this.#takeBack(token, unsent);
      },
      onClosed: () => {
        if (this.#closing.delete(token)) {
          this.#flushHeld();
        } else if (this.#bound?.token === token) {
          // Told closed while bound, as a port that closes tells each input: it takes nothing more.
          this.#bound = undefined;
          this.#finishOnceSent();
        }
      },
    });
    this.#bound = { token, input };
    this.#flushHeld();
  }

  /** Send what was typed, or hold it until it may go. */
  public type(data: string): void {
    this.#send({ kind: "keys", data });
  }

  /** Send one paste, or hold it until it may go. */
  public paste(text: string): void {
    this.#send({ kind: "paste", text });
  }

  /**
   * Let go of everything held, and of what closed inputs may still hand back, for a shell that is
   * gone, finishing a closed pane; answers whether anything was held.
   */
  public dropHeld(): boolean {
    const hadHeld = this.#held.length > 0;
    this.#held = [];
    this.#handedBackCount = 0;
    this.#closing.clear();
    this.#finishOnceSent();
    return hadHeld;
  }

  /**
   * The pane closed: `finish` closes its output stream, and the bound input closes after it, once
   * nothing waits; until then the binding goes on taking what comes back and the next bound
   * subscription, and sends what waits on that subscription before it finishes.
   */
  public close(finish: () => void): void {
    this.#finish = finish;
    this.#finishOnceSent();
  }

  /**
   * The pane opens its output again: a closed pane still waiting lets go of its stream now, its
   * bound input closing as a stream's end closes it, and what waits goes on the new stream.
   */
  public reopen(): void {
    const finish = this.#finish;
    if (finish === undefined) {
      return;
    }
    this.#finish = undefined;
    this.bind(undefined);
    finish();
  }

  #send(typed: UnsentShellInput): void {
    if (this.#bound !== undefined && this.#closing.size === 0 && this.#held.length === 0) {
      sendHeld(this.#bound.input, typed);
    } else {
      this.#held.push(typed);
    }
  }

  /**
   * Holds what one of this binding's inputs handed back, after what came back before it and ahead
   * of what was typed; it waits for the next flush, since the input that handed it back takes
   * nothing more.
   */
  #takeBack(token: OpenedInput["token"], unsent: UnsentShellInput): void {
    if (token !== this.#bound?.token && !this.#closing.has(token)) {
      return;
    }
    this.#held.splice(this.#handedBackCount, 0, unsent);
    this.#handedBackCount += 1;
  }

  /**
   * Sends what is held, in order, once a subscription is bound and no closed input is pending;
   * a closed pane with nothing left waiting then finishes.
   */
  #flushHeld(): void {
    const bound = this.#bound;
    if (bound !== undefined && this.#closing.size === 0) {
      this.#handedBackCount = 0;
      for (const held of this.#held.splice(0)) {
        sendHeld(bound.input, held);
      }
    }
    this.#finishOnceSent();
  }

  /** A closed pane with nothing left waiting closes its stream, then its bound input. */
  #finishOnceSent(): void {
    const finish = this.#finish;
    if (finish === undefined || this.#closing.size > 0 || this.#held.length > 0) {
      return;
    }
    this.#finish = undefined;
    const bound = this.#bound;
    this.#bound = undefined;
    finish();
    bound?.input.close();
  }
}

/** What a pane's input hears that its binding acts on: input handed back, and its close. */
type ShellInputHandBack = Pick<ShellInputListener, "onUnsent" | "onClosed">;

/** One input the binding opened, and the token its answers are known by. */
interface OpenedInput {
  readonly token: object;
  readonly input: ShellInput;
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
