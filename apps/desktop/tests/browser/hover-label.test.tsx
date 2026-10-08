// The hover label under a real pointer and keyboard in Chromium, where the label's box lands
// against its control by real geometry: it shows when the keyboard reaches its control, Escape
// closes it, and it stays while the pointer crosses from the control onto the label, its box
// touching the control's so the crossing passes over nothing else. Moving the
// pointer off both is the negative control: the label closes, so its staying is not a label that
// never closes.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { HoverLabelHost } from "#renderer/components/HoverLabel/HoverLabelHost.js";

/** How long the label is watched once the pointer is on it, for a close the crossing set off. */
const SETTLE_MS = 300;

afterEach(() => {
  cleanup();
});

it("shows on keyboard focus, closes on Escape, and stays while the pointer moves onto it", async () => {
  const { getByRole } = render(
    <div style={{ display: "flex", flexDirection: "column", gap: "64px", padding: "64px" }}>
      <button type="button">Before</button>
      <HoverLabel text="Color scheme" textIs="name">
        <button type="button">◐</button>
      </HoverLabel>
      <button type="button">After</button>
      <HoverLabelHost />
    </div>,
  );
  const control = getByRole("button", { name: "Color scheme" });

  act(() => {
    getByRole("button", { name: "Before" }).focus();
  });
  await act(async () => {
    await userEvent.tab();
  });
  expect(document.activeElement).toBe(control);
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Color scheme");
  });

  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  expect(document.activeElement).toBe(control);

  act(() => {
    control.blur();
  });
  await act(async () => {
    await userEvent.hover(control);
  });
  const label = await waitFor(() => {
    const shown = shownLabel();
    expect(shown).not.toBeNull();
    return shown!;
  });
  expect(gapBetween(label.getBoundingClientRect(), control.getBoundingClientRect())).toBeLessThan(
    1,
  );
  await act(async () => {
    await userEvent.hover(label);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
  expect(shownLabel()?.textContent).toBe("Color scheme");

  await act(async () => {
    await userEvent.hover(getByRole("button", { name: "After" }));
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
});

/** The widest empty run between two boxes along either axis; zero when they touch or overlap. */
function gapBetween(first: DOMRect, second: DOMRect): number {
  return Math.max(
    0,
    first.left - second.right,
    second.left - first.right,
    first.top - second.bottom,
    second.top - first.bottom,
  );
}

function shownLabel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".meridian-hover-label");
}
