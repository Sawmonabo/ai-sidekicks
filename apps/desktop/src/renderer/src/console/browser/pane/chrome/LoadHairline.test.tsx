// The hairline's three states, and the one it must not invent.
//
// The whole point of the indeterminate arm is that it carries NO figure, so the case
// asserting the determinate arm's `aria-valuenow` is paired with one asserting the
// other arm has none. A component that always set the attribute would pass the first
// alone and report a fabricated percentage on every load that reports no fraction.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LoadHairline } from "./LoadHairline.js";

function renderHairline(isLoading: boolean, progress: number | null): HTMLElement | null {
  const { container } = render(<LoadHairline isLoading={isLoading} progress={progress} />);
  const bar = container.querySelector("[role='progressbar']");
  return bar instanceof HTMLElement ? bar : null;
}

describe("the load hairline", () => {
  it("renders nothing at all when nothing is loading", () => {
    expect(renderHairline(false, 0.4)).toBeNull();
  });

  it("carries the reported fraction on the bar", () => {
    const bar = renderHairline(true, 0.4);
    expect(bar?.getAttribute("aria-valuenow")).toBe("0.4");
    expect(bar?.classList.contains("meridian-browser-hairline--indeterminate")).toBe(false);
  });

  it("carries no fraction where the view reported none", () => {
    const bar = renderHairline(true, null);
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar?.classList.contains("meridian-browser-hairline--indeterminate")).toBe(true);
  });

  it("clamps a fraction the view reported out of range", () => {
    expect(renderHairline(true, 4)?.getAttribute("aria-valuenow")).toBe("1");
    expect(renderHairline(true, -1)?.getAttribute("aria-valuenow")).toBe("0");
  });

  it("treats a fraction that is not a number as none reported", () => {
    expect(renderHairline(true, Number.NaN)?.hasAttribute("aria-valuenow")).toBe(false);
  });
});
