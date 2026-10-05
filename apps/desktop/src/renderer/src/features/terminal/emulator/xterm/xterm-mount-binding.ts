// What ties one emulator to one mount element: the box it is measured against, and whether
// this device may type into it.
//
// Stdin is shut (watch mode) until the binding is shown on a mount element with the lease's
// answer that this device holds the shell; the emulator gets its gate in the same synchronous
// `attach()` that builds it, so no keystroke reaches it before the gate is set. The gate is the
// library's own `disableStdin` option, which shuts the input element and drops every data
// event, programmatic input included. Keystrokes go to the wire, never
// the local buffer, because the daemon echoes a shared shell.
//
// The gate is the lease's answer and a mount element being on screen. The lease's answer is
// stored, so a detached binding reports the shut gate and re-opens it on the next mount
// element without being told again. The binding never decides who may write; the pane hands
// it the lease's answer. Resize observation goes through `lib/element-resize.ts` and starts
// no interval.

import type { IDisposable, Terminal } from "@xterm/xterm";

import type { Unsubscribe } from "#shared/preload-api.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";

/** Inputs to the binding: the initial lease answer, the keystroke sink, and the re-fit hook. */
export interface XtermMountBindingOptions {
  /** Whether the lease already says this user may type. Absent is watch mode. */
  readonly isWriteEnabled?: boolean | undefined;
  /** Where a user's keystrokes go. Absent means this terminal never writes. */
  readonly onKeystroke?: ((data: string) => void) | undefined;
  /**
   * What a change in the mount element's box re-enters. The adapter's public re-fit, so a
   * resize and an explicit `fitToMountPoint()` share one path to the grid.
   */
  readonly onMountResize: () => void;
}

/** One emulator's tie to one mount element. */
export class XtermMountBinding {
  readonly #onKeystroke: ((data: string) => void) | undefined;
  readonly #onMountResize: () => void;
  #terminal: Terminal | undefined;
  #mountElement: HTMLElement | undefined;
  #stopObservingMountSize: Unsubscribe | undefined;
  #keystrokeSubscription: IDisposable | undefined;
  #isWriteAllowedByLease: boolean;

  /** A binding holding the lease's first answer, with no emulator or mount element yet. */
  public constructor(options: XtermMountBindingOptions) {
    this.#isWriteAllowedByLease = options.isWriteEnabled ?? false;
    this.#onKeystroke = options.onKeystroke;
    this.#onMountResize = options.onMountResize;
  }

  /** The element the emulator is currently on screen in, or `undefined`. */
  public get mountElement(): HTMLElement | undefined {
    return this.#mountElement;
  }

  /** Whether a keystroke may reach the wire: the lease allows it and a mount element holds it. */
  public get isWriteEnabled(): boolean {
    return this.#isWriteAllowedByLease && this.#mountElement !== undefined;
  }

  /** The library's own gate read back; `isWriteEnabled` would not notice the option not moving. */
  public get isStdinDisabled(): boolean | undefined {
    return this.#terminal?.options.disableStdin;
  }

  /** Bind a freshly built emulator: hold it for the gate, and arm the keystroke path. */
  public bindEmulator(terminal: Terminal): void {
    this.#terminal = terminal;
    if (this.#onKeystroke !== undefined) {
      this.#keystrokeSubscription = terminal.onData(this.#onKeystroke);
    }
  }

  /**
   * Say whether this device may type. Watch mode is the default and the fallback, since a
   * guess here would fail toward writing into a shell this device does not hold. The answer
   * is remembered, so a mount element that takes the emulator later still gets it.
   */
  public setWriteEnabled(isWriteEnabled: boolean): void {
    this.#isWriteAllowedByLease = isWriteEnabled;
    this.#applyStdinGate();
  }

  /**
   * Record the mount element the emulator is now on, and re-fit whenever its box changes. A
   * fresh emulator gets its gate here, in the same `attach()` call that built it.
   */
  public showOn(mountElement: HTMLElement): void {
    this.#mountElement = mountElement;
    this.#stopObservingMountSize?.();
    this.#stopObservingMountSize = observeElementResize(mountElement, () => {
      this.#onMountResize();
    });
    this.#applyStdinGate();
  }

  /** Take the emulator off screen. The emulator itself survives — only the tie ends. */
  public detach(): void {
    this.#stopObservingMountSize?.();
    this.#stopObservingMountSize = undefined;
    this.#mountElement = undefined;
    this.#applyStdinGate();
  }

  /**
   * Final: the mount tie and the keystroke path both end. The emulator is dropped, not
   * disposed; the adapter owns that, and disposing from two places half-tears it.
   */
  public dispose(): void {
    this.detach();
    this.#keystrokeSubscription?.dispose();
    this.#keystrokeSubscription = undefined;
    this.#terminal = undefined;
  }

  /** Pushes the composed answer onto the library's option; the one writer of it. */
  #applyStdinGate(): void {
    if (this.#terminal !== undefined) {
      this.#terminal.options.disableStdin = !this.isWriteEnabled;
    }
  }
}
