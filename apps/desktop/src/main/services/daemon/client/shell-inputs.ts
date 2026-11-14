// Each window's typing into its shells. For every terminal output stream a window holds open, the
// helper keeps a pane's handle onto the addon's one queue for that shell on the connection, which
// keeps the shell's waiting writes, their order and every rule for them: opened at the pane's
// first input, closed when the stream ends or is closed, when the window goes, and when the helper
// makes a new client. Input naming a subscription the window does not hold open is answered as
// unsent, so no handle outlives its stream.

import type { ShellInputHandle } from "@ai-sidekicks/client-sdk";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type {
  ClientHelperShellInput,
  ClientHelperWindowAnswer,
} from "#shared/daemon/port-message.js";
import type { ShellWriteAnswer } from "#shared/preload-api.js";

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
    this.#windows
      .get(window)
      ?.panes.set(subscriptionId, { streamId, shell, client, handle: undefined });
  }

  /** Send one input of a window's pane through the pane's handle, opened at its first input. */
  public take(window: Window, input: ClientHelperShellInput): void {
    const served = this.#windows.get(window);
    if (served === undefined) {
      return;
    }
    const { outputSubscriptionId } = input;
    const pane = served.panes.get(outputSubscriptionId);
    if (pane === undefined) {
      served.tell({
        kind: "shell.writeAnswered",
        outputSubscriptionId,
        answer: { kind: "unsent" },
      });
      return;
    }
    const handle = (pane.handle ??= pane.client.openShellInput(
      pane.shell.sessionId,
      pane.shell.terminalId,
      outputSubscriptionId,
      (notice) => {
        // A notice the addon queued before the handle closed has no pane left to reach.
        if (served.panes.get(outputSubscriptionId) !== pane) {
          return;
        }
        const answer: ShellWriteAnswer =
          notice.error === undefined
            ? { kind: "taken" }
            : { kind: "refused", refusal: wireErrorOf(notice.error) };
        served.tell({ kind: "shell.writeAnswered", outputSubscriptionId, answer });
      },
    ));
    if (input.kind === "shell.keys") {
      handle.typeKeys(input.data);
    } else {
      handle.paste(input.text);
    }
  }

  /** The window's stream `streamId` ended or was closed: its pane's handle closes. */
  public forget(window: Window, streamId: number): void {
    const panes = this.#windows.get(window)?.panes;
    if (panes === undefined) {
      return;
    }
    for (const [subscriptionId, pane] of panes) {
      if (pane.streamId === streamId) {
        pane.handle?.close();
        panes.delete(subscriptionId);
      }
    }
  }

  /** The window went: every handle it held closes. */
  public removeWindow(window: Window): void {
    for (const pane of this.#windows.get(window)?.panes.values() ?? []) {
      pane.handle?.close();
    }
    this.#windows.delete(window);
  }

  /** The helper makes a new client: every handle closes, since its streams were on the old one. */
  public forgetClient(): void {
    for (const { panes } of this.#windows.values()) {
      for (const pane of panes.values()) {
        pane.handle?.close();
      }
      panes.clear();
    }
  }
}

/** One window's panes, by output subscription, and how it is told of their writes. */
interface WindowInputs {
  readonly tell: (answer: ClientHelperWindowAnswer) => void;
  readonly panes: Map<string, PaneInput>;
}

/** One pane's output stream and, once it has typed, its handle onto the shell's queue. */
interface PaneInput {
  readonly streamId: number;
  readonly shell: FollowedShell;
  readonly client: ShellInputOpener;
  handle: ShellInputHandle | undefined;
}
