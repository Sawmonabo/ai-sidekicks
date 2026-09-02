// The shell, and the deletion obligation that makes replacing it work.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerTimelineRowRenderer,
  timelineRowRenderer,
  unregisterTimelineRowRenderer,
  type TimelineRowSlotProps,
} from "../../workspace/index.js";
import {
  FIXTURE_SHELL_OWNER,
  FixtureShellRow,
  registerFixtureShellRows,
} from "./FixtureShellRows.js";
import { sampleGeneralRow, sampleRunRow } from "./row-samples.js";

afterEach(() => {
  unregisterTimelineRowRenderer();
});

function slotProps(row: TimelineRowSlotProps["row"]): TimelineRowSlotProps {
  return { row, participantHue: undefined, isSuperseded: false, density: "collapsed" };
}

describe("routing a row to its card", () => {
  it("sends a tool row to the tool card", () => {
    const { container } = render(
      <FixtureShellRow {...slotProps(sampleRunRow({ type: "tool.invoked" }))} />,
    );
    expect(container.querySelector(".meridian-tool-card__header")).not.toBeNull();
  });

  it("sends a message row to the message card", () => {
    const { container } = render(
      <FixtureShellRow {...slotProps(sampleRunRow({ type: "assistant.message" }))} />,
    );
    expect(container.querySelector(".meridian-message-card")).not.toBeNull();
  });

  it("sends everything else to the one-line receipt row", () => {
    const { container } = render(
      <FixtureShellRow {...slotProps(sampleGeneralRow({ type: "session.created" }))} />,
    );
    expect(container.querySelector(".meridian-receipt-row")?.textContent).toBe(
      "The session was created.",
    );
    expect(container.querySelector(".meridian-message-card")).toBeNull();
  });

  it("names an empty receipt rather than rendering a blank line", () => {
    const { container } = render(
      <FixtureShellRow {...slotProps(sampleGeneralRow({ summary: "" }))} />,
    );
    expect(container.querySelector(".meridian-receipt-row")).toBeNull();
    expect(container.textContent).toContain("no summary");
  });
});

describe("standing in for the list's density decision", () => {
  it("follows the list until a reader touches the row", () => {
    const { container } = render(
      <FixtureShellRow {...slotProps(sampleRunRow({ type: "tool.invoked" }))} />,
    );
    const disclosure = container.querySelector(".meridian-tool-card__disclosure");
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(disclosure as Element);
    expect(
      container.querySelector(".meridian-tool-card__disclosure")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("negative control: an untouched row honours a list that opened it", () => {
    // Without this, a shell that copied the prop into state at mount would pass the
    // toggle case above while ignoring the list entirely.
    const { container } = render(
      <FixtureShellRow {...slotProps(sampleRunRow({ type: "tool.invoked" }))} density="expanded" />,
    );
    expect(
      container.querySelector(".meridian-tool-card__disclosure")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("claiming the seat", () => {
  it("fills it under the shell's own owner", () => {
    expect(timelineRowRenderer()).toBeUndefined();
    registerFixtureShellRows();
    expect(timelineRowRenderer()).toBe(FixtureShellRow);
  });

  it("refuses a second owner rather than replacing the shell", () => {
    // The property the deletion obligation rests on: a change that registered the
    // timeline's own row without deleting this shell stops the timeline rendering at
    // import time, by name, instead of picking a winner by import order.
    registerFixtureShellRows();
    expect(() => {
      registerTimelineRowRenderer("the timeline subtree", () => null);
    }).toThrow(/timeline row/);
  });

  it("negative control: the same owner may re-register", () => {
    // A hot reload re-runs the owning module, so an unconditional refusal would make
    // the shell undevelopable.
    registerFixtureShellRows();
    expect(() => {
      registerTimelineRowRenderer(FIXTURE_SHELL_OWNER, FixtureShellRow);
    }).not.toThrow();
  });
});
