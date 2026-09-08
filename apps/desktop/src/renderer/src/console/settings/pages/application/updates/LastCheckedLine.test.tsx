// The idle arm is the one that reports the ABSENCE of an act, and it used to report
// nothing about it at all.
//
// `idle` says no update is waiting and says nothing about when anybody last looked,
// so a build that had never checked and one that checked a minute ago rendered the
// same sentence. The member is optional for exactly that reason — a never-checked
// installation has no timestamp to send — and both arms are asserted here, because
// the absence is a reading and not a gap.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatDateTime } from "../../../../primitives/index.js";
import { LastCheckedLine } from "./LastCheckedLine.js";

describe("the last-checked line", () => {
  it("says when the check finished, in the console's own reading of the instant", () => {
    const checkedAt = "2026-01-01T09:30:00.000Z";
    const { container } = render(<LastCheckedLine lastCheckedAt={checkedAt} />);
    // Through the figures chokepoint rather than against a written-out string: what
    // this asserts is that the line renders THAT instant, not that the console
    // formats instants a particular way, which `wire-figures` owns and tests.
    expect(container.textContent ?? "").toContain(formatDateTime(checkedAt));
  });

  it("renders it absolutely rather than as a relative reading", () => {
    // A relative reading is true only at the instant it renders, and this line has no
    // reason to re-render — an updater at rest pushes nothing — so "2 minutes ago"
    // would quietly become an hour old while still claiming two minutes.
    const { container } = render(<LastCheckedLine lastCheckedAt="2026-01-01T09:30:00.000Z" />);
    expect(container.textContent ?? "").not.toContain("ago");
  });

  it("states the absence rather than leaving the sentence half-written", () => {
    const { container } = render(<LastCheckedLine lastCheckedAt={undefined} />);
    expect(container.textContent ?? "").toBe("No check has finished in this installation.");
  });

  it("negative control: the two arms do not render the same words", () => {
    // Without this, a line that ignored its input would satisfy the first case by
    // accident on any build whose formatter answered the em dash.
    const withCheck = render(<LastCheckedLine lastCheckedAt="2026-01-01T09:30:00.000Z" />);
    const withoutCheck = render(<LastCheckedLine lastCheckedAt={undefined} />);
    expect(withCheck.container.textContent).not.toBe(withoutCheck.container.textContent);
  });
});
