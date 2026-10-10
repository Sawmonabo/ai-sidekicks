// The transcript's row renderer: the card it routes a row to, the footer control beside a message,
// and the one owner it registers under.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { RowToggleProvider, type RowToggle } from "./RowToggleProvider.js";
import { registerTranscriptRowRenderer, type TranscriptRowProps } from "./renderer.js";
import { registerTranscriptRowFooterRenderer } from "./footer-renderer.js";
import { registerTranscriptRows } from "../contributions/rows.js";
import { TranscriptRow } from "./TranscriptRow.js";
import { sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

function rowRendererProps(row: TranscriptRowProps["row"]): TranscriptRowProps {
  return { row, agentHue: undefined, isSuperseded: false, density: "collapsed" };
}

/**
 * The bridge every row renders inside. A reasoning row holds a registered daemon call, so its
 * hooks cannot resolve a bridge outside a provider; the quiet scenario has no beats, so the
 * bridge answers nothing.
 */
function InBridge(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      {props.children}
    </FixtureBridgeProvider>
  );
}

/** The toggles of a list no case here presses. */
const UNPRESSED_ROW_TOGGLE: RowToggle = {
  toggleCallFold: () => undefined,
  holdControlInPlace: () => undefined,
};

/** The row renderer inside a list, as a transcript mounts it. */
function MountedInAList(props: { readonly row: TranscriptRowProps["row"] }): React.JSX.Element {
  return (
    <InBridge>
      <RowToggleProvider rowToggle={UNPRESSED_ROW_TOGGLE}>
        <TranscriptRow {...rowRendererProps(props.row)} />
      </RowToggleProvider>
    </InBridge>
  );
}

describe("routing a row to its card", () => {
  it("gives a reasoning row the reasoning body rather than the machine body", () => {
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "assistant.thinking_update" })} />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(container.querySelector(".meridian-reasoning-surface")).not.toBeNull();
    // Negative control for the routing: without the split, a reasoning row would render through
    // the hydrated-content body and report a policy redaction as a body that could not be opened.
    expect(container.querySelector(".meridian-machine-body")).toBeNull();
  });
});

describe("the edit control's footer renderer", () => {
  function buttonLabels(container: HTMLElement): readonly (string | null)[] {
    return Array.from(container.querySelectorAll("button"), (button) => button.textContent);
  }

  it("draws the footer renderer's control beside Copy on a user's own message", () => {
    registerTranscriptRowFooterRenderer("a test", () => <button type="button">Edit</button>);
    const { container } = render(
      <MountedInAList
        row={sampleRunRow({ type: "user.message", summary: "please run the tests" })}
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(buttonLabels(container)).toStrictEqual(["Copy", "Edit"]);
  });
});

describe("registering the transcript row renderer", () => {
  it("refuses a second owner rather than replacing the transcript's renderer", () => {
    // A second owner is refused at import time, by name, instead of a winner being
    // picked by import order.
    registerTranscriptRows();
    expect(() => {
      registerTranscriptRowRenderer("another owner", { render: () => null, drawsBody: () => true });
    }).toThrow(/transcript row renderer/);
  });
});
