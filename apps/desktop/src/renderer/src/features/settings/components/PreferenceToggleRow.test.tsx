// A row whose write is in flight takes no press.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreferenceToggleRow } from "./PreferenceToggleRow.js";

function switchOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="switch"]');
}

describe("preference toggle row", () => {
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
});
