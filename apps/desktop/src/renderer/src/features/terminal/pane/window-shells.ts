// What every pane in one window shares about one shell's output flow. The window declares one flow
// state per shell, behind while any of its panes watching the shell is behind. The client helper
// counts the same across every window on the daemon connection, so the daemon hears a change only
// when the whole connection's state changes.

import type { ShellOutputSubject } from "#renderer/services/daemon/terminal/output.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** One shell as every pane in one window shares it. */
export class WindowShell {
  readonly #onForgotten: () => void;
  #behindPaneCount = 0;

  public constructor(onForgotten: () => void) {
    this.#onForgotten = onForgotten;
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
    if (this.#behindPaneCount === 0) {
      this.#onForgotten();
    }
  }
}

/** The shell as every pane in this bridge's window shares it. */
export function windowShellFor(bridge: PlatformBridge, shell: ShellOutputSubject): WindowShell {
  return windowShells.shellFor(bridge, `${shell.sessionId} ${shell.terminalId}`);
}

/**
 * Every window's shells, by its bridge and then by session and shell; the `WeakMap` lets a gone
 * bridge take its shells with it, and an entry drops once no pane uses it.
 */
class WindowShells {
  readonly #byBridge = new WeakMap<PlatformBridge, Map<string, WindowShell>>();

  public shellFor(bridge: PlatformBridge, shellKey: string): WindowShell {
    let shells = this.#byBridge.get(bridge);
    if (shells === undefined) {
      shells = new Map<string, WindowShell>();
      this.#byBridge.set(bridge, shells);
    }
    const held = shells.get(shellKey);
    if (held !== undefined) {
      return held;
    }
    const forThisBridge = shells;
    const created = new WindowShell(() => {
      if (forThisBridge.get(shellKey) === created) {
        forThisBridge.delete(shellKey);
      }
    });
    shells.set(shellKey, created);
    return created;
  }
}

const windowShells = new WindowShells();
