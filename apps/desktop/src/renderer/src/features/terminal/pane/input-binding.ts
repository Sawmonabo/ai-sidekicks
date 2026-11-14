// One shell's keystrokes and pastes on their way to it from one window, in the order they were
// typed and pasted. The window holds one binding per shell (`window-shells.ts`), so a pane that
// closes and opens again on the shell, as a tab switch does, types through the binding it left.
// Each goes through the input bound to the open output subscription. A stream's end closes that
// input at once: the client helper hands back unsent what it still holds of it, and says the input
// is closed once its writes are answered, its shell ends or its connection does. While no
// subscription is bound, and while a closed input has not said so, what is typed waits here, so
// what comes back, even after the next subscription is bound, goes first, in the order it came,
// then what was typed since. A pane closed while something waits lets its stream go at once; once
// every closed input has said so, the binding opens the shell's stream itself, sends what waits on
// it and closes it, which sends what the input queued. A shell found gone lets go of what waits
// and of what is still to come.

import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { ShellInput, UnsentShellInput, Unsubscribe } from "#shared/preload-api.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { ShellInputListener } from "#renderer/services/daemon/terminal/input.js";
import type { ShellOutputDelivery } from "#renderer/services/daemon/terminal/output.js";

/** One shell's input from one window, opened anew through `openInput` for each subscription. */
export class ShellInputBinding {
  readonly #openInput: (
    outputSubscriptionId: SubscriptionId,
    listener: ShellInputListener,
  ) => ShellInput;
  readonly #followOutput: (onDelivery: (delivery: ShellOutputDelivery) => void) => Unsubscribe;
  readonly #onIdle: () => void;
  /** The open subscription's input, while one is bound. */
  #bound: OpenedInput | undefined;
  /** The inputs closed for their stream's end that may still hand something back. */
  readonly #closing = new Set<OpenedInput["token"]>();
  /** What waits to be sent, oldest first: what came back, then what was typed. */
  #held: UnsentShellInput[] = [];
  /** How many of `#held`, at its head, were handed back. */
  #handedBackCount = 0;
  /** Whether a pane follows the shell's output. */
  #isFollowed = false;
  /** Hears each write refused, and `undefined` once one is taken, while a pane follows. */
  #onRefusal: ((refusal: Refusal | undefined) => void) | undefined;
  /** Closes the stream the binding opened to send what a closed pane left waiting. */
  #stopSending: Unsubscribe | undefined;

  /**
   * A binding that opens each input through `openInput`, opens the shell's output stream through
   * `followOutput` when a closed pane left something waiting, and calls `onIdle` each time no pane
   * follows the shell and nothing waits.
   */
  public constructor(
    openInput: (outputSubscriptionId: SubscriptionId, listener: ShellInputListener) => ShellInput,
    followOutput: (onDelivery: (delivery: ShellOutputDelivery) => void) => Unsubscribe,
    onIdle: () => void,
  ) {
    this.#openInput = openInput;
    this.#followOutput = followOutput;
    this.#onIdle = onIdle;
  }

  /** Whether no pane follows the shell and nothing waits to be sent or handed back. */
  public get isIdle(): boolean {
    return (
      !this.#isFollowed &&
      this.#stopSending === undefined &&
      this.#closing.size === 0 &&
      this.#held.length === 0
    );
  }

  /**
   * A pane follows the shell's output, told each write refused through `onRefusal`. A stream the
   * binding opened to send what waited is let go, its bound input closing as a stream's end closes
   * it, and what waits goes on the pane's stream.
   */
  public follow(onRefusal: (refusal: Refusal | undefined) => void): void {
    this.#isFollowed = true;
    this.#onRefusal = onRefusal;
    const stopSending = this.#stopSending;
    if (stopSending !== undefined) {
      this.#stopSending = undefined;
      this.bind(undefined);
      stopSending();
    }
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
    const input = this.#openInput(outputSubscriptionId, {
      onRefusal: (refusal) => {
        this.#onRefusal?.(refusal);
      },
      onUnsent: (unsent) => {
        this.#takeBack(token, unsent);
      },
      onClosed: () => {
        if (this.#closing.delete(token)) {
          this.#flushHeld();
        } else if (this.#bound?.token === token) {
          // Told closed while bound, as a port that closes tells each input: it takes nothing more.
          this.#bound = undefined;
          this.#settle();
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
   * gone; answers whether anything was held.
   */
  public dropHeld(): boolean {
    const hadHeld = this.#held.length > 0;
    this.#held = [];
    this.#handedBackCount = 0;
    this.#closing.clear();
    this.#settle();
    return hadHeld;
  }

  /**
   * The pane closed: `stopFollowing` closes its output stream, which sends what the bound input
   * queued, and the bound input closes after it. What still waits goes once every closed input has
   * handed back all it held, on a stream the binding opens for it.
   */
  public close(stopFollowing: () => void): void {
    this.#isFollowed = false;
    this.#onRefusal = undefined;
    const bound = this.#bound;
    this.#bound = undefined;
    stopFollowing();
    // While anything waits, the bound input has sent nothing, since a closed input was pending for
    // as long as it was bound; so its close hands back nothing and is not waited on.
    bound?.input.close();
    this.#settle();
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

  /** Sends what is held, in order, once a subscription is bound and no closed input is pending. */
  #flushHeld(): void {
    const bound = this.#bound;
    if (bound !== undefined && this.#closing.size === 0) {
      this.#handedBackCount = 0;
      for (const held of this.#held.splice(0)) {
        sendHeld(bound.input, held);
      }
    }
    this.#settle();
  }

  /**
   * With no pane following: once no closed input is pending, opens the shell's stream to send what
   * waits, closes it once nothing does, then tells the window the binding is idle.
   */
  #settle(): void {
    if (this.#isFollowed || this.#closing.size > 0) {
      return;
    }
    if (this.#held.length > 0) {
      this.#stopSending ??= this.#followOutput((delivery) => {
        this.#takeSendingDelivery(delivery);
      });
      return;
    }
    const stopSending = this.#stopSending;
    if (stopSending !== undefined) {
      this.#stopSending = undefined;
      const bound = this.#bound;
      this.#bound = undefined;
      stopSending();
      bound?.input.close();
    }
    this.#onIdle();
  }

  /** What the stream opened for a closed pane's input says; it draws nothing. */
  #takeSendingDelivery(delivery: ShellOutputDelivery): void {
    switch (delivery.kind) {
      case "opened":
        this.bind(delivery.subscriptionId);
        return;
      case "ended":
        this.bind(undefined);
        return;
      case "frame":
        return;
      case "reopenRefusal":
        if (isShellGone(delivery.refusal)) {
          this.dropHeld();
        }
        return;
    }
  }
}

/** Whether a re-open's refusal says the shell is gone, with its session or alone. */
export function isShellGone(refusal: Refusal | undefined): boolean {
  return refusal !== undefined && SHELL_GONE_CODES.has(refusal.code);
}

/** One input the binding opened, and the token its answers are known by. */
interface OpenedInput {
  readonly token: object;
  readonly input: ShellInput;
}

/** The refusals of a re-open that say the shell is gone, with its session or alone. */
const SHELL_GONE_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  "terminal.notFound",
  "session.notFound",
]);

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
