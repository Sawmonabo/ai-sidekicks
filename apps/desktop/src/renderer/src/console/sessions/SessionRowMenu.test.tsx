// What the row's context menu states, and what it offers.
//
// The single toggle this replaced was correct about the act and wrong about the
// surface: one word whose meaning depended on a state the row never showed. So the
// claims here are the two the toggle could not make — the menu SAYS where the row
// sits, and it offers only moves that would change something — plus the one a menu
// can silently lose: the trigger stays reachable by keyboard.

import { act, cleanup, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionRowMenu } from "./SessionRowMenu.js";
import { SESSION_PIN_TIERS, type SessionPinTier } from "./rows/session-rows.js";

/** Open one row's menu and answer with the items it put on screen. */
function openMenu(tier: SessionPinTier): {
  readonly items: readonly HTMLElement[];
  readonly moved: { sessionId: string; tier: SessionPinTier }[];
  readonly trigger: HTMLButtonElement;
} {
  const moved: { sessionId: string; tier: SessionPinTier }[] = [];
  const { container } = render(
    <SessionRowMenu
      sessionId="session-a"
      tier={tier}
      onSetTier={(sessionId, nextTier) => {
        moved.push({ sessionId, tier: nextTier });
      }}
    />,
  );
  const trigger = container.querySelector<HTMLButtonElement>("button");
  if (trigger === null) {
    throw new Error("the menu rendered no trigger");
  }
  act(() => {
    trigger.click();
  });
  return {
    items: [...document.querySelectorAll<HTMLElement>("[role='menuitem']")],
    moved,
    trigger,
  };
}

describe("the session row's place menu", () => {
  it("states where the row sits, which the toggle it replaced could not", () => {
    const { items } = openMenu("front");

    expect(items.map((item) => item.textContent)).toContain("Pinned to the front tier");
  });

  it("offers every other tier and never the one the row is already in", () => {
    for (const tier of SESSION_PIN_TIERS) {
      // Torn down between tiers: the popup is PORTALLED, so a menu left mounted from
      // the previous iteration keeps its items in the document and the count below
      // would read both menus as one.
      cleanup();
      const { items } = openMenu(tier);
      const actionable = items.filter((item) => item.getAttribute("aria-disabled") !== "true");

      expect(actionable, tier).toHaveLength(SESSION_PIN_TIERS.length - 1);
    }
  });

  it("moves the row to the tier the pressed item names", () => {
    const { items, moved } = openMenu("back");
    const pinItem = items.find((item) => item.textContent === "Pin to the front tier");

    act(() => {
      pinItem?.click();
    });

    expect(moved).toStrictEqual([{ sessionId: "session-a", tier: "front" }]);
  });

  it("keeps the trigger in the tab order — a hover-only control is not a control", () => {
    // The menu is revealed on hover by the stylesheet. The failure that hides behind
    // that is removing it from the tab order, which no visual review catches.
    const { trigger } = openMenu("front");

    expect(trigger.getAttribute("tabindex")).not.toBe("-1");
    expect(trigger.getAttribute("aria-label")).toContain("session-a");
  });

  it("would notice a menu that offered the tier the row is already in", () => {
    // The negative control on the filter: the item set for a front-tier row must not
    // contain the front-tier move, or the case above would pass for a menu that
    // listed everything.
    const { items } = openMenu("front");

    expect(items.map((item) => item.textContent)).not.toContain("Pin to the front tier");
  });
});
