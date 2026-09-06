// The addons one terminal loads, the renderer it ends up on, and the order they are
// let go of.
//
// Its own module rather than a section inside `xterm-adapter.ts`, on
// `renderer-pool.ts`'s and `link-guard.ts`'s reason: the adapter's job is to
// COMPOSE one terminal surface, and this owns a different question — which library
// objects that surface loads, which of them the page's WebGL budget lets it keep,
// and what happens when the host takes a context away. Every constraint below is a
// property of `@xterm/xterm`'s own behaviour, so it is testable through the adapter
// against the real library rather than against a mirror of it.
//
// TWO OF `Spec-023 §Console Libraries`' FIVE CONSTRAINTS LIVE HERE, and each one is
// a line of code rather than a note a reviewer has to remember:
//
//   1. **Bound the CONTEXTS this page creates, not the terminals drawing on one.**
//      `WebglAddon.dispose()` does not release its WebGL2 context — the addon calls
//      `loseContext()` nowhere, verified in the pinned package rather than taken
//      from xterm.js issue #6068 — and Chromium drops the OLDEST context past
//      sixteen. So a teardown gives the ledger no allowance back
//      (`renderer-pool.ts` says why at length): only the two arms where a context
//      demonstrably does not exist do, and past the cap a terminal opens on the DOM
//      renderer rather than taking a context from one still on screen.
//   2. **`onContextLoss` falls back to DOM, permanently and for this INSTANCE.** The
//      addon fires it three seconds after `webglcontextlost` with no restoration, so
//      the fallback is permanent — which the code has to remember, because the
//      fallback also clears the addon and hands the allowance back, and a later
//      `attach()` to a different host re-enters the selection and would otherwise
//      find every condition for taking a second context satisfied. So the loss is
//      recorded on the instance and the selection reads it first. The allowance IS
//      still reclaimed, because the host destroyed the context rather than this code
//      letting go of one; the ledger is about the PAGE, and this flag is about this
//      terminal.
//
// THE ADDONS ARE DROPPED WITH THE EMULATOR, not held for the suite's whole life. An
// addon holds the terminal it was loaded into, so a long-lived reference keeps the
// emulator — and its twelve-bytes-per-cell buffer — reachable after the adapter
// nulled its own handle, which is a disposal that frees nothing. Measured: holding
// them left almost all of a full instance's bytes retained across a teardown, which
// is what `test/console/endurance/terminal-endurance.test.ts` holds this object to.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

import { Emitter, type Unsubscribe } from "../../core/index.js";
import { TerminalRendererPool, type TerminalContextLease } from "./renderer-pool.js";

/** Which renderer an instance ended up with. Rendered, never inferred. */
export const TERMINAL_RENDERER_MODES = ["webgl", "dom"] as const;

export type TerminalRendererMode = (typeof TERMINAL_RENDERER_MODES)[number];

/**
 * One terminal's addons, its renderer selection, and its teardown order.
 *
 * Constructed by the adapter and never reached from outside it: the suite holds no
 * emulator of its own, it is handed one to load into.
 */
export class TerminalAddonSuite {
  readonly #terminalId: string;
  readonly #pool: TerminalRendererPool;
  #fitAddon: FitAddon | undefined;
  #searchAddon: SearchAddon | undefined;
  #serializeAddon: SerializeAddon | undefined;
  #webglAddon: WebglAddon | undefined;
  // The ledger's receipt for the context THIS suite created, held so the two
  // hand-backs name that context rather than the terminal. A pane and its sibling
  // on the same session hold one each, so a teardown that named the terminal would
  // retire whichever record the ledger happened to hold and leave the other pane
  // drawing on a context nothing counts.
  #contextLease: TerminalContextLease | undefined;
  #contextLossSubscription: { dispose: () => void } | undefined;
  #rendererMode: TerminalRendererMode = "dom";
  // Whether this instance has already had a context taken away from it. Written in
  // exactly one place and never reset: the adapter's `dispose()` ends the instance,
  // so a remount that reuses it is the same terminal and gets the same answer.
  #hasLostWebglContext = false;
  // The mode settles inside the selection and can move again whenever the host takes
  // the context away, so a consumer that COPIED it once reported `webgl` over a
  // terminal that had already fallen back to the DOM renderer.
  readonly #rendererModeChanges = new Emitter<TerminalRendererMode>("terminal renderer mode");

  public constructor(terminalId: string, pool: TerminalRendererPool) {
    this.#terminalId = terminalId;
    this.#pool = pool;
  }

  public get rendererMode(): TerminalRendererMode {
    return this.#rendererMode;
  }

