// The scans the roving-index suites read the list with, and the press they drive it by.
//
// Not a test file — no `include` glob reaches it; the three co-located suites import
// it. The list itself is `RovingList.test-support.tsx` (one component per module, the
// `apps/desktop` AGENTS.md rule the one-component gate enforces on support modules too).

import { act } from "@testing-library/react";

import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "./windowed-row-markers.js";

/**
 * The index of every row Tab would reach, read from the element that holds the stop.
 *
 * The stop is on the row's declared target rather than on the `<li>`, so the index is
 * read by climbing from it — which is also the assertion: a stop that was not inside
 * a row would produce an empty string here rather than quietly not being counted.
 */
export function tabbableIndexes(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>('[tabindex="0"]')].map(
    (target) =>
      target.closest<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`)?.dataset["index"] ?? "",
  );
}

/** Every element in the list that Tab would reach — the platform's rule, not a proxy. */
export function sequentialTabStops(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("*")].filter((element) => {
    const declared = element.getAttribute("tabindex");
    return declared === null
      ? element.matches("button, a[href], input, select, textarea")
      : Number(declared) >= 0;
  });
}

/** The list element, or a failure that names what did not render. */
export function listOf(container: HTMLElement): HTMLElement {
  const list = container.querySelector("ul");
  if (list === null) {
    throw new Error("the list did not render");
  }
  return list;
}

/** Press `End`, and let every effect the press schedules run. */
export async function pressEnd(list: HTMLElement): Promise<void> {
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
}
