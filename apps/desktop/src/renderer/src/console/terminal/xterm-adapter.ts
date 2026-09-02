// The console's own wrapper over `@xterm/xterm`, and the renderer pool it draws
// from.
//
// `Spec-023 §Console Libraries` ADOPTS `@xterm/xterm` 6.0.0 with the WebGL, fit,
// search, unicode11, and serialize addons and OWN-BUILDS the React wrapper and the
// renderer pool, under five constraints. Each one is a decision this module makes
// rather than a note a reviewer has to remember:
//
//   1. **Bound the CONTEXTS this page creates, not the terminals drawing on one.**
//      `WebglAddon.dispose()` does not release its WebGL2 context — the addon
//      calls `loseContext()` nowhere, verified in the pinned package rather than
//      taken from xterm.js issue #6068 — and Chromium drops the OLDEST context
//      past sixteen. So a teardown gives the ledger no allowance back
//      (`renderer-pool.ts` says why at length): only the two arms where a context
//      demonstrably does not exist do, and past the cap a terminal opens on the
//      DOM renderer rather than taking a context from one still on screen. An
//      adapter keeps its emulator across a detach so a remount reattaches instead
//      of minting a second.
//   2. **`onContextLoss` falls back to DOM.** The addon fires it three seconds
//      after `webglcontextlost` with no restoration, so the fallback is permanent
//      for that instance — and the allowance IS reclaimed there, because the host
//      destroyed the context rather than this code letting go of one.
//   3. **`allowProposedApi` only for Unicode 11.** Only the `unicode` getter calls
//      `_checkProposedApi()`; every other API here is stable.
//   4. **Own link provider with the scheme guard.** A program can print a
//      `javascript:` link, so `allowNonHttpProtocols` stays false AND the handler
//      re-checks the scheme against a closed allow-list on the way out.
//   5. **`disableStdin` plus wire-level gating for watchers.** Watch mode is the
//      default, so stdin starts disabled and opens only when the lease says this
//      participant holds the shell — and the keystrokes go to the wire, never into
//      the local buffer, because the daemon is what echoes a shared shell.
//
// WHAT IT DOES NOT DO. It never decides who may write: it is handed that answer by
// a surface that read it off the lease. An emulator that consulted a lease would
// be a second place eligibility is decided, and the renderer decides it nowhere.

// THE LIBRARY'S OWN SHEET IS IMPORTED HERE, not from the family barrel where the
// family's stylesheets live. This module is the lazy chunk's entry
// (`emulator-loader.ts` says why), and the sheet is the emulator's geometry: an
// import at the barrel — which the seat board reaches statically — would put the
// grid's CSS in the document the operator waits for while the code that draws the
// grid arrived on demand. Landing both on the same edge is also what keeps a
// surface from ever rendering a grid whose geometry did not come with it.
import "@xterm/xterm/css/xterm.css";

