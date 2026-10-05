// The app's wrapper over `@xterm/xterm`: one terminal, composed from `addons.ts`
// (addons and renderer choice), `links.ts` (both link paths, through `link-guard.ts`)
// and `xterm-mount-binding.ts` (size seam and write gate).
//
// This class owns the emulator's life: built on first attach, kept across a detach, disposed
// once. It never decides who may write; the pane hands it the lease's answer.
// `allowProposedApi` is set here because only the `unicode` getter needs it; the addon that
// uses it loads in `addons.ts`.

// The library's sheet is imported here so it rides the lazy emulator chunk
// (`emulator-loader.ts`) with the code that draws the grid.
import "@xterm/xterm/css/xterm.css";

import { Terminal, type ITerminalOptions } from "@xterm/xterm";

import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../../terminal-caps.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { TerminalRendererPool, terminalRendererPool } from "../renderer-pool.js";
import { TerminalAddonSuite, type TerminalRendererMode } from "./addons.js";
import { XtermMountBinding } from "./xterm-mount-binding.js";
import { buildTerminalLinkHandler, buildTerminalWebLinksAddon } from "./links.js";
import { applyDeclaredMonospaceFamily } from "./typeface.js";

// Re-exported so consumers name the mode through the emulator's own entry point.
export type { TerminalRendererMode } from "./addons.js";

/** What one adapter is built with: its terminal id, renderer pool, and callbacks. */
export interface XtermTerminalAdapterOptions {
  /** The shared terminal this adapter is a view of. One per session. */
  readonly terminalId: string;
  readonly pool?: TerminalRendererPool | undefined;
  /**
   * Whether the lease already says this user may type, at build time; absent means shut. A
   * construction input, because a binding corrected afterwards is briefly wrong.
   */
  readonly isWriteEnabled?: boolean | undefined;
  /** Where a user's keystrokes go. Absent means this terminal never writes. */
  readonly onKeystroke?: ((data: string) => void) | undefined;
  /** Where an allowed link goes. Absent means links render and never activate. */
  readonly onActivateLink?: ((url: string) => void) | undefined;
}

/**
 * One terminal: the emulator, its addons, its renderer, its teardown.
 *
 * Constructed outside a render body and disposed by whoever constructed it. The
 * emulator survives `detach()`, so a pane that moves keeps its scrollback and its
 * renderer; only `dispose()` is final.
 */
export class XtermTerminalAdapter {
  readonly #onActivateLink: ((url: string) => void) | undefined;
  readonly #addons: TerminalAddonSuite;
  readonly #mountBinding: XtermMountBinding;
  // Built on the first attach and dropped with the adapter, so no reference to a disposed
  // emulator and its buffer outlives it.
  #terminal: Terminal | undefined;
  #isDisposed = false;

