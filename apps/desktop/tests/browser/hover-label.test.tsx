// The hover label under a real pointer and keyboard in Chromium, where the label's box lands
// against its control by real geometry: it shows when the keyboard reaches its control, a press on
// it leaves focus there, Escape closes it, and it stays while the pointer crosses from the control
// onto the label, its box touching the control's so the crossing passes over nothing else. Moving
// the pointer off both is the negative control: the label closes, so its staying is not a label
// that never closes; it closes too when the pointer leaves the window. A control that gains its
// words while focused or hovered shows them at once, and a label Escape put away stays away while
// the pointer moves inside its control, until it leaves and returns. Focus inside a trigger, such
// as a text area inside a text box's frame, shows the frame's label. The drawn label is hidden from
// assistive technology, which reads the words once, from the control. Escape on a focused control
// puts its label away and nothing else: the page never sees that press, and its default is
// canceled; once the control scrolls its label out of view, Escape is the page's again and leaves
// the label to return with its control. Escape over a hovered control puts its label away and goes
// on to the page, so the open Find field closes on the same press, and the focused control's label
// returns once the pointer leaves. A press on a control grayed in place opens its label and never
// reaches the control; a touch held still on a live control opens its label and its lift runs
// nothing, while a quick tap still acts; the next press elsewhere closes the label and does its own
// job.
import { useState, type CSSProperties } from "react";
import { act, cleanup, isInaccessible, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { WindowHoverLabel } from "#renderer/components/HoverLabel/WindowHoverLabel.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { FindBox } from "#renderer/features/transcript/find/components/FindBox.js";
import { findInTranscript } from "#renderer/features/transcript/find/matcher.js";

/** How long the label is watched once the pointer is on it, for a close the crossing set off. */
const SETTLE_MS = 300;

afterEach(() => {
  cleanup();
});

it("shows on keyboard focus, closes on Escape, and stays while the pointer moves onto it", async () => {
  let pageEscapes = 0;
  const { getByRole } = render(
    <div
      style={{ display: "flex", flexDirection: "column", gap: "64px", padding: "64px" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          pageEscapes += 1;
        }
      }}
    >
      <button type="button">Before</button>
      <HoverLabel text="Color scheme" textRole="name">
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
  // The words are the control's name already, so the drawn label is never read a second time.
  expect(isInaccessible(shownLabel()!)).toBe(true);
  // A press on the label leaves focus on the control.
  await act(async () => {
    await userEvent.click(shownLabel()!);
  });
  expect(document.activeElement).toBe(control);

  // Dispatched by hand so its return value says whether the default survived.
  let isDefaultKept = true;
  act(() => {
    isDefaultKept = control.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  expect(document.activeElement).toBe(control);
  expect(pageEscapes, "the Escape that put the label away reached the page").toBe(0);
  expect(isDefaultKept, "the Escape that put the label away kept its default").toBe(false);
  // The next Escape is the page's.
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  expect(pageEscapes).toBe(1);

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

it("closes the pointer's label when the pointer leaves the window", async () => {
  const { getByRole } = render(
    <div style={{ padding: "64px" }}>
      <HoverLabel text="Color scheme" textRole="name">
        <button type="button">◐</button>
      </HoverLabel>
      <WindowHoverLabel />
    </div>,
  );
  const control = getByRole("button", { name: "Color scheme" });
  await act(async () => {
    await userEvent.hover(control);
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Color scheme");
  });

  // A point left of the page, so the pointer leaves it without crossing anything inside it.
  const { left } = control.getBoundingClientRect();
  await act(async () => {
    await userEvent.hover(control, { position: { x: -left - 32, y: 4 } });
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
      <HoverLabel text={reason} textRole="description">
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

it("puts away the hovered control's label and passes the Escape on, and the focused one's returns", async () => {
  let pageEscapes = 0;
  const { getByRole } = render(
    <div
      style={{ display: "flex", flexDirection: "column", gap: "64px", padding: "64px" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          pageEscapes += 1;
        }
      }}
    >
      <button type="button">Before</button>
      <HoverLabel text="Label A" textRole="description">
        <button type="button">A</button>
      </HoverLabel>
      <HoverLabel text="Label B" textRole="description">
        <button type="button">B</button>
      </HoverLabel>
      <button type="button">After</button>
      <WindowHoverLabel />
    </div>,
  );
  act(() => {
    getByRole("button", { name: "Before" }).focus();
  });
  await act(async () => {
    await userEvent.tab();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Label A");
  });
  await act(async () => {
    await userEvent.hover(getByRole("button", { name: "B" }));
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Label B");
  });
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  expect(pageEscapes, "the Escape that put the hovered label away was kept from the page").toBe(1);
  await act(async () => {
    await userEvent.hover(getByRole("button", { name: "After" }));
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent, "focus on A lost its label to B's Escape").toBe("Label A");
  });
});

it("closes the Find field and a label the pointer alone opened on one Escape", async () => {
  let closeCount = 0;
  const { getByRole } = render(
    <LiveAnnouncerProvider>
      <div style={{ display: "flex", flexDirection: "column", gap: "64px", padding: "64px" }}>
        <FindBox
          query=""
          result={findInTranscript([], "", new Map())}
          areRowsShown
          currentMatchIndex={-1}
          openRequestCount={1}
          onQueryChange={() => undefined}
          onStep={() => undefined}
          onClose={() => {
            closeCount += 1;
          }}
        />
        <HoverLabel text="Label A" textRole="description">
          <button type="button">A</button>
        </HoverLabel>
        <WindowHoverLabel />
      </div>
    </LiveAnnouncerProvider>,
  );
  const field = getByRole("searchbox");
  act(() => {
    field.focus();
  });
  await act(async () => {
    await userEvent.hover(getByRole("button", { name: "A" }));
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Label A");
  });
  expect(document.activeElement).toBe(field);

  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });

  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  expect(closeCount, "the Escape that put the hovered label away left Find open").toBe(1);
});

it("leaves Escape to the page once a focused control scrolls its label out of view", async () => {
  // The window's own listener, as the keybinding table hears a key.
  let windowEscapes = 0;
  const countEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      windowEscapes += 1;
    }
  };
  window.addEventListener("keydown", countEscape);
  onTestFinished(() => {
    window.removeEventListener("keydown", countEscape);
  });
  const { getByRole, container } = render(
    <div>
      <button type="button">Before</button>
      <div className="probe-scroller" style={{ blockSize: "120px", overflow: "auto" }}>
        <div style={{ paddingBlock: "48px" }}>
          <HoverLabel text="Color scheme" textRole="name">
            <button type="button">◐</button>
          </HoverLabel>
        </div>
        <div style={{ blockSize: "600px" }} />
      </div>
      <WindowHoverLabel />
    </div>,
  );
  const scroller = container.querySelector<HTMLElement>(".probe-scroller");
  if (scroller === null) {
    throw new Error("the scroller was not drawn");
  }
  act(() => {
    getByRole("button", { name: "Before" }).focus();
  });
  await act(async () => {
    await userEvent.tab();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Color scheme");
  });
  act(() => {
    scroller.scrollTop = 400;
  });
  await waitFor(() => {
    expect(document.querySelector("[data-anchor-hidden] > .meridian-hover-label")).not.toBeNull();
  });
  // Dispatched by hand so its return value says whether the default survived.
  let isDefaultKept = false;
  act(() => {
    isDefaultKept = document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(windowEscapes, "a label out of view kept Escape from the window").toBe(1);
  expect(isDefaultKept, "a label out of view canceled the page's Escape").toBe(true);
  // That Escape was the page's alone: the label comes back with its control.
  act(() => {
    scroller.scrollTop = 0;
  });
  await waitFor(() => {
    expect(document.querySelector("[data-anchor-hidden]")).toBeNull();
    expect(shownLabel()?.textContent).toBe("Color scheme");
  });
});

it("leaves a composing or modified Escape to the page and keeps the label", async () => {
  let windowEscapes = 0;
  const countEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      windowEscapes += 1;
    }
  };
  window.addEventListener("keydown", countEscape);
  onTestFinished(() => {
    window.removeEventListener("keydown", countEscape);
  });
  const { getByRole } = render(
    <div>
      <button type="button">Before</button>
      <HoverLabel text="Color scheme" textRole="name">
        <button type="button">◐</button>
      </HoverLabel>
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
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Color scheme");
  });

  for (const [press, init] of [
    ["mid-composition", { isComposing: true }],
    ["with Shift", { shiftKey: true }],
  ] as const) {
    let isDefaultKept = false;
    act(() => {
      isDefaultKept = control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }),
      );
    });
    expect(isDefaultKept, `an Escape ${press} was canceled`).toBe(true);
    expect(shownLabel()?.textContent, `an Escape ${press} put the label away`).toBe("Color scheme");
  }
  expect(windowEscapes, "an Escape the label left alone never reached the window").toBe(2);
});

