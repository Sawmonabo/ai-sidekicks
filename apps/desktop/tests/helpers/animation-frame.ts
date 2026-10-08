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
 * Let two frames pass inside `act`, so every resize and style observer has answered the layout as
 * it stood, and React has drawn what they set. An observer answers in the next frame after that
 * frame's animation callbacks, so the second frame's callback is the first point it surely has.
 */
export async function letObserversAnswer(): Promise<void> {
  await act(async () => {
    await nextFrame();
    await nextFrame();
  });
}

/** Make a change inside `act`, then let the observers answer it. */
export async function changeLayout(change: () => void): Promise<void> {
  act(() => {
    change();
  });
  await letObserversAnswer();
}
