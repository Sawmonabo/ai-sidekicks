// Each window's typing into its shells. For every terminal output stream a window holds open, the
// helper keeps a pane's handle onto the addon's one queue for that shell on the connection, which
// keeps the shell's waiting writes, their order and every rule for them: opened at the pane's
// first input, and closed when its stream ends, when the window closes the pane's input, or when
// the helper makes a new client. A closing handle holds the input that arrives for it and waits
// for each write it sent to be answered, which its shell's end or its connection's end also
// brings; it then hands back to the window, in order, the writes the daemon refused for the
// stream's end, what it had not sent and the input that arrived meanwhile. The stream's end never
// waits for that. Input naming a subscription the window does not hold open goes back to it as it
// came. Once the window has closed the pane's input, and after all it hands back, the window is
// told the input is closed: the window sends it nothing after its close, so nothing comes later.
// A stream the window closes, or holds as it goes, finishes its handle instead: everything it
// queued leaves, the window still hears each of those writes answered, and the stream is canceled
// only once each write is answered; the window's close of that input is told `closed` then. A
// refusal no window is left to hear, and a handle that fails to close or finish, go to main's log.

import type { ShellInputHandle } from "@ai-sidekicks/client-sdk";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type {
  ClientHelperShellInput,
  ClientHelperWindowAnswer,
} from "#shared/daemon/port-message.js";
import { describeFailure } from "#shared/failure-message.js";
import type { ShellWriteAnswer, UnsentShellInput } from "#shared/preload-api.js";

import type { ClientHelperDaemonClient } from "./addon.js";
import { wireErrorOf } from "./wire-error.js";

/** What the helper uses of the addon's client to open a pane's input. */
export type ShellInputOpener = Pick<ClientHelperDaemonClient, "openShellInput">;

/** The shell a terminal output stream follows, as its checked params name it. */
export interface FollowedShell {
  readonly sessionId: string;
  readonly terminalId: string;
}

/** Every window's shell inputs, by window and then by the output subscription of each pane. */
export class ShellInputs<Window> {
  readonly #windows = new Map<Window, WindowInputs>();
  readonly #logFailure: (message: string) => void;

  /** Shell inputs that tell main's log, through `logFailure`, what no window can hear. */
  public constructor(logFailure: (message: string) => void) {
    this.#logFailure = logFailure;
  }

  /** Serve `window`, telling it what its panes' writes are answered through `tell`. */
  public addWindow(window: Window, tell: (answer: ClientHelperWindowAnswer) => void): void {
    this.#windows.set(window, { tell, panes: new Map() });
  }