  public constructor(options: XtermTerminalAdapterOptions) {
    this.#onActivateLink = options.onActivateLink;
    this.#addons = new TerminalAddonSuite(options.terminalId, options.pool ?? terminalRendererPool);
    this.#mountBinding = new XtermMountBinding({
      isWriteEnabled: options.isWriteEnabled,
      onKeystroke: options.onKeystroke,
      onMountResize: () => {
        this.fitToMountPoint();
      },
    });
  }

  /** The renderer this instance is on now. */
  public get rendererMode(): TerminalRendererMode {
    return this.#addons.rendererMode;
  }

  /**
   * Be told which renderer this instance is on, now and whenever that changes. The caller
   * unsubscribes; disposal drops every sink regardless.
   */
  public subscribeToRendererMode(sink: (mode: TerminalRendererMode) => void): Unsubscribe {
    return this.#addons.subscribeToRendererMode(sink);
  }

  /** Whether an emulator exists yet. False before the first attach and after disposal. */
  public get isEmulatorLive(): boolean {
    return this.#terminal !== undefined;
  }

  /** Lines the buffer is holding, scrollback included. Bounded by the scrollback. */
  public get bufferLineCount(): number {
    return this.#terminal?.buffer.active.length ?? 0;
  }

  /**
   * Put the emulator on screen: built on first call and reused after, so a remount does not
   * mint a second WebGL context. A second mount element moves the emulator.
   *
   * The move is done here because in `@xterm/xterm` 6.0.0 (measured in the shipped bundle)
   * `Terminal.open()` builds and appends the element only on its first call; later calls just
   * re-point the library's window reference. The re-append below moves the grid.
   */
  public attach(mountElement: HTMLElement): void {
    if (this.#isDisposed) {
      return;
    }
    const terminal = this.#terminal ?? this.#buildTerminal();
    // So a remount onto an element whose declared face moved follows it.
    applyDeclaredMonospaceFamily(terminal, mountElement);
    const builtElement = terminal.element;
    if (builtElement !== undefined) {
      mountElement.append(builtElement);
    }
    terminal.open(mountElement);
    this.#addons.selectRendererFor(terminal);
    this.#mountBinding.showOn(mountElement);
    this.fitToMountPoint();
  }

  /**
   * Take the emulator off screen and keep it, with its scrollback and renderer. The element
   * is removed too: dropping only the tie would leave xterm's element painted and
   * interactive beside the one the pane moved to, and a person could type into the ghost.
   */
  public detach(): void {
    this.#terminal?.element?.remove();
    this.#mountBinding.detach();
  }

  /** Say whether this user may type. The answer is the lease's, handed down. */
  public setWriteEnabled(isWriteEnabled: boolean): void {
    this.#mountBinding.setWriteEnabled(isWriteEnabled);
  }

  /** Whether a keystroke may reach the wire now: the lease allows it and a mount point holds it. */
  public get isWriteEnabled(): boolean {
    return this.#mountBinding.isWriteEnabled;
  }

  /** The library's own gate, read back rather than mirrored. */
  public get isStdinDisabled(): boolean | undefined {
    return this.#mountBinding.isStdinDisabled;
  }

  /** Write daemon output into the buffer. The only way bytes reach the screen. */
  public write(chunk: string, onWritten?: (() => void) | undefined): void {
    this.#terminal?.write(chunk, onWritten);
  }

  /**
   * Re-measure the grid against its mount element; the observer drives it, no timer. Skipped
   * before the emulator is built or while detached, when there is no grid or no box.
   */
  public fitToMountPoint(): void {
    if (this.#terminal === undefined || this.#mountBinding.mountElement === undefined) {
      return;
    }
    this.#addons.fitGrid();
  }

  /** The visible grid, as text, through the serialize addon. */
  public serialize(): string {
    return this.#addons.serialize();
  }

  /** Find text in the scrollback. The search addon, exposed rather than re-implemented. */
  public findNext(query: string): boolean {
    return this.#addons.findNext(query);
  }

  /**
   * Final. Releases the renderer-mode sinks, this terminal's hold on its renderer, the mount
   * tie and the emulator, in that order. The addons' disposal runs inside the terminal's, so
   * the order is composed here, the only place that knows when the emulator goes.
   */
  public dispose(): void {
    if (this.#isDisposed) {
      return;
    }
    this.#isDisposed = true;
    this.#addons.releaseBeforeEmulatorDisposal();
    this.#mountBinding.dispose();
    this.#terminal?.dispose();
    this.#terminal = undefined;
    this.#addons.dropAfterEmulatorDisposal();
  }

  #buildTerminal(): Terminal {
    const options: ITerminalOptions = {
      scrollback: TERMINAL_DEFAULT_SCROLLBACK_LINES,
      // The only proposed API this wrapper uses is the `unicode` getter.
      allowProposedApi: true,
      // The only textual output: the grid is a canvas under WebGL and positioned spans under
      // DOM. xterm builds its accessible row list and live region only under this option, and
      // `XtermMountPoint.tsx` names the region without announcing anything itself.
      screenReaderMode: true,
      convertEol: true,
      linkHandler: buildTerminalLinkHandler(this.#onActivateLink),
    };
    const terminal = new Terminal(options);
    this.#addons.loadInto(terminal);
    if (this.#onActivateLink !== undefined) {
      // Gated on the sink: without one, printed URLs would be underlined and their clicks
      // swallowed.
      terminal.loadAddon(buildTerminalWebLinksAddon(this.#onActivateLink));
    }
    this.#mountBinding.bindEmulator(terminal);
    this.#terminal = terminal;
    return terminal;
  }
}