import { Terminal, type IDisposable, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "./constants.js";
import { TerminalRendererPool, terminalRendererPool } from "./renderer-pool.js";

/** Which renderer an instance ended up with. Rendered, never inferred. */
export const TERMINAL_RENDERER_MODES = ["webgl", "dom"] as const;

export type TerminalRendererMode = (typeof TERMINAL_RENDERER_MODES)[number];

/** URL schemes a terminal link may be activated with. Closed, and short. */
export const TERMINAL_LINK_SCHEMES = ["http:", "https:"] as const;

/**
 * The href a terminal link may be opened at, or `undefined` for one that may not.
 *
 * Ours, beside the library's `allowNonHttpProtocols: false`. Two guards because a
 * program controls what it prints: the library setting decides which links reach
 * the handler, and this decides which the handler acts on. Exported as a pure
 * function so the rule can be driven with the strings an attack would use rather
 * than inferred from a mouse event nobody can dispatch.
 */
export function allowedTerminalLinkHref(text: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  return TERMINAL_LINK_SCHEMES.some((scheme) => scheme === parsed.protocol)
    ? parsed.href
    : undefined;
}

export interface XtermTerminalAdapterOptions {
  /** The shared terminal this adapter is a view of. One per session in V1. */
  readonly terminalId: string;
  readonly pool?: TerminalRendererPool | undefined;
  readonly scrollbackLines?: number | undefined;
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
  readonly #pool: TerminalRendererPool;
  readonly #scrollbackLines: number;
  readonly #onKeystroke: ((data: string) => void) | undefined;
  readonly #onActivateLink: ((url: string) => void) | undefined;
  readonly #subscriptions: IDisposable[] = [];
  // Built with the emulator and DROPPED WITH IT, rather than owned for the
  // adapter's whole life. An addon holds the terminal it was loaded into, so a
  // long-lived field here keeps the emulator — and its twelve-bytes-per-cell
  // buffer — reachable through this object after `dispose()` nulled `#terminal`,
  // which is a disposal that frees nothing. Measured: holding them left almost all
  // of a full instance's bytes retained across a teardown, which is what
  // `test/console/budget/heap-terminal.test.ts` gates against the budget row.
  #fitAddon: FitAddon | undefined;
  #searchAddon: SearchAddon | undefined;
  #serializeAddon: SerializeAddon | undefined;
  #terminal: Terminal | undefined;
  #webglAddon: WebglAddon | undefined;
  #rendererMode: TerminalRendererMode = "dom";
  #hostElement: HTMLElement | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #isWriteEnabled = false;
  #isDisposed = false;

  public constructor(options: XtermTerminalAdapterOptions) {
    this.#terminalId = options.terminalId;
    this.#pool = options.pool ?? terminalRendererPool;
    this.#scrollbackLines = options.scrollbackLines ?? TERMINAL_DEFAULT_SCROLLBACK_LINES;
    this.#onKeystroke = options.onKeystroke;
    this.#onActivateLink = options.onActivateLink;
  }

  public get terminalId(): string {
    return this.#terminalId;
  }

  public get rendererMode(): TerminalRendererMode {
    return this.#rendererMode;
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
   */
  public attach(hostElement: HTMLElement): void {
    if (this.#isDisposed) {
      return;
    }
    const terminal = this.#terminal ?? this.#buildTerminal();
    if (this.#hostElement === hostElement) {
      this.fitToHost();
      return;
    }
    this.#hostElement = hostElement;
    terminal.open(hostElement);
    this.#selectRenderer(terminal);
    this.#observeHostSize(hostElement);
    this.fitToHost();
  }

  /** Take the emulator off screen and keep it, with its scrollback and its renderer. */
  public detach(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#hostElement = undefined;
  }

  /**
   * Say whether this participant may type. The answer is the lease's, folded from
   * the log and handed down. Disabled is the default and the fallback: 8.8 makes
   * watch mode what every non-holder gets, and a guess here would guess in the
   * direction that lets somebody type into a shell they do not hold.
   */
  public setWriteEnabled(isWriteEnabled: boolean): void {
    this.#isWriteEnabled = isWriteEnabled;
    if (this.#terminal !== undefined) {
      this.#terminal.options.disableStdin = !isWriteEnabled;
    }
  }

  public get isWriteEnabled(): boolean {
    return this.#isWriteEnabled;
  }

  /**
   * The library's own gate, read back rather than mirrored.
   *
   * `isWriteEnabled` is this wrapper's field and would keep reporting whatever it
   * was set to even if the option never moved; this is the value xterm.js actually
   * consults, which is the claim worth asserting.
   */
  public get isStdinDisabled(): boolean | undefined {
    return this.#terminal?.options.disableStdin;
  }

  /** Write daemon output into the buffer. The only way bytes reach the screen. */
  public write(chunk: string, onWritten?: (() => void) | undefined): void {
    this.#terminal?.write(chunk, onWritten);
  }

  /** Re-measure the grid against its host. No timer: the observer drives it. */
  public fitToHost(): void {
    if (this.#terminal === undefined || this.#hostElement === undefined) {
      return;
    }
    try {
      this.#fitAddon?.fit();
    } catch {
      // A host with no measurable box (detached, or zero-sized while a layout
      // settles) makes the fit addon's own division undefined. Skipping is
      // self-healing — the observer fires again — and throwing would take the pane
      // down for a transient layout.
    }
  }

  /** The visible grid, as text. `Spec-023 §Console Libraries`' serialize addon. */
  public serialize(): string {
    return this.#serializeAddon?.serialize() ?? "";
  }

  /** Find text in the scrollback. The search addon, exposed rather than re-implemented. */
  public findNext(query: string): boolean {
    return this.#searchAddon?.findNext(query) ?? false;
  }

  /**
   * Final. Releases the observer, every subscription, this terminal's hold on its
   * renderer, and the emulator — in that order, because the addon's disposal runs
   * inside the terminal's and doing it twice leaves a half-torn instance behind.
   *
   * `release` and not `reclaim`: the context this instance created survives its
   * addon, so the page's allowance stays spent. Handing it back here is the churn
   * bug — an unbounded run of contexts under a ledger that never rises, ending in
   * Chromium taking the renderer from an older terminal still on screen.
   */
  public dispose(): void {
    if (this.#isDisposed) {
      return;
    }
    this.#isDisposed = true;
    this.detach();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#pool.release(this.#terminalId);
    this.#webglAddon = undefined;
    this.#rendererMode = "dom";
    this.#terminal?.dispose();
    this.#terminal = undefined;
    // After the terminal, because `Terminal.dispose()` is what disposes the addons
    // it loaded; clearing the references first would leave that disposal to run
    // against objects nothing else could reach.
    this.#fitAddon = undefined;
    this.#searchAddon = undefined;
    this.#serializeAddon = undefined;
  }

  #buildTerminal(): Terminal {
    const options: ITerminalOptions = {
      scrollback: this.#scrollbackLines,
      // Only the `unicode` getter is proposed API; the link, marker, decoration,
      // and buffer surfaces this wrapper uses are all stable.
      allowProposedApi: true,
      // Watch mode is the default, so the emulator starts unable to accept input
      // and is opened up only by a lease the log established.
      disableStdin: !this.#isWriteEnabled,
      // THE ONLY TEXTUAL OUTPUT THIS SURFACE HAS. The grid is a canvas under the
      // WebGL renderer and a wall of positioned spans under the DOM one, and
      // neither is readable; xterm.js builds the accessible row list and the live
      // region that make it readable ONLY under this option, whose default is off.
      // `XtermHost.tsx` names the region and deliberately announces nothing of its
      // own, so with this off a screen reader reaches a named group with no
      // contents — the shell would be unreadable rather than merely unlabelled.
      screenReaderMode: true,
      convertEol: true,
      linkHandler: {
        // The library's own gate: a non-HTTP link never reaches `activate`.
        allowNonHttpProtocols: false,
        activate: (_event: MouseEvent, text: string): void => {
          this.#activateLink(text);
        },
      },
    };
    const terminal = new Terminal(options);
    this.#fitAddon = new FitAddon();
    this.#searchAddon = new SearchAddon();
    this.#serializeAddon = new SerializeAddon();
    terminal.loadAddon(this.#fitAddon);
    terminal.loadAddon(this.#searchAddon);
    terminal.loadAddon(this.#serializeAddon);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    if (this.#onKeystroke !== undefined) {
      this.#subscriptions.push(
        terminal.onData((data: string) => {
          // Gated here as well as by `disableStdin`: the option stops the DOM
          // listener, this stops a programmatic write. The expensive mistake on a
          // shared shell is sending a keystroke nobody was allowed to send.
          if (this.#isWriteEnabled) {
            this.#onKeystroke?.(data);
          }
        }),
      );
    }
    this.#terminal = terminal;
    return terminal;
  }

  /**
   * Take a WebGL renderer if the page can spare a context, and fall back to DOM if
   * it cannot — or if the host has no WebGL2 at all, which is what the addon
   * throws for.
   */
  #selectRenderer(terminal: Terminal): void {
    if (this.#webglAddon !== undefined || !this.#pool.acquire(this.#terminalId)) {
      return;
    }
    try {
      const webglAddon = new WebglAddon();
      this.#subscriptions.push(
        webglAddon.onContextLoss(() => {
          this.#fallBackToDomRenderer(webglAddon);
        }),
      );
      terminal.loadAddon(webglAddon);
      this.#webglAddon = webglAddon;
      this.#rendererMode = "webgl";
    } catch {
      // No WebGL2 on this host: the addon threw before it made one. Reclaimed
      // rather than released, so a later terminal is not counted out by a context
      // that was never created.
      this.#pool.reclaim(this.#terminalId);
      this.#rendererMode = "dom";
    }
  }

  /**
   * The context is gone and the addon does not restore it, so this instance is a
   * DOM terminal from here on. This is the one teardown-shaped path that reclaims:
   * the host destroyed the context rather than this code dropping a reference to
   * it, so counting it would spend the page's allowance on something that no
   * longer exists.
   */
  #fallBackToDomRenderer(webglAddon: WebglAddon): void {
    if (this.#webglAddon !== webglAddon) {
      return;
    }
    webglAddon.dispose();
    this.#webglAddon = undefined;
    this.#rendererMode = "dom";
    this.#pool.reclaim(this.#terminalId);
  }

  #observeHostSize(hostElement: HTMLElement): void {
    this.#resizeObserver?.disconnect();
    if (typeof ResizeObserver === "undefined") {
      // A host without the observer re-fits when the surface asks. No interval is
      // started: a polling terminal would be the console's only always-on timer.
      this.#resizeObserver = undefined;
      return;
    }
    const resizeObserver = new ResizeObserver(() => {
      this.fitToHost();
    });
    resizeObserver.observe(hostElement);
    this.#resizeObserver = resizeObserver;
  }

  #activateLink(text: string): void {
    const href = allowedTerminalLinkHref(text);
    if (href !== undefined) {
      this.#onActivateLink?.(href);
    }
  }
}