it("shows a text box's label on keyboard focus inside it, against the box's frame", async () => {
  // Padding inside the frame, so a label against the text area would stand apart from the frame.
  const framePadding = { padding: "64px", "--meridian-text-box-padding": "16px" } as CSSProperties;
  const { getByRole, container } = render(
    <div style={framePadding}>
      <button type="button">Before</button>
      <HoverLabel text="Read-only while it sends." textRole="description">
        <TextBox className="probe-box" rows={3} aria-label="Draft" readOnly value="" />
      </HoverLabel>
      <WindowHoverLabel />
    </div>,
  );
  const frame = container.querySelector<HTMLElement>(".probe-box");
  if (frame === null) {
    throw new Error("the text box drew no frame");
  }
  act(() => {
    getByRole("button", { name: "Before" }).focus();
  });
  await act(async () => {
    await userEvent.tab();
  });
  const field = getByRole("textbox", { name: "Draft" });
  expect(document.activeElement).toBe(field);
  // The label belongs to the frame, an element around the focused text area.
  const label = await waitFor(() => {
    const shown = shownLabel();
    expect(shown?.textContent).toBe("Read-only while it sends.");
    return shown!;
  });
  expect(gapBetween(label.getBoundingClientRect(), frame.getBoundingClientRect())).toBeLessThan(1);
  expect(gapBetween(label.getBoundingClientRect(), field.getBoundingClientRect())).toBeGreaterThan(
    8,
  );
});

