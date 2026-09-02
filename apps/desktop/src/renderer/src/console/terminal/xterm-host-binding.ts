// What ties one emulator to one host element: the box it is measured against, and
// whether this participant may type into it.
//
// Its own module rather than a section inside `xterm-adapter.ts`, because the two
// answer different questions: the adapter owns the emulator's LIFE — built once,
// kept across a detach, disposed once — and this owns its relationship to a host
// that comes and goes, which is where both the size seam and the write gate live.
//
// `Spec-023 §Console Libraries` constraint 5 is here: **`disableStdin` plus
// wire-level gating for watchers.** Watch mode is the default, so stdin starts
// disabled and opens only when the lease says this participant holds the shell — and
// the keystrokes go to the wire, never into the local buffer, because the daemon is
// what echoes a shared shell. The gate is applied twice on purpose: the option stops
// the DOM listener and the check inside `onData` stops a programmatic write. The
// expensive mistake on a shared shell is sending a keystroke nobody was allowed to
// send.
//
// WHAT IT DOES NOT DO. It never decides who may write: it is handed that answer by a
// surface that read it off the lease. An emulator that consulted a lease would be a
// second place eligibility is decided, and the renderer decides it nowhere.
//
// THE SIZE SEAM IS THE CONSOLE'S ONE. `primitives/element-resize.ts` owns the
// observer construction, its feature detection, and its disconnect. A second
// construction here would be the same four lines free to drift from the browser
// family's — the hoist-on-second-use rule `apps/desktop/AGENTS.md` states — and the
// degrade is the helper's: a host without the observer arms nothing and re-fits when
// the surface asks. No interval is started either way; a polling terminal would be
// the console's only always-on timer.

import type { IDisposable, Terminal } from "@xterm/xterm";

import type { Unsubscribe } from "../core/index.js";
import { observeElementResize } from "../primitives/index.js";

export interface TerminalHostBindingOptions {
  /** Where a participant's keystrokes go. Absent means this surface never writes. */
  readonly onKeystroke?: ((data: string) => void) | undefined;
  /**
   * What a change in the host's box re-enters.
   *
   * The ADAPTER's public re-fit rather than this object's, so the surface has exactly
   * one re-fit path: a resize and a caller's explicit `fitToHost()` go the same way,
   * and anything watching that path sees both. Passing the fit itself would give a
   * resize a second route to the grid.
   */
  readonly onHostResize: () => void;
}

/** One emulator's tie to one host element. */
export class TerminalHostBinding {
  readonly #onKeystroke: ((data: string) => void) | undefined;
  readonly #onHostResize: () => void;
  #terminal: Terminal | undefined;
  #hostElement: HTMLElement | undefined;
  #detachHostSizeObserver: Unsubscribe | undefined;
  #keystrokeSubscription: IDisposable | undefined;
  #isWriteEnabled = false;

  public constructor(options: TerminalHostBindingOptions) {
    this.#onKeystroke = options.onKeystroke;
    this.#onHostResize = options.onHostResize;
  }

  /** The element the emulator is currently on screen in, or `undefined`. */
  public get hostElement(): HTMLElement | undefined {
    return this.#hostElement;
  }

  public get isWriteEnabled(): boolean {
    return this.#isWriteEnabled;
  }

  /**
   * The `disableStdin` a fresh emulator is constructed with.
   *
   * Read from the same field the gate is, rather than hard-coded `true`: a surface
   * that was told the lease before its emulator existed must not have that answer
   * dropped on the floor when the emulator arrives.
   */
  public get isStdinDisabledAtBuild(): boolean {
    return !this.#isWriteEnabled;
  }

  /**
   * The library's own gate, read back rather than mirrored.
   *
   * `isWriteEnabled` is this object's field and would keep reporting whatever it was
   * set to even if the option never moved; this is the value xterm.js actually
   * consults, which is the claim worth asserting.
   */
  public get isStdinDisabled(): boolean | undefined {
    return this.#terminal?.options.disableStdin;
  }

  /** Bind a freshly built emulator: hold it for the gate, and arm the keystroke path. */
  public bindEmulator(terminal: Terminal): void {
    this.#terminal = terminal;
    if (this.#onKeystroke !== undefined) {
      this.#keystrokeSubscription = terminal.onData((data: string) => {
        if (this.#isWriteEnabled) {
          this.#onKeystroke?.(data);
        }
      });
    }
  }

  /**
   * Say whether this participant may type. The answer is the lease's, folded from the
   * log and handed down. Disabled is the default and the fallback: 8.8 makes watch
   * mode what every non-holder gets, and a guess here would guess in the direction
   * that lets somebody type into a shell they do not hold.
   */
  public setWriteEnabled(isWriteEnabled: boolean): void {
    this.#isWriteEnabled = isWriteEnabled;
    if (this.#terminal !== undefined) {
      this.#terminal.options.disableStdin = !isWriteEnabled;
    }
  }

  /** Record the host the emulator is now on, and re-fit whenever its box changes. */
  public showOn(hostElement: HTMLElement): void {
    this.#hostElement = hostElement;
    this.#detachHostSizeObserver?.();
    this.#detachHostSizeObserver = observeElementResize(hostElement, () => {
      this.#onHostResize();
    });
  }

  /** Take the emulator off screen. The emulator itself survives — only the tie ends. */
  public detach(): void {
    this.#detachHostSizeObserver?.();
    this.#detachHostSizeObserver = undefined;
    this.#hostElement = undefined;
  }

  /**
   * Final: the host tie and the keystroke path both end.
   *
   * The emulator handle is dropped rather than disposed — the adapter owns that, and
   * disposing it from two places leaves a half-torn instance behind.
   */
  public dispose(): void {
    this.detach();
    this.#keystrokeSubscription?.dispose();
    this.#keystrokeSubscription = undefined;
    this.#terminal = undefined;
  }
}
