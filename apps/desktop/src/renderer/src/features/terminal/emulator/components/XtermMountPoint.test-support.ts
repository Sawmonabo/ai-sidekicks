// The emulator readings the mount point's suites take, and the ledger sweep they share. Claims
// about the component are asserted through observable consequences: the ledger's readings, the
// emulator's first child, the absence primitive's class, the region's accessible name. The
// loader is the real one, since a stub that resolved the adapter synchronously would erase the
// commit gap the component exists to handle.

import { act, render, waitFor, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";

import { terminalEmulatorLoader } from "../emulator-loader.js";
import { terminalRendererPool } from "../renderer-pool.js";

/** The hidden textarea xterm.js listens on: the emulator's one input element. */
export function emulatorInputOf(mountElement: HTMLElement): HTMLTextAreaElement {
  const textarea = mountElement.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("the emulator rendered no input");
  }
  return textarea;
}

/**
 * Type one character the way the library's listener sees it: a keydown on that textarea
 * becomes the data event, the only path a keystroke takes to `onKeystroke`.
 */
export function typeOneCharacter(mountElement: HTMLElement): void {
  emulatorInputOf(mountElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", keyCode: 65, bubbles: true, cancelable: true }),
  );
}

/** The element the emulator draws into, or a throw. */
export function emulatorElementOf(container: HTMLElement): HTMLElement {
  const mountElement = container.querySelector(".meridian-terminal-mount-point__mount-element");
  if (!(mountElement instanceof HTMLElement)) {
    throw new Error("XtermMountPoint rendered no mount element");
  }
  return mountElement;
}

/** The mount point's outer box, or a throw. */
export function mountPointBoxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector(".meridian-terminal-mount-point");
  if (!(box instanceof HTMLElement)) {
    throw new Error("XtermMountPoint rendered no box");
  }
  return box;
}

/**
 * Wait for the emulator's chunk to be fetched and every callback registered on it to run.
 * Awaiting the loader's own promise is exact: the component registered its continuation on
 * that promise first, and `act` flushes the state it set.
 */
export async function settleEmulatorLoad(): Promise<void> {
  await act(async () => {
    await terminalEmulatorLoader.load();
  });
}

/**
 * Whether the library thinks this terminal may be typed into. xterm.js mirrors its
 * `disableStdin` option onto the hidden textarea, so this reads the emulator's gate and not a
 * field of ours.
 */
export function isEmulatorAcceptingInput(mountElement: HTMLElement): boolean {
  return !emulatorInputOf(mountElement).readOnly;
}

/**
 * Render a mount point and wait until its emulator has attached and settled a renderer. The
 * wait is on the `data-renderer` attribute, not the mount element: the element appears when the
 * chunk lands and the adapter is built by the effect after that commit, so waiting on the
 * element alone reads the pending value.
 */
export async function renderSettledMountPoint(element: React.JSX.Element): Promise<RenderResult> {
  const view = render(element);
  await waitFor(() => {
    expect(mountPointBoxOf(view.container).getAttribute("data-renderer")).not.toBe("pending");
  });
  return view;
}

/**
 * Give back every page-ledger hold these components took. The ledger is module state reached
 * through the adapter's default pool, so the sweep is unconditional. It reclaims rather than
 * releases because this environment has no WebGL2 and never made a context.
 */
export function reclaimComponentHolds(terminalIds: readonly string[]): void {
  for (const terminalId of terminalIds) {
    terminalRendererPool.reclaimEveryContextFor(terminalId);
  }
}

/** The terminal ids this component's suites mount under. */
export const COMPONENT_TERMINAL_IDS: readonly string[] = ["terminal-1", "terminal-2"];
