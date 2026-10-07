// A layout change a view weighs through its resize and style observers, for the browser tier.

import { act } from "@testing-library/react";

/**
 * Make a change inside `act` and let two frames pass: the observers answer on the next frame, so
 * the change is done only after the second.
 */
export async function changeLayout(change: () => void): Promise<void> {
  await act(async () => {
    change();
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }
  });
}
