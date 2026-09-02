// What the notification center puts on screen, and the two controls it must not.
//
// The hardest properties here are absences: there is no dismiss anywhere in the
// contract, and per-session mute is deferred in Spec-019 while Spec-023 allows it —
// so the center must offer neither, and "must not render a control" is exactly the
// claim a type cannot make.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../bridge/index.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { AttentionPlane, type AttentionReading } from "./attention-plane.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function readingOf(items: readonly AttentionItem[]): AttentionReading {
  return { phase: "read", plane: new AttentionPlane(items), droppedCount: 0 };
}

describe("the three phases of a projection read", () => {
  it("says the projection was not read, never that a person is free", () => {
    const { container } = render(<NotificationCenter reading={{ phase: "not-asked" }} />);
    const text = container.textContent ?? "";
    expect(text).toContain("The attention projection has not been read.");
    expect(text).not.toContain("Nothing needs you.");
  });

  it("negative control: a read that answered nothing DOES say a person is free", () => {
    // Without this, the case above would pass over a center that rendered the
    // not-asked absence for every phase.
    const { container } = render(<NotificationCenter reading={readingOf([])} />);
    expect(container.textContent ?? "").toContain("Nothing needs you.");
  });

  it("renders a read in flight as a read in flight", () => {
    const { container } = render(<NotificationCenter reading={{ phase: "reading" }} />);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });
});

describe("what the center never offers", () => {
  it("draws no dismiss control beside an item", () => {
    const { container } = render(<NotificationCenter reading={readingOf([item()])} />);
    const labels = [...container.querySelectorAll("button")].map(
      (button) => `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`,
    );
    expect(labels.some((label) => /dismiss|clear|mark read/iu.test(label))).toBe(false);
  });

  it("says mute is global and draws no per-session switch", () => {
    const { container } = render(<NotificationCenter reading={readingOf([item()])} />);
    expect(container.textContent ?? "").toContain("Muting is a single global setting");
    expect(container.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
  });
});

describe("the density fold", () => {
  const withBoth = [
    item({ id: "blocking" }),
    item({ id: "chatter", severity: "informational", trigger: "run_completed" }),
  ];

  it("folds the informational half under a count while anything is actionable", () => {
    const { container } = render(<NotificationCenter reading={readingOf(withBoth)} />);
    const fold = container.querySelector(".meridian-attention__fold-summary");
    expect(fold?.textContent).toBe("1 informational");
  });

  it("negative control: with nothing actionable the informational items are not folded", () => {
    const { container } = render(
      <NotificationCenter
        reading={readingOf([item({ severity: "informational", trigger: "mention" })])}
      />,
    );
    expect(container.querySelector(".meridian-attention__fold")).toBeNull();
    expect(container.querySelectorAll(".meridian-attention__items")).toHaveLength(1);
  });
});

describe("an item's own render", () => {
  it("shows the projection's summary verbatim beside the console's reading of the trigger", () => {
    const { container } = render(<NotificationCenter reading={readingOf([item()])} />);
    const text = container.textContent ?? "";
    expect(text).toContain("An approval is waiting.");
    expect(text).toContain("Waiting on an approval");
  });

  it("names the scope off `runId` rather than recomputing it", () => {
    const { container } = render(
      <NotificationCenter reading={readingOf([item({ id: "aggregate" })])} />,
    );
    expect(container.textContent ?? "").toContain("Everything unresolved in this session");
  });

  it("negative control: a run-scoped item names its run instead", () => {
    const { container } = render(
      <NotificationCenter reading={readingOf([item({ runId: "run-7" })])} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("run-7");
    expect(text).not.toContain("Everything unresolved in this session");
  });

  it("is a press only when the surface supplied somewhere to go", () => {
    const withoutOpen = render(<NotificationCenter reading={readingOf([item()])} />);
    expect(withoutOpen.container.querySelectorAll(".meridian-attention__row--open")).toHaveLength(
      0,
    );
    const withOpen = render(
      <NotificationCenter reading={readingOf([item()])} onOpen={() => undefined} />,
    );
    expect(withOpen.container.querySelectorAll(".meridian-attention__row--open")).toHaveLength(1);
  });
});

describe("members the boundary refused", () => {
  it("says how many were dropped rather than shrinking the list silently", () => {
    const { container } = render(
      <NotificationCenter
        reading={{ phase: "read", plane: new AttentionPlane([item()]), droppedCount: 2 }}
      />,
    );
    expect(container.textContent ?? "").toContain("2 items in that read");
  });

  it("negative control: a clean read says nothing about dropped members", () => {
    const { container } = render(<NotificationCenter reading={readingOf([item()])} />);
    expect(container.textContent ?? "").not.toContain("in that read");
  });
});
