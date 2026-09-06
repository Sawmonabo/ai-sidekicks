// The row's two jobs: be reachable, and say nothing the page did not tell it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreferenceToggleRow } from "./PreferenceToggleRow.js";

function switchOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".meridian-settings-row__switch");
}

describe("preference toggle row", () => {
  it("labels the control and describes it, so a screen reader reads both", () => {
    const { container } = render(
      <PreferenceToggleRow
        label="Mute system notifications on this machine"
        description="Stops this computer raising desktop notifications."
        checked={false}
        onCheckedChange={() => undefined}
      />,
    );
    const label = container.querySelector(".meridian-settings-row__label");
    const description = container.querySelector(".meridian-settings-row__description");
    const control = switchOf(container);
    expect(label?.getAttribute("for")).not.toBe(null);
    expect(control?.getAttribute("aria-describedby")).toBe(description?.id);
  });

  it("reports the position the page gave it", () => {
    const { container } = render(
      <PreferenceToggleRow
        label="On"
        description="d"
        checked={true}
        onCheckedChange={() => undefined}
      />,
    );
    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("true");
  });

  it("negative control: an unchecked row does not report itself checked", () => {
    // Without this, the case above would pass over a row that hardcoded `true`.
    const { container } = render(
      <PreferenceToggleRow
        label="Off"
        description="d"
        checked={false}
        onCheckedChange={() => undefined}
      />,
    );
    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("false");
  });

  it("stops taking presses while a write is in flight", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(
      <PreferenceToggleRow
        label="Busy"
        description="d"
        checked={false}
        isPending={true}
        onCheckedChange={onCheckedChange}
      />,
    );
    (switchOf(container) as HTMLElement | null)?.click();
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("renders the carrier's note and its refusal verbatim", () => {
    const { container } = render(
      <PreferenceToggleRow
        label="Held"
        description="d"
        checked={true}
        note="Held in this window."
        refusal={{ code: "preference.read_only", detail: "the store refused", origin: "test" }}
        onCheckedChange={() => undefined}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Held in this window.");
    expect(text).toContain("preference.read_only");
    expect(text).toContain("the store refused");
  });

  it("negative control: a row with neither renders neither", () => {
    // Without this, the case above would pass over a row that always drew a note.
    const { container } = render(
      <PreferenceToggleRow
        label="Plain"
        description="d"
        checked={true}
        onCheckedChange={() => undefined}
      />,
    );
    expect(container.querySelector(".meridian-settings-row__note")).toBe(null);
  });
});
