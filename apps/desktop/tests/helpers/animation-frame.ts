// Waiting on a window's animation frames, for the browser tier: a frame to paint, and a layout
// change a view weighs through its resize and style observers.

import { act } from "@testing-library/react";

/** Waits for `ownerWindow`'s next animation frame, whose callbacks run before its style pass. */
export async function nextFrame(ownerWindow: Window = window): Promise<void> {
  await new Promise<void>((resolve) => {
    ownerWindow.requestAnimationFrame(() => {
      resolve();
    });
  });
}

/**
 * Make a change inside `act` and let two frames pass: the observers answer on the next frame, so
 * the change is done only after the second.
 */
export async function changeLayout(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await nextFrame();
    await nextFrame();
  });
}
