// Writes one shell's output frames into its emulator in order, and says when the emulator has
// fallen behind them.
//
// `output` and `scrollbackContinuation` bytes are written as they come. A `scrollback` change is a
// fresh window: it replaces whatever has not been handed to the emulator yet, and waits until every
// byte already handed over is parsed, because the redraw's clear and resize do not wait in the
// emulator's write queue. The daemon sends one after a drop, so the redraw is how a watcher that
// fell behind catches up without a byte drawn twice. A shell's end is read off the shell list.
//
// The backlog is every byte taken and not yet parsed. Past the high mark the writer says it is
// behind, and once the backlog falls under the low mark that it has caught up; the gap between the
// two keeps it from flapping. On close it says it has caught up if it was behind, so the daemon
// does not keep counting a pane that is gone.

import type { TerminalOutputChange, TerminalOutputFrame } from "@ai-sidekicks/contracts/terminal";

import type { XtermTerminalAdapter } from "../emulator/xterm/adapter.js";

/** Backlog bytes past which the writer is behind: xterm.js's own flow-control guide's high mark. */
export const OUTPUT_BEHIND_BYTES = 100_000;

/** Backlog bytes under which a writer that was behind has caught up: the guide's low mark. */
export const OUTPUT_CAUGHT_UP_BYTES = 10_000;

/** What the writer draws into: the emulator's byte write and its scrollback redraw. */
export type ShellOutputSink = Pick<XtermTerminalAdapter, "write" | "redrawScrollback">;

/** One shell's frames written into its emulator in order, with its backlog watched. */
export class ShellOutputWriter {
  readonly #sink: ShellOutputSink;
  readonly #onBehindChange: (isBehind: boolean) => void;
  /** Changes taken and not yet handed to the emulator, oldest first. */
  #waiting: WaitingChange[] = [];
  /** Bytes handed to the emulator that it has not parsed yet. */
  #unparsedBytes = 0;
  #backlogBytes = 0;
  #isBehind = false;
  #isClosed = false;

  public constructor(sink: ShellOutputSink, onBehindChange: (isBehind: boolean) => void) {
    this.#sink = sink;
    this.#onBehindChange = onBehindChange;
  }

  /** Whether the backlog last crossed above the behind mark and has not yet fallen back. */
  public get isBehind(): boolean {
    return this.#isBehind;
  }

  /** Take one frame's changes, oldest first, and hand on what can be drawn now. */
  public apply(frame: TerminalOutputFrame): void {
    if (this.#isClosed) {
      return;
    }
    for (const change of frame.changes) {
      this.#take(change);
    }
    this.#handOn();
    this.#noteBacklog();
  }

  /** Stop drawing; a writer that was behind says it has caught up. Final. */
  public close(): void {
    this.#isClosed = true;
    this.#waiting = [];
    if (this.#isBehind) {
      this.#isBehind = false;
      this.#onBehindChange(false);
    }
  }

  #take(change: TerminalOutputChange): void {
    switch (change.kind) {
      case "scrollback":
        // A fresh window: nothing not yet drawn is kept under it.
        for (const dropped of this.#waiting) {
          this.#backlogBytes -= byteCountOf(dropped);
        }
        this.#waiting = [{ kind: "redraw", window: change }];
        this.#backlogBytes += change.data.length;
        return;
      case "scrollbackContinuation":
      case "output":
        this.#waiting.push({ kind: "write", data: change.data });
        this.#backlogBytes += change.data.length;
        return;
      case "exited":
        return;
    }
  }

  #handOn(): void {
    while (this.#waiting.length > 0) {
      const next = this.#waiting[0];
      if (next === undefined || (next.kind === "redraw" && this.#unparsedBytes > 0)) {
        return;
      }
      this.#waiting.shift();
      const byteCount = byteCountOf(next);
      this.#unparsedBytes += byteCount;
      const onParsed = (): void => {
        this.#unparsedBytes -= byteCount;
        this.#backlogBytes -= byteCount;
        if (!this.#isClosed) {
          this.#handOn();
          this.#noteBacklog();
        }
      };
      if (next.kind === "redraw") {
        this.#sink.redrawScrollback(next.window, onParsed);
      } else {
        this.#sink.write(next.data, onParsed);
      }
    }
  }

  #noteBacklog(): void {
    if (!this.#isBehind && this.#backlogBytes > OUTPUT_BEHIND_BYTES) {
      this.#isBehind = true;
      this.#onBehindChange(true);
    } else if (this.#isBehind && this.#backlogBytes < OUTPUT_CAUGHT_UP_BYTES) {
      this.#isBehind = false;
      this.#onBehindChange(false);
    }
  }
}

/** A change taken and not yet handed to the emulator. */
type WaitingChange =
  | { readonly kind: "write"; readonly data: Uint8Array }
  | {
      readonly kind: "redraw";
      readonly window: Extract<TerminalOutputChange, { kind: "scrollback" }>;
    };

function byteCountOf(change: WaitingChange): number {
  return change.kind === "redraw" ? change.window.data.length : change.data.length;
}
