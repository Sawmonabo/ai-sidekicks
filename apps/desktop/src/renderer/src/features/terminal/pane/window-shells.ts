// What every pane in one window shares about one shell: its output flow and its one input binding.
// The window declares one flow state per shell, behind while any of its panes watching the shell
// is behind. The client helper counts the same across every window on the daemon connection, so
// the daemon hears a change only when the whole connection's state changes. Every pane that shows
// the shell types through the one binding, so keys typed before a pane closed and after it opened
// again reach the shell in the order typed. A shell is forgotten once no pane is behind on it, no
// pane follows it and its binding holds nothing.

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { openShellInput } from "#renderer/services/daemon/terminal/input.js";
import {
  followShellOutput,
  type ShellOutputSubject,
} from "#renderer/services/daemon/terminal/output.js";
import { ShellInputBinding } from "./input-binding.js";

/** One shell as every pane in one window shares it. */
export class WindowShell {
  /** The shell's one input binding in this window, which every pane showing it types through. */
  public readonly inputBinding: ShellInputBinding;
  readonly #onForgotten: () => void;
  #behindPaneCount = 0;

  /** The shell `shell` over `bridge`, calling `onForgotten` once nothing in the window uses it. */
  public constructor(bridge: PlatformBridge, shell: ShellOutputSubject, onForgotten: () => void) {
    this.#onForgotten = onForgotten;
    this.inputBinding = new ShellInputBinding(
      (outputSubscriptionId, listener) => openShellInput(bridge, outputSubscriptionId, listener),
      (onDelivery) => followShellOutput(bridge, shell, onDelivery),
      () => {
        this.#forgetWhenIdle();
      },
    );
  }

  /**
   * Note one pane falling behind or catching up, and answer the window's state when it changes:
   * `true` once the first pane falls behind, `false` once the last catches up.
   */
  public noteBehind(isBehind: boolean): boolean | undefined {
    const wasBehind = this.#behindPaneCount > 0;
    this.#behindPaneCount += isBehind ? 1 : -1;
    const isWindowBehind = this.#behindPaneCount > 0;
    this.#forgetWhenIdle();
    return wasBehind === isWindowBehind ? undefined : isWindowBehind;
  }

  #forgetWhenIdle(): void {
    if (this.#behindPaneCount === 0 && this.inputBinding.isIdle) {
      this.#onForgotten();
    }
  }
}

/** The shell as every pane in this bridge's window shares it. */
export function windowShellFor(bridge: PlatformBridge, shell: ShellOutputSubject): WindowShell {
  return windowShells.shellFor(bridge, shell);
}

/**
 * Every window's shells, by its bridge and then by session and shell; the `WeakMap` lets a gone
 * bridge take its shells with it, and an entry drops once nothing in its window uses it.
 */
class WindowShells {
  readonly #byBridge = new WeakMap<PlatformBridge, Map<string, WindowShell>>();

  public shellFor(bridge: PlatformBridge, shell: ShellOutputSubject): WindowShell {
    let shells = this.#byBridge.get(bridge);
    if (shells === undefined) {
      shells = new Map<string, WindowShell>();
      this.#byBridge.set(bridge, shells);
    }
    const shellKey = `${shell.sessionId} ${shell.terminalId}`;
    const held = shells.get(shellKey);
    if (held !== undefined) {
      return held;
    }
    const forThisBridge = shells;
    const created = new WindowShell(bridge, shell, () => {
      if (forThisBridge.get(shellKey) === created) {
        forThisBridge.delete(shellKey);
      }
    });
    shells.set(shellKey, created);
    return created;
  }
}

const windowShells = new WindowShells();
