// The console's own wrapper over `@xterm/xterm`: one terminal surface, composed.
//
// `Spec-023 §Console Libraries` ADOPTS `@xterm/xterm` 6.0.0 with the WebGL, fit,
// search, unicode11, serialize, and web-links addons and OWN-BUILDS the React
// wrapper, the renderer pool, and the link scheme guard, under five constraints.
// Each one is a decision this family makes rather than a note a reviewer has to
// remember, and each lives with the code that keeps it:
//
//   1. Bound the CONTEXTS this page creates, not the terminals drawing on one —
//      `renderer-pool.ts` for the ledger, `xterm-addons.ts` for the selection.
//   2. `onContextLoss` falls back to DOM, permanently and for this INSTANCE —
//      `xterm-addons.ts`.
//   3. **`allowProposedApi` only for Unicode 11.** Only the `unicode` getter calls
//      `_checkProposedApi()`; every other API this family uses is stable. The option
//      is set in this file, because construction is what this file owns; the addon
//      that needs it is loaded next door.
//   4. Every activatable link passes the scheme guard — `link-guard.ts` owns the
//      rule and `xterm-links.ts` builds both paths through it.
//   5. `disableStdin` plus wire-level gating for watchers — `xterm-host-binding.ts`.
//
// WHAT THIS FILE OWNS, AND WHY THE LINE IS THERE. The emulator's LIFE: built on
// first attach, kept across a detach so a remount reattaches instead of minting a
// second, and disposed exactly once in an order the pieces cannot arrange between
// themselves. Everything a terminal surface also needs — which addons it loads and
// which renderer it gets, how a link is activated, how it is sized and gated — is a
// question with its own answer and its own module, and this class composes the three
// rather than restating them.
//
// WHAT IT DOES NOT DO. It never decides who may write: it is handed that answer by a
// surface that read it off the lease. An emulator that consulted a lease would be a
// second place eligibility is decided, and the renderer decides it nowhere.

// THE LIBRARY'S OWN SHEET IS IMPORTED HERE, not from the family barrel where the
// family's stylesheets live. This module is the lazy chunk's entry
// (`emulator-loader.ts` says why), and the sheet is the emulator's geometry: an
// import at the barrel — which the seat board reaches statically — would put the
// grid's CSS in the document the operator waits for while the code that draws the
// grid arrived on demand. Landing both on the same edge is also what keeps a
// surface from ever rendering a grid whose geometry did not come with it.
import "@xterm/xterm/css/xterm.css";

import { Terminal, type ITerminalOptions } from "@xterm/xterm";

import { TERMINAL_DEFAULT_SCROLLBACK_LINES, type Unsubscribe } from "../../core/index.js";
import { TerminalRendererPool, terminalRendererPool } from "./renderer-pool.js";
import { TerminalAddonSuite, type TerminalRendererMode } from "./xterm-addons.js";
import { TerminalHostBinding } from "./xterm-host-binding.js";
import { buildTerminalLinkHandler, buildTerminalWebLinksAddon } from "./xterm-links.js";
import { applyDeclaredMonospaceFamily } from "./xterm-typeface.js";

// Re-exported from the module that DECLARES it, so a consumer that names the mode
// keeps naming it through the emulator's own entry point — which is also the only
// module `emulator-loader.ts`'s `typeof import(...)` narrows against.
export type { TerminalRendererMode } from "./xterm-addons.js";

export interface XtermTerminalAdapterOptions {
  /** The shared terminal this adapter is a view of. One per session in V1. */
  readonly terminalId: string;
  readonly pool?: TerminalRendererPool | undefined;
  readonly scrollbackLines?: number | undefined;
  /**
   * Whether the lease ALREADY says this participant may type, at build time.
   *
   * Watch mode is the default, so absent means shut. It is a construction input
   * rather than a call the caller makes afterwards because a surface builds a fresh
   * emulator for every terminal id and every capability change, under a lease that
   * did not move with it: a binding corrected after construction is a binding that
   * was briefly wrong, and one whose correction a caller can forget to make.
   */
  readonly isWriteEnabled?: boolean | undefined;
  /** Where a participant's keystrokes go. Absent means this surface never writes. */
  readonly onKeystroke?: ((data: string) => void) | undefined;
  /** Where an allowed link goes. Absent means links render and never activate. */
  readonly onActivateLink?: ((url: string) => void) | undefined;
}

