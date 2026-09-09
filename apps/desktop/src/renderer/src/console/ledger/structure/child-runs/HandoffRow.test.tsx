// The handoff row, held to the two actors it exists to name.
//
// The derivation has bound the four handoff wire types since it was written, so a
// case over that table would already have passed; these read the rendered line, which
// is where the treatment was missing.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HandoffRow } from "./HandoffRow.js";
import { type HandoffEntry } from "./child-run-entries.js";

function handoff(overrides: Partial<HandoffEntry> = {}): HandoffEntry {
  return {
    rowId: "h1",
    wireType: "agent.attached",
    fromActor: "participant-ana",
    toActor: "agent-reviewer",
    reason: undefined,
    channelId: undefined,
    timestamp: "2026-01-01T09:00:00.000Z",
    childRunId: undefined,
    ...overrides,
  };
}

function renderHandoff(entry: HandoffEntry, hasThreadTarget?: boolean): HTMLElement {
  const { container } = render(
    <HandoffRow entry={entry} {...(hasThreadTarget === undefined ? {} : { hasThreadTarget })} />,
  );
  const line = container.querySelector<HTMLElement>(".meridian-handoff-row");
  if (line === null) {
    throw new Error("the handoff row drew no line");
  }
  return line;
}

describe("the handoff row — who handed what to whom", () => {
  it("draws both actors verbatim", () => {
    const line = renderHandoff(handoff());
    expect(line.textContent).toContain("participant-ana");
    expect(line.textContent).toContain("agent-reviewer");
  });

  it("renders without a reason clause when the entry carries none", () => {
    const line = renderHandoff(handoff());
    expect(line.querySelector(".meridian-handoff-row__reason")).toBeNull();
  });

  it("draws the reason verbatim when one is carried", () => {
    const line = renderHandoff(handoff({ reason: "review requested" }));
    expect(line.querySelector(".meridian-handoff-row__reason")?.textContent).toContain(
      "review requested",
    );
  });

  it("draws the channel only where the entry names one", () => {
    expect(renderHandoff(handoff()).querySelector(".meridian-handoff-row__channel")).toBeNull();
    expect(
      renderHandoff(handoff({ channelId: "channel-main" })).querySelector(
        ".meridian-handoff-row__channel",
      )?.textContent,
    ).toContain("channel-main");
  });

  it("names an absent actor as an absence rather than filling it in", () => {
    const line = renderHandoff(handoff({ toActor: undefined }));
    expect(line.querySelector(".meridian-nothing")).not.toBeNull();
    expect(line.textContent).not.toContain("agent-reviewer");
  });
});

describe("the handoff thread — drawn only where it has somewhere to reach", () => {
  it("threads a handoff whose child chapter is in the window", () => {
    const line = renderHandoff(handoff({ childRunId: "run-child" }), true);
    expect(line.className).toContain("meridian-handoff-row--threaded");
  });

  it("draws no thread when the child chapter is not loaded", () => {
    const line = renderHandoff(handoff({ childRunId: "run-child" }), false);
    expect(line.className).not.toContain("meridian-handoff-row--threaded");
  });

  it("draws no thread when the handoff names no child run", () => {
    const line = renderHandoff(handoff(), true);
    expect(line.className).not.toContain("meridian-handoff-row--threaded");
  });
});
