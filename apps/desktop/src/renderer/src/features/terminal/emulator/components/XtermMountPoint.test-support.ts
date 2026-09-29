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

import { terminalEmulatorLoader } from "../emulator-loader.js";
import { terminalRendererPool } from "../renderer-pool.js";

/**
 * The hidden textarea xterm.js listens on: the emulator's one input element.
 * Resolved once, because every reading of it is about that same element.
 */
export function emulatorInputOf(mountElement: HTMLElement): HTMLTextAreaElement {
  const textarea = mountElement.querySelector("textarea");
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
export function typeOneCharacter(mountElement: HTMLElement): void {
  emulatorInputOf(mountElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", keyCode: 65, bubbles: true, cancelable: true }),
  );
}

export function emulatorElementOf(container: HTMLElement): HTMLElement {
  const mountElement = container.querySelector(".meridian-terminal-mount-point__mount-element");
  if (!(mountElement instanceof HTMLElement)) {
    throw new Error("XtermMountPoint rendered no mount element");
  }
  return mountElement;
}

export function mountPointBoxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector(".meridian-terminal-mount-point");
  if (!(box instanceof HTMLElement)) {
    throw new Error("XtermMountPoint rendered no box");
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
 * Whether the LIBRARY thinks this terminal may be typed into.
 *
 * xterm.js mirrors its own `disableStdin` option onto the hidden textarea it listens on
 * — at open and again on every change of that option — so this reads the emulator's gate
 * rather than a field of ours that was set beside it. It is the only place the write
 * gate becomes observable outside the adapter, and it is what makes "the gate reached
 * the emulator" a claim a test can hold.
 */
export function isEmulatorAcceptingInput(mountElement: HTMLElement): boolean {
  return !emulatorInputOf(mountElement).readOnly;
}

/**
 * Render a mount point and wait until its emulator has attached and settled a renderer.
 *
 * The wait is on the ATTRIBUTE rather than on the mount element, and the two are
 * different commits: the mount element appears when the chunk lands, and the adapter is built
 * by the effect that runs after that commit. Waiting on the element alone returns in
 * between and reads the mount-pending value — which is the whole subject of the
 * renderer-mode suite, and is a latent race for every other case that reads the box.
 * The stronger wait is the one every suite gets, because it strictly follows the weaker
 * one: no mount point reaches a settled mode without its mount element already on screen.
 */
export async function renderSettledMountPoint(element: React.JSX.Element): Promise<RenderResult> {
  const view = render(element);
  await waitFor(() => {
    expect(mountPointBoxOf(view.container).getAttribute("data-renderer")).not.toBe("pending");
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
export const COMPONENT_TERMINAL_IDS: readonly string[] = ["terminal-1", "terminal-2"];