  /**
   * Note the window's terminal output stream `streamId`, opened over `client` on `shell`, whose
   * acknowledgment `acknowledgmentJson` names the subscription its pane's input is bound to.
   */
  public follow(
    window: Window,
    streamId: number,
    shell: FollowedShell,
    acknowledgmentJson: string,
    client: ShellInputOpener,
  ): void {
    // The daemon acknowledges a terminal output subscribe with the subscription's id.
    const { subscriptionId } = JSON.parse(acknowledgmentJson) as { subscriptionId: SubscriptionId };
    this.#windows.get(window)?.panes.set(subscriptionId, {
      streamId,
      shell,
      client,
      handle: undefined,
      closing: undefined,
      finishing: undefined,
    });
  }

  /**
   * Send one input of a window's pane through the pane's handle, opened at its first input; input
   * naming a subscription the window does not hold open, or one whose stream it closed, goes back
   * to it unsent, and input to a pane whose handle is closing goes back after what the handle hands
   * back. Answers why the client
   * refused writes the window sent again, which the helper treats as a malformed message.
   */
  public take(window: Window, input: ClientHelperShellInput): string | undefined {
    const served = this.#windows.get(window);
    if (served === undefined) {
      return undefined;
    }
    const { outputSubscriptionId } = input;
    const pane = served.panes.get(outputSubscriptionId);
    if (pane === undefined || pane.finishing !== undefined) {
      tellUnsent(served, outputSubscriptionId, unsentInputOf(input));
      return undefined;
    }
    if (pane.closing !== undefined) {
      pane.closing.arrived.push(unsentInputOf(input));
      return undefined;
    }
    const handle = (pane.handle ??= pane.client.openShellInput(
      pane.shell.sessionId,
      pane.shell.terminalId,
      outputSubscriptionId,
      (notice) => {
        // A notice the addon queued before the handle closed, or after its window went, has no
        // pane to reach.
        if (
          served.panes.get(outputSubscriptionId) !== pane ||
          this.#windows.get(window) !== served
        ) {
          if (notice.error !== undefined) {
            const { message } = wireErrorOf(notice.error);
            this.#logFailure(`A write of a shell pane no longer open was refused: ${message}`);
          }
          return;
        }
        const answer: ShellWriteAnswer =
          notice.error === undefined
            ? { kind: "taken" }
            : { kind: "refused", refusal: wireErrorOf(notice.error) };
        served.tell({ kind: "shell.writeAnswered", outputSubscriptionId, answer });
      },
    ));
    switch (input.kind) {
      case "shell.keys":
        handle.typeKeys(input.data);
        return undefined;
      case "shell.paste":
        handle.paste(input.text);
        return undefined;
      case "shell.resubmit":
        try {
          handle.resubmit([...input.writes]);
        } catch (failure) {
          return describeFailure(failure);
        }
        return undefined;
    }
  }

  /** The window's stream `streamId` ended: its pane's handle closes, handing back what it held. */
  public forget(window: Window, streamId: number): void {
    const served = this.#windows.get(window);
    const found = served === undefined ? undefined : paneOf(served, streamId);
    if (served !== undefined && found !== undefined) {
      void this.#close(window, served, ...found);
    }
  }

  /**
   * The window closed its pane's input bound to `outputSubscriptionId`: its handle closes, if it is
   * neither closing nor finishing already, and once it has handed back what it held, or finished,
   * the window is told the input is closed; at once where the window holds no pane on that
   * subscription.
   */
  public release(window: Window, outputSubscriptionId: SubscriptionId): void {
    const served = this.#windows.get(window);
    if (served === undefined) {
      return;
    }
    const tellClosed = (): void => {
      if (this.#windows.get(window) === served) {
        served.tell({
          kind: "shell.writeAnswered",
          outputSubscriptionId,
          answer: { kind: "closed" },
        });
      }
    };
    const pane = served.panes.get(outputSubscriptionId);
    if (pane === undefined) {
      tellClosed();
    } else if (pane.finishing !== undefined) {
      void pane.finishing.then(tellClosed);
    } else {
      void this.#close(window, served, outputSubscriptionId, pane).then(tellClosed);
    }
  }

  /**
   * The window closes its stream `streamId`, or goes holding it: its pane's handle finishes,
   * sending everything it queued, while the pane still hears each of those writes answered, or ends
   * its close under way. Answers once each of those writes is answered, when the stream may be
   * canceled, and never rejects; none when the pane never typed.
   */
  public finish(window: Window, streamId: number): Promise<void> | undefined {
    const served = this.#windows.get(window);
    const found = served === undefined ? undefined : paneOf(served, streamId);
    if (served === undefined || found === undefined) {
      return undefined;
    }
    const [subscriptionId, pane] = found;
    if (pane.closing !== undefined) {
      return pane.closing.closed;
    }
    if (pane.finishing !== undefined) {
      return pane.finishing;
    }
    if (pane.handle === undefined) {
      served.panes.delete(subscriptionId);
      return undefined;
    }
    const finishing = pane.handle
      .finish()
      .catch((failure: unknown) => {
        this.#logFailure(`A shell pane's input did not finish: ${describeFailure(failure)}`);
      })
      .then(() => {
        if (served.panes.get(subscriptionId) === pane) {
          served.panes.delete(subscriptionId);
        }
      });
    pane.finishing = finishing;
    return finishing;
  }

  /** The window went, its panes' handles finished first. */
  public removeWindow(window: Window): void {
    this.#windows.delete(window);
  }

  /**
   * The helper makes a new client: every handle closes, since its streams were on the old one; a
   * finishing one ends as the old client's end answers its writes.
   */
  public forgetClient(): void {
    for (const [window, served] of this.#windows) {
      for (const [subscriptionId, pane] of served.panes) {
        if (pane.finishing === undefined) {
          void this.#close(window, served, subscriptionId, pane);
        }
      }
    }
  }

  /**
   * Closes a pane's handle, once, and once each write it sent is answered tells its window, in
   * order, what the handle handed back and the input that arrived meanwhile; a window no longer
   * served is told nothing. Never rejects.
   */
  #close(
    window: Window,
    served: WindowInputs,
    subscriptionId: SubscriptionId,
    pane: PaneInput,
  ): Promise<void> {
    if (pane.closing !== undefined) {
      return pane.closing.closed;
    }
    const arrived: UnsentShellInput[] = [];
    const closed = (async () => {
      try {
        const writes = (await pane.handle?.close()) ?? [];
        if (writes.length > 0) {
          arrived.unshift({ kind: "queued", writes });
        }
      } catch (failure) {
        this.#logFailure(`A shell pane's input did not close: ${describeFailure(failure)}`);
      }
      if (served.panes.get(subscriptionId) === pane) {
        served.panes.delete(subscriptionId);
      }
      if (this.#windows.get(window) === served) {
        for (const input of arrived) {
          tellUnsent(served, subscriptionId, input);
        }
      }
    })();
    pane.closing = { closed, arrived };
    return closed;
  }
}

/** One window's panes, by output subscription, and how it is told of their writes. */
interface WindowInputs {
  readonly tell: (answer: ClientHelperWindowAnswer) => void;
  readonly panes: Map<SubscriptionId, PaneInput>;
}

/** One pane's output stream and, once it has typed, its handle onto the shell's queue. */
interface PaneInput {
  readonly streamId: number;
  readonly shell: FollowedShell;
  readonly client: ShellInputOpener;
  handle: ShellInputHandle | undefined;
  /** Set once its stream ended, its input closed or its client went, while its handle closes. */
  closing: ClosingPane | undefined;
  /** Set once the window closed its stream, while its handle sends what it queued. */
  finishing: Promise<void> | undefined;
}

/** A pane's handle closing: the close under way, and the window's input that arrived meanwhile. */
interface ClosingPane {
  readonly closed: Promise<void>;
  readonly arrived: UnsentShellInput[];
}

/** The pane following the window's stream `streamId`, with its subscription. */
function paneOf(
  served: WindowInputs,
  streamId: number,
): readonly [SubscriptionId, PaneInput] | undefined {
  return [...served.panes].find(([, pane]) => pane.streamId === streamId);
}

function tellUnsent(
  served: WindowInputs,
  outputSubscriptionId: SubscriptionId,
  input: UnsentShellInput,
): void {
  served.tell({
    kind: "shell.writeAnswered",
    outputSubscriptionId,
    answer: { kind: "unsent", input },
  });
}

/** A window's input as it goes back to the window unsent. */
function unsentInputOf(input: ClientHelperShellInput): UnsentShellInput {
  switch (input.kind) {
    case "shell.keys":
      return { kind: "keys", data: input.data };
    case "shell.paste":
      return { kind: "paste", text: input.text };
    case "shell.resubmit":
      return { kind: "queued", writes: input.writes };
  }
}
