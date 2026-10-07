// The transcript's row renderer: the card it routes a row to, the density it hands back
// to the list, and the one owner it registers under.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { RetainedRowStateProvider } from "../viewport/components/RetainedRowStateProvider.js";
import { type RetainedRowState } from "../viewport/retained-row-state-table.js";
import { registerTranscriptRowRenderer, type TranscriptRowProps } from "./renderer.js";
import { registerTranscriptRowFooterRenderer } from "./footer-renderer.js";
import { registerTranscriptRows } from "../contributions/rows.js";
import { TranscriptRow } from "./TranscriptRow.js";
import { sampleRunRow } from "#test/helpers/transcript-event-row-samples.js";
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

/**
 * The row renderer inside a list that owns its density, as a transcript does: the renderer
 * writes a retained state and the list hands the answer back.
 */
function MountedInAList(props: {
  readonly row: TranscriptRowProps["row"];
  readonly listDensity: TranscriptRowProps["density"];
  readonly onRetainedStateWritten?: (rowKey: string, state: RetainedRowState) => void;
}): React.JSX.Element {
  const [retained, setRetained] = useState<RetainedRowState | undefined>(undefined);
  return (
    <InBridge>
      <RetainedRowStateProvider
        channel={{
          setRetainedState: (rowKey, state) => {
            props.onRetainedStateWritten?.(rowKey, state);
            setRetained(state);
          },
        }}
      >
        <TranscriptRow
          {...rowRendererProps(props.row)}
          density={retained?.density ?? props.listDensity}
        />
      </RetainedRowStateProvider>
    </InBridge>
  );
}

const TOOL_DISCLOSURE = ".meridian-tool-card__disclosure";

function pressDisclosure(container: HTMLElement): void {
  fireEvent.click(container.querySelector(TOOL_DISCLOSURE) as Element);
}

function disclosureState(container: HTMLElement): string | null | undefined {
  return container.querySelector(TOOL_DISCLOSURE)?.getAttribute("aria-expanded");
}

describe("routing a row to its card", () => {
  it("gives a reasoning row the reasoning body rather than the machine body", () => {
    const { container } = render(
      <MountedInAList
        row={sampleRunRow({ type: "assistant.thinking_update" })}
        listDensity="collapsed"
      />,
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
        listDensity="collapsed"
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(buttonLabels(container)).toStrictEqual(["Copy", "Edit"]);
  });
});

describe("standing in for the list's density decision", () => {
  it("writes a reader's press to the list rather than remembering it here", () => {
    // A `useState` here would be discarded when the virtualizer scrolls the row out of the
    // mounted range, so the choice must leave the component; this asserts on the value that
    // leaves, keyed by the row, which the window parks across a prune.
    const written: Array<{ readonly rowKey: string; readonly state: RetainedRowState }> = [];
    const row = sampleRunRow({ type: "tool.invoked" });
    const { container } = render(
      <MountedInAList
        row={row}
        listDensity="collapsed"
        onRetainedStateWritten={(rowKey, state) => {
          written.push({ rowKey, state });
        }}
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(disclosureState(container)).toBe("false");

    pressDisclosure(container);
    expect(written).toStrictEqual([
      { rowKey: row.id, state: { density: "expanded", innerScrollTopPx: 0 } },
    ]);
    expect(disclosureState(container)).toBe("true");
  });

  it("closes a row the list opened on the first press, not the second", () => {
    // The press inverts the effective density (what is on screen), so one press closes an open
    // row. A private "touched" flag would store "open" and leave the row as it was.
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "tool.invoked" })} listDensity="expanded" />,
      { wrapper: LiveAnnouncerProvider },
    );

    pressDisclosure(container);
    expect(disclosureState(container)).toBe("false");
  });

  it("refuses to mount outside a transcript rather than swallowing the press", () => {
    // A no-op default channel would look exactly like a row that will not open; it fails loudly
    // instead.
    expect(() =>
      render(<TranscriptRow {...rowRendererProps(sampleRunRow({ type: "tool.invoked" }))} />, {
        wrapper: LiveAnnouncerProvider,
      }),
    ).toThrow(/retained row state provider/);
  });
});

describe("registering the transcript row renderer", () => {
  it("refuses a second owner rather than replacing the transcript's renderer", () => {
    // A second owner is refused at import time, by name, instead of a winner being
    // picked by import order.
    registerTranscriptRows();
    expect(() => {
      registerTranscriptRowRenderer("another owner", () => null);
    }).toThrow(/transcript row renderer/);
  });
});
