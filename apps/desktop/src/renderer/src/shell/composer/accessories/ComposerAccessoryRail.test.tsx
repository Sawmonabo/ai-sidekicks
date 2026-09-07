// The two plan-owned seats, and the `+` menu.
//
// Both claims are about what the rail must NOT be: a seat another plan owns says it
// is reserved rather than looking broken or half-built, and the menu's contents are
// absent from the tree while it is closed rather than merely hidden.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mountRail } from "./rail.test-support.js";

describe("ComposerAccessoryRail — the reserved seats and the menu", () => {
  it("renders the edit-and-resend seat as reserved rather than as an editor", () => {
    const container = mountRail([]);
    const seat = container.querySelector(".meridian-composer__edit-resend");
    expect(seat).not.toBeNull();
    // No textarea and no confirm: a stub editor is the one thing this seat must not
    // be, because its confirm would either do nothing or invent an eligibility rule.
    expect(seat?.querySelector("textarea")).toBeNull();
    expect(seat?.querySelector("button")).toBeNull();
  });

  it("opens the `+` menu on the trigger and closes it on Escape", () => {
    const container = mountRail([]);
    const trigger = container.querySelector(".meridian-plus-menu__trigger");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("the rail rendered no plus-menu trigger");
    }
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // `fireEvent` rather than a bare `.click()`: it wraps the dispatch in `act`, so
    // the state the handler sets is committed before the next line reads the DOM.
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".meridian-plus-menu__workflow")).not.toBeNull();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("negative control: the menu's contents are not in the tree while it is closed", () => {
    const container = mountRail([]);
    expect(container.querySelector(".meridian-attachment-seat")).toBeNull();
  });
});
