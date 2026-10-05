// The addons one terminal loads, the renderer it ends up on, and the order they are let go of.
//
// The WebGL budget counts contexts ever created (`renderer-pool.ts`), so a teardown returns no
// allowance; only a context that demonstrably does not exist does. Past the cap a terminal
// opens on the DOM renderer rather than take a context from one still on screen.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { TerminalRendererPool, type TerminalContextLease } from "../renderer-pool.js";

/** Which renderer an instance ended up with. Rendered, never inferred. */
export const TERMINAL_RENDERER_MODES = ["webgl", "dom"] as const;

/** The renderer an instance is on. */
export type TerminalRendererMode = (typeof TERMINAL_RENDERER_MODES)[number];

/**
 * One terminal's addons, renderer selection and teardown order. Built by the adapter, which
 * hands it the emulator to load into.
 */
export class TerminalAddonSuite {
  readonly #terminalId: string;
  readonly #pool: TerminalRendererPool;
  #fitAddon: FitAddon | undefined;
  #searchAddon: SearchAddon | undefined;
  #serializeAddon: SerializeAddon | undefined;
  #webglAddon: WebglAddon | undefined;
  // The pool's lease for the context this suite created. The hand-backs name it, so a
  // sibling pane on the same session keeps its own context.
  #contextLease: TerminalContextLease | undefined;
  #contextLossSubscription: { dispose: () => void } | undefined;
  #rendererMode: TerminalRendererMode = "dom";
  // Set once and never reset when the host takes the context away. The addon fires
  // `onContextLoss` three seconds after `webglcontextlost` with no restoration, so the
  // fallback is permanent. The selection reads this first: the fallback also clears the addon
  // and returns the allowance, so a later `attach()` would otherwise take a second context.
  #hasLostWebglContext = false;
  // Emitted on change, because the mode moves again when the host takes the context away.
  readonly #rendererModeChanges = new Emitter<TerminalRendererMode>("terminal renderer mode");

  /** Builds the suite for one terminal, drawing its WebGL allowance from `pool`. */
  public constructor(terminalId: string, pool: TerminalRendererPool) {
    this.#terminalId = terminalId;
    this.#pool = pool;
  }

  /** The renderer this instance is on now. */
  public get rendererMode(): TerminalRendererMode {
    return this.#rendererMode;
  }

  /**
   * Be told which renderer this instance is on, now and on every change. The current mode is
   * delivered synchronously, so read-then-subscribe cannot hold a stale value.
   */
  public subscribeToRendererMode(sink: (mode: TerminalRendererMode) => void): Unsubscribe {
    sink(this.#rendererMode);
    return this.#rendererModeChanges.subscribe(sink);
  }

  /**
   * Build and load the addons a fresh emulator gets. The Unicode 11 version is set here,
   * beside the addon that needs the adapter's `allowProposedApi`.
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
   * Take a WebGL renderer if the page can spare a context, else the DOM one; the DOM renderer
   * is also the outcome on a host with no WebGL2, where the addon throws. The context-loss
   * flag is read first: after a loss the addon is cleared and the allowance returned, so the
   * other checks would pass and a remount would build a second addon.
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
      // No WebGL2: the addon threw before making a context, so reclaim rather than release.
      this.#pool.reclaim(contextLease);
      this.#contextLease = undefined;
      this.#setRendererMode("dom");
    }
  }

  /**
   * Re-measure the grid. `@xterm/addon-fit` 0.11.0 returns without resizing for a host it
   * cannot measure (no parent, a zero cell, a size that parses to `NaN`), so a host that is
   * detached or zero-sized while a layout settles needs no guard here.
   */
  public fitGrid(): void {
    this.#fitAddon?.fit();
  }

  /** The visible grid, as text, through the serialize addon. */
  public serialize(): string {
    return this.#serializeAddon?.serialize() ?? "";
  }

  /** Find text in the scrollback. The search addon, exposed rather than re-implemented. */
  public findNext(query: string): boolean {
    return this.#searchAddon?.findNext(query) ?? false;
  }

  /**
   * Everything the teardown does before the emulator is disposed. The sinks are cleared first
   * because `Emitter` re-raises what a sink threw, which could abort the teardown between the
   * pool release and the emulator's disposal. `release`, not `reclaim`: the context outlives
   * its addon, so the allowance stays spent.
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
   * Everything the teardown does after it. `Terminal.dispose()` disposes the addons it
   * loaded, so these references are cleared only afterwards. Held longer they keep the
   * emulator reachable; measured, almost all of a full instance's bytes stayed retained
   * (`tests/endurance/xterm-adapter.test.ts` holds this).
   */
  public dropAfterEmulatorDisposal(): void {
    this.#fitAddon = undefined;
    this.#searchAddon = undefined;
    this.#serializeAddon = undefined;
  }

  /**
   * The context is gone and the addon does not restore it, so this instance is a DOM
   * terminal from here on. It reclaims because the host destroyed the context. Every state
   * change, the reclaim included, precedes the notification: `Emitter` re-raises a failing
   * sink, and a reclaim placed after it would be skipped, leaving the pool counting a
   * context the host destroyed.
   */
  #fallBackToDomRenderer(webglAddon: WebglAddon): void {
    if (this.#webglAddon !== webglAddon) {
      return;
    }
    webglAddon.dispose();
    this.#webglAddon = undefined;
    // The one write that makes the fallback permanent; the addon and context references
    // are reversible by a remount.
    this.#hasLostWebglContext = true;
    if (this.#contextLease !== undefined) {
      this.#pool.reclaim(this.#contextLease);
      this.#contextLease = undefined;
    }
    // Last: a sink that throws reaches the caller, and the state is already consistent.
    this.#setRendererMode("dom");
  }

  /**
   * The one writer of `#rendererMode`. Emits only on change: the selection's catch arm
   * settles on the constructed mode, and announcing that would report a fallback that
   * never happened.
   */
  #setRendererMode(rendererMode: TerminalRendererMode): void {
    if (this.#rendererMode === rendererMode) {
      return;
    }
    this.#rendererMode = rendererMode;
    this.#rendererModeChanges.emit(rendererMode);
  }
}
