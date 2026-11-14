// Each window's typing into its shells. For every terminal output stream a window holds open, the
// helper keeps a pane's handle onto the addon's one queue for that shell on the connection, which
// keeps the shell's waiting writes, their order and every rule for them: opened at the pane's
// first input, closed when the stream ends or is closed, when the window goes, and when the helper
// makes a new client. A handle closed while its window is served hands back to it what it had not
// sent, and input naming a subscription the window does not hold open goes back to it as it came,
// so the pane sends both on its next subscription and no handle outlives its stream.

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

  /**
   * Send one input of a window's pane through the pane's handle, opened at its first input; input
   * naming a subscription the window does not hold open goes back to it unsent. Answers why the
   * client refused writes the window sent again, which the helper treats as a malformed message.
   */
  public take(window: Window, input: ClientHelperShellInput): string | undefined {
    const served = this.#windows.get(window);
    if (served === undefined) {
      return undefined;
    }
    const { outputSubscriptionId } = input;
    const pane = served.panes.get(outputSubscriptionId);
    if (pane === undefined) {
      tellUnsent(served, outputSubscriptionId, unsentInputOf(input));
      return undefined;
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

  /** The window's stream `streamId` ended or was closed: its pane's handle closes. */
  public forget(window: Window, streamId: number): void {
    const served = this.#windows.get(window);
    if (served === undefined) {
      return;
    }
    for (const [subscriptionId, pane] of served.panes) {
      if (pane.streamId === streamId) {
        served.panes.delete(subscriptionId);
        closeHandle(served, subscriptionId, pane);
      }
    }
  }

  /** The window went: every handle it held closes, with no one left to hand back to. */
  public removeWindow(window: Window): void {
    for (const pane of this.#windows.get(window)?.panes.values() ?? []) {
      pane.handle?.close();
    }
    this.#windows.delete(window);
  }

  /** The helper makes a new client: every handle closes, since its streams were on the old one. */
  public forgetClient(): void {
    for (const served of this.#windows.values()) {
      const panes = [...served.panes];
      served.panes.clear();
      for (const [subscriptionId, pane] of panes) {
        closeHandle(served, subscriptionId, pane);
      }
    }
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
}

/** Closes a pane's handle and hands back to its window what the handle had not sent. */
function closeHandle(served: WindowInputs, subscriptionId: SubscriptionId, pane: PaneInput): void {
  const writes = pane.handle?.close() ?? [];
  if (writes.length > 0) {
    tellUnsent(served, subscriptionId, { kind: "queued", writes });
  }
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