  /**
   * Be told which renderer this instance is on, now and whenever that changes.
   *
   * The current mode is delivered synchronously on subscribe, which is the point
   * rather than a convenience: a consumer that read `rendererMode` and then
   * subscribed would hold a value from before its own subscription — the
   * copied-once bug in a second shape.
   */
  public subscribeToRendererMode(sink: (mode: TerminalRendererMode) => void): Unsubscribe {
    sink(this.#rendererMode);
    return this.#rendererModeChanges.subscribe(sink);
  }

  /**
   * Build and load the addons a fresh emulator gets.
   *
   * `allowProposedApi` is the adapter's, and only the `unicode` getter needs it —
   * every other API this family touches is stable — so the version is set here,
   * where the addon that provides it is loaded.
   */
  public loadInto(terminal: Terminal): void {
    this.#fitAddon = new FitAddon();
    this.#searchAddon = new SearchAddon();
    this.#serializeAddon = new SerializeAddon();
    terminal.loadAddon(this.#fitAddon);
    terminal.loadAddon(this.#searchAddon);
    terminal.loadAddon(this.#serializeAddon);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
  }

  /**
   * Take a WebGL renderer if the page can spare a context, and fall back to DOM if
   * it cannot — or if the host has no WebGL2 at all, which is what the addon throws
   * for.
   *
   * THE CONTEXT-LOSS FLAG IS READ FIRST, before the addon check and before the
   * ledger is asked. A lost context clears the addon and reclaims the slot, so on
   * the next `attach()` to a different host the other two conditions both say yes:
   * without this the instance would build a second addon after a fallback its own
   * documentation calls permanent, and churn a context per remount.
   */
  public selectRendererFor(terminal: Terminal): void {
    if (this.#hasLostWebglContext || this.#webglAddon !== undefined) {
      return;
    }
    const contextLease = this.#pool.acquire(this.#terminalId);
    if (contextLease === undefined) {
      return;
    }
    this.#contextLease = contextLease;
    try {
      const webglAddon = new WebglAddon();
      this.#contextLossSubscription = webglAddon.onContextLoss(() => {
        this.#fallBackToDomRenderer(webglAddon);
      });
      terminal.loadAddon(webglAddon);
      this.#webglAddon = webglAddon;
      this.#setRendererMode("webgl");
    } catch {
      // No WebGL2 on this host: the addon threw before it made one. Reclaimed rather
      // than released, so a later terminal is not counted out by a context that was
      // never created.
      this.#pool.reclaim(contextLease);
      this.#contextLease = undefined;
      this.#setRendererMode("dom");
    }
  }

  /**
   * Re-measure the grid. The fit addon's own division is undefined for a host with
   * no measurable box, and skipping is self-healing — the observer fires again —
   * where throwing would take the pane down for a transient layout.
   */
  public fitGrid(): void {
    try {
      this.#fitAddon?.fit();
    } catch {
      // A host with no measurable box, detached or zero-sized while a layout settles.
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
   * Everything the teardown does BEFORE the emulator is disposed.
   *
   * The sink set is cleared first: `Emitter` re-raises what a sink threw, so a
   * subscriber still attached could abort the teardown between the pool release and
   * the emulator's disposal — a leak caused by the notification. The mode reset
   * below therefore reaches an empty sink set by construction.
   *
   * `release` and not `reclaim`: the context this instance created survives its
   * addon, so the page's allowance stays spent. Handing it back here is the churn
   * bug — an unbounded run of contexts under a ledger that never rises, ending in
   * Chromium taking the renderer from an older terminal still on screen.
   */
  public releaseBeforeEmulatorDisposal(): void {
    this.#rendererModeChanges.clear();
    this.#contextLossSubscription?.dispose();
    this.#contextLossSubscription = undefined;
    if (this.#contextLease !== undefined) {
      this.#pool.release(this.#contextLease);
      this.#contextLease = undefined;
    }
    this.#webglAddon = undefined;
    this.#setRendererMode("dom");
  }

  /**
   * Everything the teardown does AFTER it, and why the split exists.
   *
   * `Terminal.dispose()` is what disposes the addons it loaded; clearing these
   * references first would leave that disposal to run against objects nothing else
   * could reach.
   */
  public dropAfterEmulatorDisposal(): void {
    this.#fitAddon = undefined;
    this.#searchAddon = undefined;
    this.#serializeAddon = undefined;
  }

  /**
   * The context is gone and the addon does not restore it, so this instance is a DOM
   * terminal from here on. This is the one teardown-shaped path that reclaims: the
   * host destroyed the context rather than this code dropping a reference to it, so
   * counting it would spend the page's allowance on something that no longer exists.
   *
   * EVERY STATE CHANGE HAPPENS BEFORE THE NOTIFICATION, and the ledger is the one
   * that has to. `Emitter` delivers to every sink and then re-raises what any of them
   * threw, so a consumer of `onRendererMode` that fails — a surface mid-render, a
   * diagnostic that asserted — ends this method wherever the emission sits. With the
   * reclaim after it, the fall-back was already permanent and the addon already
   * disposed while the page-wide ledger went on counting a context the host had
   * destroyed, for the life of the page: an allowance spent on nothing, which the
   * next terminal to open pays for by starting on the DOM renderer. Putting the
   * reclaim first makes the notification the last thing this method does, and a
   * failure in it can no longer leave the ledger disagreeing with the GPU.
   */
  #fallBackToDomRenderer(webglAddon: WebglAddon): void {
    if (this.#webglAddon !== webglAddon) {
      return;
    }
    webglAddon.dispose();
    this.#webglAddon = undefined;
    // The one write. Everything around it is reversible by a remount — the addon
    // reference and the pool slot both are — and this is what makes the fallback the
    // permanent thing the header above claims it is.
    this.#hasLostWebglContext = true;
    if (this.#contextLease !== undefined) {
      this.#pool.reclaim(this.#contextLease);
      this.#contextLease = undefined;
    }
    // Last, and re-raising: the invariant above is already restored, so what a sink
    // throws reaches the caller instead of being swallowed here.
    this.#setRendererMode("dom");
  }

  /**
   * The one place `#rendererMode` is written, so no path moves it silently. Emission
   * is conditional on the value actually CHANGING: the selection's catch arm settles
   * on the constructed mode, and announcing that would report a fallback that never
   * happened.
   */
  #setRendererMode(rendererMode: TerminalRendererMode): void {
    if (this.#rendererMode === rendererMode) {
      return;
    }
    this.#rendererMode = rendererMode;
    this.#rendererModeChanges.emit(rendererMode);
  }
}
