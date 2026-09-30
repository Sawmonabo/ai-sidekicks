// The window's notices, mounted — and the live region they must not create.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WindowNotices } from "./WindowNotices.js";
import { type WindowAbsence } from "../../window-notices.js";

const EVERY_NOTICE: readonly WindowAbsence[] = [{ kind: "dropped", count: 12 }];

function renderNotices(...absences: readonly WindowAbsence[]): HTMLElement {
  const { container } = render(<WindowNotices absences={absences} subject="entries" />);
  return container;
}

describe("WindowNotices", () => {
  it("renders nothing when the window is the whole session", () => {
    expect(renderNotices().innerHTML).toBe("");
    expect(renderNotices({ kind: "dropped", count: 0 }).innerHTML).toBe("");
  });

  it("mounts one notice per thing there is to say", () => {
    expect(renderNotices(...EVERY_NOTICE).querySelectorAll(".meridian-nothing")).toHaveLength(1);
  });

  it("creates no live region, because the console has one announcer", () => {
    const container = renderNotices(...EVERY_NOTICE);
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(
      0,
    );
  });
});
