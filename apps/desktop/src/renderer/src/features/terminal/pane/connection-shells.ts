// What every pane on one daemon connection shares about one shell. The daemon holds one pause
// state and one count of waiting writes per connection and shell, and every window speaks over the
// one connection, so a pane's own figure is never sent alone: the connection is behind while any
// pane watching the shell is behind, and the waiting-write caps count every pane's writes.

import type { ShellOutputSubject } from "#renderer/services/daemon/terminal/output.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** One shell as every pane on one connection shares it. */
export class ConnectionShell {
  readonly #onForgotten: () => void;
  #behindPaneCount = 0;
  #writesWaitingCount = 0;
  readonly #onWriteAnswered = new Set<() => void>();

  public constructor(onForgotten: () => void) {
    this.#onForgotten = onForgotten;
  }

  /** The writes to this shell from every pane that wait for the daemon's answer. */
  public get writesWaitingCount(): number {
    return this.#writesWaitingCount;
  }

  /**
   * Note one pane falling behind or catching up, and answer the connection's state when it
   * changes: `true` once the first pane falls behind, `false` once the last catches up.
   */
  public noteBehind(isBehind: boolean): boolean | undefined {
    const wasBehind = this.#behindPaneCount > 0;
    this.#behindPaneCount += isBehind ? 1 : -1;
    const isConnectionBehind = this.#behindPaneCount > 0;
    this.#forgetWhenIdle();
    return wasBehind === isConnectionBehind ? undefined : isConnectionBehind;
  }

  /** Count one write sent; `answerWrite` uncounts it. */
  public sendWrite(): void {
    this.#writesWaitingCount += 1;
  }

  /** Uncount one answered write and tell every pane waiting for room. */
  public answerWrite(): void {
    this.#writesWaitingCount -= 1;
    for (const listener of [...this.#onWriteAnswered]) {
      listener();
    }
    this.#forgetWhenIdle();
  }

  /** Be told each time a write is answered, until the handle stops it. */
  public followWriteAnswers(listener: () => void): () => void {
    this.#onWriteAnswered.add(listener);
    return () => {
      this.#onWriteAnswered.delete(listener);
      this.#forgetWhenIdle();
    };
  }

  #forgetWhenIdle(): void {
    if (
      this.#behindPaneCount === 0 &&
      this.#writesWaitingCount === 0 &&
      this.#onWriteAnswered.size === 0
    ) {
      this.#onForgotten();
    }
  }
}

/** The shell as every pane on this bridge's connection shares it. */
export function connectionShellFor(
  bridge: PlatformBridge,
  shell: ShellOutputSubject,
): ConnectionShell {
  return connectionShells.shellFor(bridge, `${shell.sessionId} ${shell.terminalId}`);
}

/**
 * Every connection's shells, by bridge and then by session and shell; the `WeakMap` lets a gone
 * bridge take its shells with it, and an entry drops once no pane uses it.
 */
class ConnectionShells {
  readonly #byBridge = new WeakMap<PlatformBridge, Map<string, ConnectionShell>>();

  public shellFor(bridge: PlatformBridge, shellKey: string): ConnectionShell {
    let shells = this.#byBridge.get(bridge);
    if (shells === undefined) {
      shells = new Map<string, ConnectionShell>();
      this.#byBridge.set(bridge, shells);
    }
    const held = shells.get(shellKey);
    if (held !== undefined) {
      return held;
    }
    const forThisBridge = shells;
    const created = new ConnectionShell(() => {
      if (forThisBridge.get(shellKey) === created) {
        forThisBridge.delete(shellKey);
      }
    });
    shells.set(shellKey, created);
    return created;
  }
}

const connectionShells = new ConnectionShells();
