// The emulator readings the mount point's suites take, and the ledger sweep they share.
//
// Every claim about this component is asserted through an observable consequence rather
// than by reading its internals: the ledger's own readings, the emulator's own first
// child, the absence primitive's class, and the region's accessible name. Those readers
// live here because three suites take them, and because two of them — the hidden
// textarea and the settled-load wait — are subtle enough that a second copy written
// slightly differently would quietly assert something else.
//
// THE LOADER IS THE REAL ONE in all of them. A stub that resolved the adapter
// synchronously would test a component that does not exist: the whole point of the
// module under test is that the emulator's code arrives a commit later than the mount,
// and a substitute that erased that gap would pass over the bug it exists to catch.

import { act, render, waitFor, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";

import { terminalEmulatorLoader } from "./emulator-loader.js";
import { terminalRendererPool } from "./renderer-pool.js";

/**
 * The hidden textarea xterm.js listens on: the emulator's one input surface.
 * Resolved once, because every reading of it is about that same element.
 */
export function emulatorInputOf(surface: HTMLElement): HTMLTextAreaElement {
  const textarea = surface.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("the emulator rendered no input");
  }
  return textarea;
}

/**
 * Type one character, the way the library's own listener sees it. xterm.js turns a
 * keydown on that textarea into a data event, which is the only path a keystroke takes
 * to `onKeystroke` — so dispatching here makes the assertion about the wiring rather
 * than about a function reference the test already holds.
 */
export function typeOneCharacter(surface: HTMLElement): void {
  emulatorInputOf(surface).dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", keyCode: 65, bubbles: true, cancelable: true }),
  );
}

export function surfaceOf(container: HTMLElement): HTMLElement {
  const surface = container.querySelector(".meridian-terminal-host__surface");
  if (!(surface instanceof HTMLElement)) {
    throw new Error("XtermHost rendered no surface");
  }
  return surface;
}

export function hostBoxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector(".meridian-terminal-host");
  if (!(box instanceof HTMLElement)) {
    throw new Error("XtermHost rendered no box");
  }
  return box;
}

/**
 * Wait for the emulator's chunk to have been fetched AND for every callback registered
 * on it to have run.
 *
 * Awaiting the loader's own promise is what makes the wait exact rather than a guessed
 * number of ticks: the component registered its continuation on that same promise
 * first, so by the time this one settles the component's has already run, and `act`
 * flushes the state it set.
 */
export async function settleEmulatorLoad(): Promise<void> {
  await act(async () => {
    await terminalEmulatorLoader.load();
  });
}

/**
 * Whether the LIBRARY thinks this surface may be typed into.
 *
 * xterm.js mirrors its own `disableStdin` option onto the hidden textarea it listens on
 * — at open and again on every change of that option — so this reads the emulator's gate
 * rather than a field of ours that was set beside it. It is the only place the write
 * gate becomes observable outside the adapter, and it is what makes "the gate reached
 * the emulator" a claim a test can hold.
 */
export function isEmulatorAcceptingInput(surface: HTMLElement): boolean {
  return !emulatorInputOf(surface).readOnly;
}

/**
 * Render a host and wait until its emulator has attached and settled a renderer.
 *
 * The wait is on the ATTRIBUTE rather than on the surface element, and the two are
 * different commits: the surface appears when the chunk lands, and the adapter is built
 * by the effect that runs after that commit. Waiting on the element alone returns in
 * between and reads the mount-pending value — which is the whole subject of the
 * renderer-mode suite, and is a latent race for every other case that reads the box.
 * The stronger wait is the one every suite gets, because it strictly follows the weaker
 * one: no host reaches a settled mode without its surface already on screen.
 */
export async function mountHost(element: React.JSX.Element): Promise<RenderResult> {
  const view = render(element);
  await waitFor(() => {
    expect(hostBoxOf(view.container).getAttribute("data-renderer")).not.toBe("pending");
  });
  return view;
}

/**
 * Give back every page-ledger hold this file's components took.
 *
 * The ledger is module state the component reaches through the adapter's default pool.
 * A leaked hold silently narrows every later case, so the sweep is unconditional rather
 * than per-case — and it RECLAIMS rather than releases, because this environment has no
 * WebGL2 and so never made a context for a stale hold to stand for.
 */
export function reclaimComponentHolds(terminalIds: readonly string[]): void {
  for (const terminalId of terminalIds) {
    terminalRendererPool.reclaimEveryContextFor(terminalId);
  }
}

/** The terminal ids this component's suites mount under. */
export const COMPONENT_TERMINAL_IDS: readonly string[] = ["host-1", "host-2"];
