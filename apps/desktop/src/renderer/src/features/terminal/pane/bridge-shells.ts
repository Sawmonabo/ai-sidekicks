// What every pane over one bridge shares about one shell: its output flow and its one input
// binding. One bridge serves every window of the app, so this is the app's, not a window's. The
// bridge declares one flow state per shell, behind while any of its panes watching the shell is
// behind, and the client helper hears a change only when that state changes. Every pane that shows
// the shell types through the one binding, so keys typed before a pane closed and after it opened
// again reach the shell in the order typed. A shell is let go once no pane is behind on it, no pane
// follows it and its binding holds nothing, or once its session's shell list no longer has it.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalId } from "@ai-sidekicks/contracts/terminal";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { openShellInput } from "#renderer/services/daemon/terminal/input.js";
import {
  followShellOutput,
  type ShellOutputSubject,
} from "#renderer/services/daemon/terminal/output.js";
import { ShellInputBinding } from "./input-binding.js";

/** One shell as every pane over one bridge shares it. */
export class BridgeShell {
  /** The shell's one input binding, which every pane showing it types through. */
  public readonly inputBinding: ShellInputBinding;
  readonly #onForgotten: () => void;
  #behindPaneCount = 0;

  /** The shell `shell` over `bridge`, calling `onForgotten` once no pane uses it. */
  public constructor(bridge: PlatformBridge, shell: ShellOutputSubject, onForgotten: () => void) {
    this.#onForgotten = onForgotten;
    this.inputBinding = new ShellInputBinding(
      (outputSubscriptionId, listener) => openShellInput(bridge, outputSubscriptionId, listener),
      (onDelivery, afterOffset) => followShellOutput(bridge, shell, onDelivery, afterOffset),
      () => {
        this.#forgetWhenIdle();
      },
    );
  }

  /**
   * Note one pane falling behind or catching up, and answer the bridge's state when it changes:
   * `true` once the first pane falls behind, `false` once the last catches up.
   */
  public noteBehind(isBehind: boolean): boolean | undefined {
    const wasBehind = this.#behindPaneCount > 0;
    this.#behindPaneCount += isBehind ? 1 : -1;
    const isBridgeBehind = this.#behindPaneCount > 0;
    this.#forgetWhenIdle();
    return wasBehind === isBridgeBehind ? undefined : isBridgeBehind;
  }

  #forgetWhenIdle(): void {
    if (this.#behindPaneCount === 0 && this.inputBinding.isIdle) {
      this.#onForgotten();
    }
  }
}

/** The shell as every pane over `bridge` shares it. */
export function bridgeShellFor(bridge: PlatformBridge, shell: ShellOutputSubject): BridgeShell {
  return bridgeShells.shellFor(bridge, shell);
}

/**
 * Let go of what is held for each of the session's shells over `bridge` that its shell list no
 * longer has, as for a shell found gone.
 */
export function forgetUnlistedShells(
  bridge: PlatformBridge,
  sessionId: SessionId,
  listedTerminalIds: readonly TerminalId[],
): void {
  bridgeShells.forgetUnlisted(bridge, sessionId, listedTerminalIds);
}

/**
 * Every bridge's shells, by the bridge their streams ride and then by session and shell. One bridge
 * serves the app, so its shells live as long as their use does; the `WeakMap` keeps a test's own
 * bridge from sharing another's.
 */
class BridgeShells {
  readonly #byBridge = new WeakMap<PlatformBridge, Map<string, HeldBridgeShell>>();

  public shellFor(bridge: PlatformBridge, shell: ShellOutputSubject): BridgeShell {
    let shells = this.#byBridge.get(bridge);
    if (shells === undefined) {
      shells = new Map<string, HeldBridgeShell>();
      this.#byBridge.set(bridge, shells);
    }
    const shellKey = `${shell.sessionId} ${shell.terminalId}`;
    const held = shells.get(shellKey);
    if (held !== undefined) {
      return held.shell;
    }
    const forThisBridge = shells;
    const created: HeldBridgeShell = {
      subject: shell,
      shell: new BridgeShell(bridge, shell, () => {
        if (forThisBridge.get(shellKey) === created) {
          forThisBridge.delete(shellKey);
        }
      }),
    };
    shells.set(shellKey, created);
    return created.shell;
  }

  public forgetUnlisted(
    bridge: PlatformBridge,
    sessionId: SessionId,
    listedTerminalIds: readonly TerminalId[],
  ): void {
    const shells = this.#byBridge.get(bridge);
    if (shells === undefined) {
      return;
    }
    for (const { subject, shell } of [...shells.values()]) {
      if (subject.sessionId === sessionId && !listedTerminalIds.includes(subject.terminalId)) {
        shell.inputBinding.dropHeld();
      }
    }
  }
}

/** One shell the map holds, with the subject it was made for. */
interface HeldBridgeShell {
  readonly subject: ShellOutputSubject;
  readonly shell: BridgeShell;
}

const bridgeShells = new BridgeShells();
