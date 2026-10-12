// Waiting on a window's animation frames, for the browser tier: a frame to paint, and a layout
// change a view weighs through its resize and style observers.

import { act, getConfig } from "@testing-library/react";

/** How far an offset may move in a frame and still be holding still: a device pixel. */
const STILL_GRAIN_PX = 1;
/** The most frames a scroller may take to hold still: ten seconds of frames at 60 a second. */
const SETTLE_FRAME_LIMIT = 600;

/** Waits for `ownerWindow`'s next animation frame, whose callbacks run before its style pass. */
export async function nextFrame(ownerWindow: Window = window): Promise<void> {
  await new Promise<void>((resolve) => {
    ownerWindow.requestAnimationFrame(() => {
      resolve();
    });
  });
}

/**
 * Lets `count` animation frames pass with React rendering as it does in the app: outside `act`, as
 * `waitFor` waits, so an update the frames bring commits on its own frame rather than at the end of
 * an `act` scope, and is not reported as unwrapped.
 */
export async function letFramesPass(count: number): Promise<void> {
  await getConfig().asyncWrapper(async () => {
    for (let frame = 0; frame < count; frame += 1) {
      await nextFrame();
    }
  });
}

/**
 * Lets frames pass as `letFramesPass` does until `isMet` holds after one of them. Throws
 * `unmetMessage` once `frameLimit` frames have passed without it.
 */
export async function letFramesPassUntil(
  isMet: () => boolean,
  frameLimit: number,
  unmetMessage: string,
): Promise<void> {
  await getConfig().asyncWrapper(async () => {
    for (let frame = 0; frame < frameLimit; frame += 1) {
      await nextFrame();
      if (isMet()) {
        return;
      }
    }
    throw new Error(unmetMessage);
  });
}

/**
 * Lets frames pass until nothing in `scroller` has moved or changed for `stillFrameCount` frames
 * in a row: its offset, its height and the elements under it. Throws when it has not held still
 * within `SETTLE_FRAME_LIMIT` frames.
 */
export async function letFramesPassUntilStill(
  scroller: HTMLElement,
  stillFrameCount: number,
): Promise<void> {
  let hasChanged = false;
  const changes = new MutationObserver(() => {
    hasChanged = true;
  });
  changes.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  let stillFrames = 0;
  let lastScrollTopPx = scroller.scrollTop;
  let lastScrollHeightPx = scroller.scrollHeight;
  try {
    await letFramesPassUntil(
      () => {
        const isStill =
          !hasChanged &&
          Math.abs(scroller.scrollTop - lastScrollTopPx) < STILL_GRAIN_PX &&
          scroller.scrollHeight === lastScrollHeightPx;
        hasChanged = false;
        lastScrollTopPx = scroller.scrollTop;
        lastScrollHeightPx = scroller.scrollHeight;
        stillFrames = isStill ? stillFrames + 1 : 0;
        return stillFrames >= stillFrameCount;
      },
      SETTLE_FRAME_LIMIT,
      `the scroller did not hold still for ${String(stillFrameCount)} frames within ${String(SETTLE_FRAME_LIMIT)}`,
    );
  } finally {
    changes.disconnect();
  }
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
