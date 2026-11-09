// The shared tab strip: a middle-click on a tab closes it as its `×` does, and only for the middle
// button; only the bare menu key or Shift+F10 opens a tab's menu; a pane's own menu row with
// nothing to act on is disabled; and a close from the strip hands the focus to the tab left shown.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { TabStrip, type StripTab, type TabStripProps } from "./TabStrip.js";

const STRIP_CLOCK = new ManualClock();

const TWO_TABS: readonly StripTab<string>[] = [
  { key: "a", label: "first" },
  { key: "b", label: "second" },
];

describe("the tab strip", () => {
  it("closes the tab a middle-click lands on, and only for the middle button", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    mountStrip({ onClose, onSelect });
    const label = screen.getByText("second");
    fireEvent(label, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(onClose).not.toHaveBeenCalled();
    const middleClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    fireEvent(label, middleClick);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("b");
    expect(middleClick.defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens a tab's menu on the menu key alone or Shift+F10, and on no chord adding a modifier", () => {
    const negatives = mountStrip();
    for (const chord of [
      { key: "F10" },
      { key: "F10", shiftKey: true, ctrlKey: true },
      { key: "F10", shiftKey: true, metaKey: true },
      { key: "F10", shiftKey: true, altKey: true },
      { key: "ContextMenu", ctrlKey: true },
      { key: "ContextMenu", shiftKey: true },
    ]) {
      const press = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...chord });
      fireEvent(screen.getByText("first"), press);
      expect(press.defaultPrevented).toBe(false);
    }
    expect(document.querySelector('[role="menu"]')).toBeNull();
    negatives.unmount();

    for (const opening of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
      const strip = mountStrip();
      const press = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opening });
      fireEvent(screen.getByText("first"), press);
      expect(press.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      strip.unmount();
    }
  });

  it("disables a pane's own menu row that has nothing to act on", async () => {
    const onPress = vi.fn();
    mountStrip({
      menuRowsOf: () => [
        { label: "Close", onPress },
        { label: "Close others", onPress, disabledReason: "This is the only one." },
      ],
    });
    fireEvent(
      screen.getByText("first"),
      new KeyboardEvent("keydown", { bubbles: true, key: "ContextMenu" }),
    );
    const disabled = await screen.findByRole("menuitem", { name: "Close others" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("puts the focus on the tab left shown once a tab closed from the strip leaves it", () => {
    const strip = mountStrip({ activeKey: "b" });
    const closeSecond = screen.getByRole("button", { name: "Close second" });
    closeSecond.focus();
    fireEvent.click(closeSecond);
    act(() => {
      strip.rerender(stripOf({ tabs: [{ key: "a", label: "first" }], activeKey: "a" }));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));
  });
});

function stripOf(overrides: Partial<TabStripProps<string>> = {}): React.JSX.Element {
  return (
    <LiveAnnouncerProvider>
      <TabStrip
        tabs={TWO_TABS}
        activeKey="a"
        clock={STRIP_CLOCK}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        {...overrides}
      />
    </LiveAnnouncerProvider>
  );
}

function mountStrip(overrides: Partial<TabStripProps<string>> = {}): ReturnType<typeof render> {
  return render(stripOf(overrides));
}
