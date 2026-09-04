// What the notification center puts on screen, and the two controls it must not.
//
// The hardest properties here are absences: there is no dismiss anywhere in the
// contract, and per-session mute is deferred in Spec-019 while Spec-023 allows it —
// so the center must offer neither, and "must not render a control" is exactly the
// claim a type cannot make.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { growthUnavailable, type AttentionItem } from "../../bridge/index.js";
import { NotificationCenter } from "./NotificationCenter.js";
import {
  AttentionPlane,
  type AttentionReading,
  type RefusedAttentionSession,
} from "./attention-plane.js";

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

function readingOf(
  items: readonly AttentionItem[],
  refusedSessions: readonly RefusedAttentionSession[] = [],
): AttentionReading {
  return { phase: "read", plane: new AttentionPlane(items), droppedCount: 0, refusedSessions };
}

/** One session the fan-out never got an answer for, refused the way the port refuses. */
function refusedSession(sessionId: string): RefusedAttentionSession {
  return { sessionId, refusal: growthUnavailable("attentionProjectionRead") };
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
        reading={{
          phase: "read",
          plane: new AttentionPlane([item()]),
          droppedCount: 2,
          refusedSessions: [],
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("2 items in that read");
    // Groups above and the dropped line below: a partial read shows both halves.
    expect(container.querySelectorAll(".meridian-attention__group")).toHaveLength(1);
  });

  it("negative control: a clean read says nothing about dropped members", () => {
    const { container } = render(<NotificationCenter reading={readingOf([item()])} />);
    expect(container.textContent ?? "").not.toContain("in that read");
  });

  it("never reports an all-clear for a read it could recognise none of", () => {
    // The failure this catches is the worst one this surface has: a person is told
    // nothing needs them on the strength of a read whose every member was refused.
    const { container } = render(
      <NotificationCenter
        reading={{
          phase: "read",
          plane: new AttentionPlane([]),
          droppedCount: 2,
          refusedSessions: [],
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("Nothing needs you.");
    expect(text).toContain("2 items in that read");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a read that answered nothing AND dropped nothing is the all-clear", () => {
    // Without this, the case above would pass over a center that had simply lost
    // its empty state, which is a different defect wearing the same green tick.
    const { container } = render(<NotificationCenter reading={readingOf([])} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing needs you.");
    expect(text).not.toContain("in that read");
  });
});

describe("a read that did not cover every session", () => {
  // The worst sentence this surface has is the all-clear, and before this arm it was
  // reachable on a read one session never answered: the fan-out dropped the refusals,
  // an empty projection from the sessions that did answer read as "nothing", and a
  // person was told they were free on a question half the console never got back.

  it("never says a person is free while a session went unchecked", () => {
    const { container } = render(
      <NotificationCenter reading={readingOf([], [refusedSession("session-b")])} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("Nothing needs you.");
    expect(text).toContain("One session could not be checked.");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: the same empty read with every session answered IS the all-clear", () => {
    // Without this, the case above would pass over a center that had simply lost its
    // empty state, which is a different defect wearing the same warning.
    const { container } = render(<NotificationCenter reading={readingOf([])} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing needs you.");
    expect(text).not.toContain("could not be checked");
  });

  it("shows the items it did read beside the sessions it could not", () => {
    const { container } = render(
      <NotificationCenter
        reading={readingOf([item()], [refusedSession("session-b"), refusedSession("session-c")])}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("An approval is waiting.");
    expect(text).toContain("2 sessions could not be checked.");
    expect(container.querySelectorAll(".meridian-attention__group")).toHaveLength(1);
    expect(container.querySelectorAll(".meridian-attention__refused-row")).toHaveLength(2);
  });

  it("names each refused session and renders the port's own refusal code", () => {
    const refusal = growthUnavailable("attentionProjectionRead");
    const { container } = render(
      <NotificationCenter reading={readingOf([], [refusedSession("session-b")])} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("session-b");
    expect(text).toContain(refusal.code);
    expect(text).toContain(refusal.detail);
  });

  it("keeps the dropped-member line beside the coverage warning", () => {
    // Two different facts about one read — members this console could not recognise,
    // and sessions that never answered — and neither may stand in for the other.
    const { container } = render(
      <NotificationCenter
        reading={{
          phase: "read",
          plane: new AttentionPlane([]),
          droppedCount: 1,
          refusedSessions: [refusedSession("session-b")],
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("One session could not be checked.");
    expect(text).toContain("One item in that read");
  });
});
