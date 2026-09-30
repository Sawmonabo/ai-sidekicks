// The idle arm reports the absence of an act, so it must say when the last check finished.
// The contract's timestamp is optional because a never-checked installation has none; both
// arms are asserted, since the absence is a reading and not a gap.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatDateTime } from "@renderer/lib/wire-figures.js";
import { LastCheckedLine } from "./LastCheckedLine.js";

describe("the last-checked line", () => {
  it("says when the check finished, in the console's own reading of the instant", () => {
    const checkedAt = "2026-01-01T09:30:00.000Z";
    const { container } = render(<LastCheckedLine lastCheckedAt={checkedAt} />);
    // Through the figures chokepoint: this asserts the line renders that instant, not how the
    // console formats instants, which `wire-figures` owns.
    expect(container.textContent ?? "").toContain(formatDateTime(checkedAt));
  });

  it("renders it absolutely rather than as a relative reading", () => {
    // A relative reading is true only when rendered, and an idle updater pushes nothing to
    // re-render it, so "2 minutes ago" would go stale.
    const { container } = render(<LastCheckedLine lastCheckedAt="2026-01-01T09:30:00.000Z" />);
    expect(container.textContent ?? "").not.toContain("ago");
  });

  it("states the absence rather than leaving the sentence half-written", () => {
    const { container } = render(<LastCheckedLine lastCheckedAt={undefined} />);
    expect(container.textContent ?? "").toBe("No check has finished in this installation.");
  });

  it("negative control: the two arms do not render the same words", () => {
    // Guards against a line that ignores its input and passes the first case by accident.
    const withCheck = render(<LastCheckedLine lastCheckedAt="2026-01-01T09:30:00.000Z" />);
    const withoutCheck = render(<LastCheckedLine lastCheckedAt={undefined} />);
    expect(withCheck.container.textContent).not.toBe(withoutCheck.container.textContent);
  });
});