it("opens a grayed control's label on a press and a live one's on a held touch, running neither", async () => {
  let grayedPresses = 0;
  let livePresses = 0;
  const { getByRole } = render(
    <div style={{ display: "flex", gap: "64px", padding: "64px" }}>
      <HoverLabel text="Reload this page" textRole="description">
        <button
          type="button"
          onClick={() => {
            livePresses += 1;
          }}
        >
          Reload
        </button>
      </HoverLabel>
      <HoverLabel text="No earlier page to go back to." textRole="description">
        <button
          type="button"
          aria-disabled="true"
          onClick={() => {
            grayedPresses += 1;
          }}
        >
          Back
        </button>
      </HoverLabel>
      <WindowHoverLabel />
    </div>,
  );
  const grayed = getByRole("button", { name: "Back" });
  // A press with no hover before it, as a tap lands, so only the press can open the label.
  act(() => {
    grayed.click();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("No earlier page to go back to.");
  });
  await act(async () => {
    grayed.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
  });
  expect(grayedPresses, "a press on the grayed control reached it").toBe(0);

  const live = getByRole("button", { name: "Reload" });
  // A touch held still past the hold, then lifted: the label opens and the lift runs nothing.
  await act(async () => {
    touch(live, "pointerdown");
    await new Promise((resolve) => setTimeout(resolve, HOLD_WAIT_MS));
    touch(live, "pointerup");
    live.click();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("Reload this page");
  });
  expect(livePresses, "the lift that ended the hold ran the control").toBe(0);
  // A quick tap on the same control still acts.
  act(() => {
    touch(live, "pointerdown");
    touch(live, "pointerup");
    live.click();
  });
  expect(livePresses).toBe(1);
});

/** Longer than the hold that opens a label on a touch held still. */
const HOLD_WAIT_MS = 700;

// A touch on the middle of `element`, as the browser raises it, with no hover before it.
function touch(element: HTMLElement, type: "pointerdown" | "pointerup"): void {
  const box = element.getBoundingClientRect();
  element.dispatchEvent(
    new PointerEvent(type, {
      pointerType: "touch",
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
}

it("closes a pressed label on the next press elsewhere, which still does its job", async () => {
  let otherPresses = 0;
  const { getByRole } = render(
    <div style={{ display: "flex", gap: "64px", padding: "64px" }}>
      <HoverLabel text="No later page to go forward to." textRole="description">
        <button type="button" aria-disabled="true">
          Forward
        </button>
      </HoverLabel>
      <button
        type="button"
        onClick={() => {
          otherPresses += 1;
        }}
      >
        Reload
      </button>
      <WindowHoverLabel />
    </div>,
  );
  act(() => {
    getByRole("button", { name: "Forward" }).click();
  });
  await waitFor(() => {
    expect(shownLabel()?.textContent).toBe("No later page to go forward to.");
  });
  act(() => {
    getByRole("button", { name: "Reload" }).click();
  });
  await waitFor(() => {
    expect(shownLabel()).toBeNull();
  });
  expect(otherPresses, "the press that closed the label did not do its own job").toBe(1);
});

function shownLabel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".meridian-hover-label");
}
