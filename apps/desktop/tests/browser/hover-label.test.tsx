// The hover label under a real pointer and keyboard in Chromium, where the label's box lands
// against its control by real geometry: it shows when the keyboard reaches its control, a press on
// it leaves focus there, Escape closes it, and it stays while the pointer crosses from the control
// onto the label, its box touching the control's so the crossing passes over nothing else. Moving
// the pointer off both is the negative control: the label closes, so its staying is not a label
// that never closes. A control that gains its words while focused or hovered shows them at once,
// and a label Escape put away stays away while the pointer moves inside its control, until it
// leaves and returns. Focus inside a trigger, such as a text area inside a text box's frame, shows
// the frame's label.

import { useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { WindowHoverLabel } from "#renderer/components/HoverLabel/WindowHoverLabel.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";

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
      <WindowHoverLabel />
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
  // A press on the label leaves focus on the control.
  await act(async () => {
    await userEvent.click(shownLabel()!);
  });
  expect(document.activeElement).toBe(control);

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

it("shows words a focused or hovered control gains, and keeps an Escaped label away inside its control", async () => {
  let giveReason: () => void = () => undefined;
  let takeReason: () => void = () => undefined;
  function GainsReason(): React.JSX.Element {
    const [reason, setReason] = useState<string | undefined>(undefined);
    giveReason = () => {
      setReason("Already restarting.");
    };
    takeReason = () => {
      setReason(undefined);
    };
    return (
      <HoverLabel text={reason} textIs="description">
        <button type="button">
          <span data-testid="glyph">◐</span> Restart
        </button>
      </HoverLabel>
    );
  }
  const { getByRole, getByTestId } = render(
    <div style={{ display: "flex", flexDirection: "column", gap: "64px", padding: "64px" }}>
      <button type="button">Before</button>
      <GainsReason />
      <button type="button">After</button>
      <WindowHoverLabel />
    </div>,
  );
  const control = getByRole("button", { name: "◐ Restart" });

  act(() => {
    getByRole("button", { name: "Before" }).focus();
  });
  await act(async () => {
    await userEvent.tab();
  });
  expect(document.activeElement).toBe(control);
  expect(shownLabel()).toBeNull();
  act(() => {
    giveReason();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Already restarting.");
  });

  act(() => {
    control.blur();
  });
  await act(async () => {
    await userEvent.hover(control);
  });
  await waitFor(() => {
    expect(shownLabel()).not.toBeNull();
  });
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  await act(async () => {
    await userEvent.hover(getByTestId("glyph"));
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
  expect(shownLabel()).toBeNull();

  await act(async () => {
    await userEvent.hover(getByRole("button", { name: "After" }));
    await userEvent.hover(control);
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Already restarting.");
  });

  // Under the pointer, the label goes with the words and comes back with them.
  act(() => {
    takeReason();
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  act(() => {
    giveReason();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Already restarting.");
  });
});

it("shows a text box's label on keyboard focus inside it, against the box's frame", async () => {
  const { getByRole, container } = render(
    <div style={{ padding: "64px" }}>
      <button type="button">Before</button>
      <HoverLabel text="Read-only while it sends." textIs="description">
        <TextBox className="probe-box" rows={3} aria-label="Draft" readOnly value="" />
      </HoverLabel>
      <WindowHoverLabel />
    </div>,
  );
  const frame = container.querySelector<HTMLElement>(".probe-box");
  act(() => {
    getByRole("button", { name: "Before" }).focus();
  });
  await act(async () => {
    await userEvent.tab();
  });
  expect(document.activeElement).toBe(getByRole("textbox", { name: "Draft" }));
  // The label belongs to the frame, an element around the focused text area.
  const label = await waitFor(() => {
    const shown = shownLabel();
    expect(shown?.textContent).toBe("Read-only while it sends.");
    return shown!;
  });
  expect(frame?.dataset["hoverLabel"]).toBe("Read-only while it sends.");
  expect(gapBetween(label.getBoundingClientRect(), frame!.getBoundingClientRect())).toBeLessThan(1);
});

function shownLabel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".meridian-hover-label");
}
