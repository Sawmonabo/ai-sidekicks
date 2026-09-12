// Reading the directory that is on screen, and pressing what it offers.
//
// The CAST is `channels.test-support.tsx` — the id table, the row builders, the bridge
// and the two renderers. This is the other role: four readings of a rendered list, and
// the two presses that move it. Hoisted here on this package's second-use rule the
// moment a second suite needed them, because two copies of `acts` are two suites
// disagreeing about which control sits at which index, and every case in both files
// addresses its controls positionally.
//
// POSITIONAL ON PURPOSE, and the order is the row's own: mute or unmute first, then
// archive, in the order the rows are drawn. A case that looked controls up by label
// would stop telling `Mute` from `Unmute` — which is exactly the distinction the
// receipt cases are about.

import { act } from "@testing-library/react";

import { settle } from "../core/settle.test-support.js";

/** Every lifecycle control on screen, in row order: mute or unmute, then archive. */
export function acts(container: HTMLElement): readonly HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".meridian-channel-row__act")];
}

/** Every row still on screen, by the name it wears. */
export function rowNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-channel-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

/** Press one lifecycle control and let its answer land. */
export async function press(container: HTMLElement, index: number): Promise<void> {
  act(() => {
    acts(container)[index]?.click();
  });
  await settle();
}

/**
 * Open one row's archive confirmation and press through it.
 *
 * Two presses because archival is terminal and the opposite control does not undo it:
 * the trigger asks and the dialog commits, and a case that pressed only the first has
 * asserted nothing about the act.
 */
export async function confirmArchive(container: HTMLElement, triggerIndex: number): Promise<void> {
  act(() => {
    acts(container)[triggerIndex]?.click();
  });
  act(() => {
    document.querySelector<HTMLButtonElement>(".meridian-channels__dialog-confirm")?.click();
  });
  await settle();
}
