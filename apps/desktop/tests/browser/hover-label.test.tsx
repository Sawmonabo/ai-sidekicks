// The hover label under a real pointer and keyboard in Chromium, where the label's box lands
// against its control by real geometry: it shows when the keyboard reaches its control, Escape
// closes it, and it stays while the pointer crosses from the control onto the label. Moving the
// pointer off both is the negative control: the label closes, so its staying is not a label that
// never closes.

import { cleanup, render, waitFor } from "@testing-library/react";
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

  getByRole("button", { name: "Before" }).focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(control);
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Color scheme");
  });

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  expect(document.activeElement).toBe(control);

  control.blur();
  await userEvent.hover(control);
  await waitFor(() => {
    expect(shownLabel()).not.toBeNull();
  });
  await userEvent.hover(shownLabel()!);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  expect(shownLabel()?.textContent).toBe("Color scheme");

  await userEvent.hover(getByRole("button", { name: "After" }));
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
});

function shownLabel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".meridian-hover-label");
}