/**
 * One terminal surface: the emulator, its addons, its renderer, its teardown.
 *
 * Constructed outside a render body and disposed by whoever constructed it. The
 * emulator survives `detach()`, so a pane that moves keeps its scrollback and its
 * renderer; only `dispose()` is final.
 */
export class XtermTerminalAdapter {
  readonly #terminalId: string;
  readonly #scrollbackLines: number;
  readonly #onActivateLink: ((url: string) => void) | undefined;
  readonly #addons: TerminalAddonSuite;
  readonly #hostBinding: TerminalHostBinding;
  // Built on the first attach and DROPPED WITH THE ADAPTER. The three collaborators
  // each hold what they need of it and let go in the same teardown, so no reference
  // to a disposed emulator — and its twelve-bytes-per-cell buffer — outlives it.
  #terminal: Terminal | undefined;
  #isDisposed = false;

  public constructor(options: XtermTerminalAdapterOptions) {
    this.#terminalId = options.terminalId;
    this.#scrollbackLines = options.scrollbackLines ?? TERMINAL_DEFAULT_SCROLLBACK_LINES;
    this.#onActivateLink = options.onActivateLink;
    this.#addons = new TerminalAddonSuite(this.#terminalId, options.pool ?? terminalRendererPool);
    this.#hostBinding = new TerminalHostBinding({
      isWriteEnabled: options.isWriteEnabled,
      onKeystroke: options.onKeystroke,
      onHostResize: () => {
        this.fitToHost();
      },
    });
  }

  public get terminalId(): string {
    return this.#terminalId;
  }

  public get rendererMode(): TerminalRendererMode {
    return this.#addons.rendererMode;
  }

  /**
   * Be told which renderer this instance is on, now and whenever that changes.
   *
   * Unsubscribing is the caller's, and disposal drops every sink regardless.
   */
  public subscribeToRendererMode(sink: (mode: TerminalRendererMode) => void): Unsubscribe {
    return this.#addons.subscribeToRendererMode(sink);
  }

  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** Whether an emulator exists yet. False before the first attach and after disposal. */
  public get isEmulatorLive(): boolean {
    return this.#terminal !== undefined;
  }

  /** Lines the buffer is holding, scrollback included. Bounded by the scrollback. */
  public get bufferLineCount(): number {
    return this.#terminal?.buffer.active.length ?? 0;
  }

  /** The scrollback ceiling this instance was built with. */
  public get scrollbackLines(): number {
    return this.#scrollbackLines;
  }

  /**
   * Put the emulator on screen. Built on first call and reused after, which is the
   * point of the pool: a remount must not mint a second context for a terminal
   * that already has one. A second host moves the emulator rather than copying it.
   *
   * THE MOVE IS THIS CLASS'S AND NOT THE LIBRARY'S, which is a fact about the pinned
   * `@xterm/xterm` 6.0.0 rather than a preference. `Terminal.open(parent)` builds the
   * emulator's element and appends it on the FIRST call; on every call after it
   * returns early — measured in the shipped bundle — leaving the element in whichever
   * parent it is already in and doing one other thing, re-pointing the library's own
   * window reference at that element's current document. So a second `open()` is not
   * a re-parent and never was: the re-append below is what actually moves the grid,
   * and the call is still made afterwards, so the library's bookkeeping is its own
   * rather than restated here.
   */
  public attach(hostElement: HTMLElement): void {
    if (this.#isDisposed) {
      return;
    }
    const terminal = this.#terminal ?? this.#buildTerminal();
    // Before the same-host return below rather than after it, so a remount onto a
    // host whose declared face has moved follows it. The call is a no-op when it
    // has not; `xterm-typeface.ts` says why that matters.
    applyDeclaredMonospaceFamily(terminal, hostElement);
    if (this.#hostBinding.hostElement === hostElement) {
      this.fitToHost();
      return;
    }
    const builtElement = terminal.element;
    if (builtElement !== undefined) {
      hostElement.append(builtElement);
    }
    terminal.open(hostElement);
    this.#addons.selectRendererFor(terminal);
    this.#hostBinding.showOn(hostElement);
    this.fitToHost();
  }

  /**
   * Take the emulator off screen and keep it, with its scrollback and its renderer.
   *
   * THE ELEMENT LEAVES WITH THE TIE. Dropping the host reference and the size
   * observer takes this adapter off the old box and takes nothing off the screen:
   * xterm's own element stays where `open()` put it, still painted, still holding
   * the emulator's data listener. A pane that detached and re-attached elsewhere
   * therefore left a live interactive terminal standing in the host it had left,
   * beside the one it moved to — two grids, one emulator, and a person able to type
   * into the ghost. The element goes with the tie, and the emulator, its scrollback,
   * and its renderer all survive: only its position in the document ends here.
   */
  public detach(): void {
    this.#terminal?.element?.remove();
    this.#hostBinding.detach();
  }

  /** Say whether this participant may type. The answer is the lease's, handed down. */
  public setWriteEnabled(isWriteEnabled: boolean): void {
    this.#hostBinding.setWriteEnabled(isWriteEnabled);
  }

  public get isWriteEnabled(): boolean {
    return this.#hostBinding.isWriteEnabled;
  }

  /** The library's own gate, read back rather than mirrored. */
  public get isStdinDisabled(): boolean | undefined {
    return this.#hostBinding.isStdinDisabled;
  }

  /** Write daemon output into the buffer. The only way bytes reach the screen. */
  public write(chunk: string, onWritten?: (() => void) | undefined): void {
    this.#terminal?.write(chunk, onWritten);
  }

  /**
   * Re-measure the grid against its host. No timer: the observer drives it.
   *
   * Guarded on both halves of the pairing, because either can be missing: an
   * emulator that has not been built yet has no grid, and one that has been detached
   * has no box. The fit itself is the addon's.
   */
  public fitToHost(): void {
    if (this.#terminal === undefined || this.#hostBinding.hostElement === undefined) {
      return;
    }
    this.#addons.fitGrid();
  }

  /** The visible grid, as text. `Spec-023 §Console Libraries`' serialize addon. */
  public serialize(): string {
    return this.#addons.serialize();
  }

  /** Find text in the scrollback. The search addon, exposed rather than re-implemented. */
  public findNext(query: string): boolean {
    return this.#addons.findNext(query);
  }

  /**
   * Final. Releases the renderer mode's sinks, this terminal's hold on its renderer,
   * the host tie and its subscriptions, and the emulator — in that order, because the
   * addons' disposal runs inside the terminal's and doing it twice leaves a half-torn
   * instance behind.
   *
   * The order is composed HERE rather than inside any one collaborator, because it is
   * a fact about all three: the suite's own two halves say what has to happen before
   * the emulator goes and what has to wait until after, and this is the only place
   * that knows when the emulator goes.
   */
  public dispose(): void {
    if (this.#isDisposed) {
      return;
    }
    this.#isDisposed = true;
    this.#addons.releaseBeforeEmulatorDisposal();
    this.#hostBinding.dispose();
    this.#terminal?.dispose();
    this.#terminal = undefined;
    this.#addons.dropAfterEmulatorDisposal();
  }

  #buildTerminal(): Terminal {
    const options: ITerminalOptions = {
      scrollback: this.#scrollbackLines,
      // Only the `unicode` getter is proposed API; the link, marker, decoration,
      // and buffer surfaces this wrapper uses are all stable.
      allowProposedApi: true,
      // Watch mode is the default, so the emulator starts unable to accept input
      // and is opened up only by a lease the log established.
      disableStdin: this.#hostBinding.isStdinDisabledAtBuild,
      // THE ONLY TEXTUAL OUTPUT THIS SURFACE HAS. The grid is a canvas under the
      // WebGL renderer and a wall of positioned spans under the DOM one, and
      // neither is readable; xterm.js builds the accessible row list and the live
      // region that make it readable ONLY under this option, whose default is off.
      // `XtermHost.tsx` names the region and deliberately announces nothing of its
      // own, so with this off a screen reader reaches a named group with no
      // contents — the shell would be unreadable rather than merely unlabelled.
      screenReaderMode: true,
      convertEol: true,
      linkHandler: buildTerminalLinkHandler(this.#onActivateLink),
    };
    const terminal = new Terminal(options);
    this.#addons.loadInto(terminal);
    if (this.#onActivateLink !== undefined) {
      // Gated on the sink, the way the keystroke path is gated on the writer: a
      // surface with nowhere to send a link would otherwise underline printed URLs
      // and swallow the click, which is an affordance that lies.
      terminal.loadAddon(buildTerminalWebLinksAddon(this.#onActivateLink));
    }
    this.#hostBinding.bindEmulator(terminal);
    this.#terminal = terminal;
    return terminal;
  }
}
