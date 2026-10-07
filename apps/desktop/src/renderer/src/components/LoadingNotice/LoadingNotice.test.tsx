// A read's loading line: nothing while the read is inside the short delay, then its words as a
// line a person can see, not a shape with the words kept for assistive technology alone.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { LOADING_NOTICE_DELAY_MS, LoadingNotice } from "./LoadingNotice.js";

afterEach(() => {
  cleanup();
});

describe("loading notice", () => {
  it("draws nothing inside the delay, then its words as a visible status line", () => {
    const clock = new ManualClock(0);
    render(<LoadingNotice clock={clock} title="Reading settings…" />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      clock.advance(LOADING_NOTICE_DELAY_MS - 1);
    });
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      clock.advance(1);
    });
    const line = screen.getByRole("status");
    expect(line.textContent).toBe("Reading settings…");
    expect(line.closest(".meridian-visually-hidden")).toBeNull();
    expect(line.querySelector(".meridian-visually-hidden, [aria-hidden='true']")).toBeNull();
  });
});
