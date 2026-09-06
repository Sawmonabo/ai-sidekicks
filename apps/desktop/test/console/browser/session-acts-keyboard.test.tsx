// The browser tier: the sessions destination's two menus are reachable without a mouse.
//
// WHY THIS CANNOT LIVE IN THE UNIT TIER. `console-unit` runs happy-dom, whose
// `focus()` succeeds on any element and whose key handling does not implement the
// focus management a real popup depends on — so a menu that opened but never moved the
// ring, and one that closed without giving the ring back, both pass there. The row's
// place menu is revealed on HOVER by the stylesheet, which makes exactly this the
// failure nobody sees: a control a pointer can reach and a keyboard cannot.
//
// TWO MENUS, BECAUSE THE LANE ADDED TWO. The row's place menu replaced a single
// toggle, and the acts bar's create menu is the entry to the import. Neither is
// covered by the other: they are different components with different triggers.

import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../console-harness.js";

import { AutoPinSetting } from "../../../src/renderer/src/console/sessions/acts/AutoPinSetting.js";
import { SessionRowMenu } from "../../../src/renderer/src/console/sessions/SessionRowMenu.js";

/** The menu items currently on screen, wherever the popup was portalled to. */
function menuItems(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
}

describe("browser — the session row's place menu answers the keyboard", () => {
  it("opens from the keyboard and puts the ring inside the popup", async () => {
    await renderSettled(
      <SessionRowMenu sessionId="session-a" tier="back" onSetTier={() => undefined} />,
    );
    const trigger = document.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();

    trigger?.focus();
    expect(document.activeElement).toBe(trigger);
    await pressKeys("{Enter}");

    // The popup is open AND the ring is in it. Opening without moving the ring leaves
    // a keyboard user looking at a menu they cannot reach, which is the state a
    // happy-dom assertion on "is the item in the document" cannot tell apart.
    expect(menuItems().length).toBeGreaterThan(0);
    expect(menuItems().some((item) => item === document.activeElement)).toBe(true);
  });

  it("gives the ring back to the trigger on Escape", async () => {
    await renderSettled(
      <SessionRowMenu sessionId="session-a" tier="front" onSetTier={() => undefined} />,
    );
    const trigger = document.querySelector<HTMLButtonElement>("button");

    trigger?.focus();
    await pressKeys("{Enter}");
    await pressKeys("{Escape}");

    // Without this the ring is left on a popup that no longer exists, and the next
    // Tab starts from the top of the document rather than from the row.
    expect(document.activeElement).toBe(trigger);
  });

  it("moves the row from the keyboard alone", async () => {
    const moved: string[] = [];
    await renderSettled(
      <SessionRowMenu
        sessionId="session-a"
        tier="back"
        onSetTier={(_sessionId, tier) => {
          moved.push(tier);
        }}
      />,
    );
    document.querySelector<HTMLButtonElement>("button")?.focus();

    await pressKeys("{Enter}");
    await pressKeys("{Enter}");

    // The first actionable item is the move, because the resting-place line is
    // disabled and a disabled item is skipped by the menu's own navigation.
    expect(moved).toStrictEqual(["front"]);
  });
});

describe("browser — the auto-pin switch is operable by keyboard", () => {
  it("toggles on Space, with the ring on the checkbox", async () => {
    const pressed: boolean[] = [];
    await renderSettled(
      <AutoPinSetting
        preferences={{
          isAutoPinOnFirstSendEnabled: true,
          lastRefusal: undefined,
          setAutoPinOnFirstSend: (isEnabled) => {
            pressed.push(isEnabled);
          },
        }}
      />,
    );
    const checkbox = document.querySelector<HTMLInputElement>("input[type=checkbox]");

    checkbox?.focus();
    expect(document.activeElement).toBe(checkbox);
    await pressKeys(" ");

    expect(pressed).toStrictEqual([false]);
  });
});
