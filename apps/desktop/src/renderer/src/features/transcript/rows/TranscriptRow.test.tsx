// The transcript's row renderer: the card it routes a row to, the density it hands back
// to the list, and the one owner it registers under.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../fixtures/scenarios/empty-session.js";
import { RetainedRowStateProvider } from "../viewport/components/RetainedRowStateProvider.js";
import { type RetainedRowState } from "../viewport/retained-row-state-table.js";
import {
  registerTranscriptRowRenderer,
  findTranscriptRowRenderer,
  type TranscriptRowProps,
} from "@renderer/console/seats/index.js";
// Imported directly: the teardown is reached by tests alone, so the shared entry does not
// export it.
import { unregisterTranscriptRowRenderer } from "../transcript-row-renderer.js";
import {
  registerTranscriptRowFooterRenderer,
  unregisterTranscriptRowFooterRenderer,
} from "../transcript-row-footer-renderer.js";
import { TRANSCRIPT_ROW_OWNER, registerTranscriptRows } from "../contributions/transcript-rows.js";
import { TranscriptRow } from "./TranscriptRow.js";
import { sampleRunRow } from "@test/helpers/timeline-row-samples.js";

afterEach(() => {
  unregisterTranscriptRowRenderer();
});

function rowRendererProps(row: TranscriptRowProps["row"]): TranscriptRowProps {
  return { row, actorHue: undefined, isSuperseded: false, density: "collapsed" };
}

/**
 * The bridge every row now renders inside.
 *
 * A reasoning row holds a registered daemon call — the reasoning-surface read — so a row
 * rendered outside the provider is a row whose hooks cannot resolve a bridge at all. The
 * quiet scenario is the one with no beats: the harness needs a bridge to exist and
 * needs it to answer nothing, and a scripted session would put a log behind rows
 * these cases hand in one at a time.
 */
function InBridge(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      {props.children}
    </FixtureBridgeProvider>
  );
}

/**
 * The row renderer inside a list that owns its density, which is what a transcript is.
 *
 * Every routing case above renders the row bare, and that is deliberate: routing is
 * a decision the renderer makes alone. Density is not — the renderer writes a lease and
 * the LIST hands the answer back, so a harness that did not close that loop would be
 * asserting over a component that no longer decides anything.
 */
function MountedInAList(props: {
  readonly row: TranscriptRowProps["row"];
  readonly listDensity: TranscriptRowProps["density"];
  readonly onLeaseWritten?: (rowKey: string, lease: RetainedRowState) => void;
}): React.JSX.Element {
  const [leased, setLeased] = useState<RetainedRowState | undefined>(undefined);
  return (
    <InBridge>
      <RetainedRowStateProvider
        channel={{
          setLease: (rowKey, lease) => {
            props.onLeaseWritten?.(rowKey, lease);
            setLeased(lease);
          },
        }}
      >
        <TranscriptRow
          {...rowRendererProps(props.row)}
          density={leased?.density ?? props.listDensity}
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
  it("sends a tool row to the tool card", () => {
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "tool.invoked" })} listDensity="collapsed" />,
    );
    expect(container.querySelector(".meridian-tool-card__header")).not.toBeNull();
  });

  it("sends a message row to the message card", () => {
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "assistant.message" })} listDensity="collapsed" />,
    );
    expect(container.querySelector(".meridian-message-card")).not.toBeNull();
  });

  it("gives a reasoning row the reasoning body rather than the machine body", () => {
    const { container } = render(
      <MountedInAList
        row={sampleRunRow({ type: "assistant.thinking_update" })}
        listDensity="collapsed"
      />,
    );
    expect(container.querySelector(".meridian-reasoning-surface")).not.toBeNull();
    // NEGATIVE CONTROL for the routing: without the split, a reasoning row rendered
    // through the hydrated-content body and reported a policy redaction as a body
    // that could not be opened.
    expect(container.querySelector(".meridian-machine-body")).toBeNull();
  });
});

describe("the edit control's footer renderer", () => {
  afterEach(() => {
    unregisterTranscriptRowFooterRenderer();
  });

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
    );
    expect(buttonLabels(container)).toStrictEqual(["Copy", "Edit"]);
  });

  it("negative control: a reply never carries it", () => {
    registerTranscriptRowFooterRenderer("a test", () => <button type="button">Edit</button>);
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "assistant.message" })} listDensity="collapsed" />,
    );
    expect(buttonLabels(container)).not.toContain("Edit");
  });
});

describe("standing in for the list's density decision", () => {
  it("writes a reader's press to the list rather than remembering it here", () => {
    // The whole point of the change. A `useState` here was discarded the moment the
    // virtualizer scrolled the row out of the mounted range, so the choice had to
    // leave the component — and this asserts on the value that leaves it, keyed by
    // the row, which is what the window parks and re-parks across a prune.
    const written: Array<{ readonly rowKey: string; readonly lease: RetainedRowState }> = [];
    const row = sampleRunRow({ type: "tool.invoked" });
    const { container } = render(
      <MountedInAList
        row={row}
        listDensity="collapsed"
        onLeaseWritten={(rowKey, lease) => {
          written.push({ rowKey, lease });
        }}
      />,
    );
    expect(disclosureState(container)).toBe("false");

    pressDisclosure(container);
    expect(written).toStrictEqual([
      { rowKey: row.id, lease: { density: "expanded", innerScrollTopPx: 0 } },
    ]);
    expect(disclosureState(container)).toBe("true");
  });

  it("negative control: an untouched row honors a list that opened it", () => {
    // Without this, a renderer that kept any state of its own would pass the case above
    // while ignoring the list entirely.
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "tool.invoked" })} listDensity="expanded" />,
    );
    expect(disclosureState(container)).toBe("true");
  });

  it("closes a row the list opened on the first press, not the second", () => {
    // The press inverts the EFFECTIVE density — what is on screen — so one press on
    // an open row closes it. A renderer that inverted some private "have I been
    // touched" flag would store "open" here and leave the row exactly as it was.
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "tool.invoked" })} listDensity="expanded" />,
    );

    pressDisclosure(container);
    expect(disclosureState(container)).toBe("false");
  });

  it("negative control: a second press on the same row opens it again", () => {
    // Without this, a press that inverted the LIST's answer rather than the density
    // it was handed would pass the case above and then refuse to reopen.
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "tool.invoked" })} listDensity="expanded" />,
    );

    pressDisclosure(container);
    pressDisclosure(container);
    expect(disclosureState(container)).toBe("true");
  });

  it("refuses to mount outside a transcript rather than swallowing the press", () => {
    // A no-op default channel would look exactly like a row that will not open,
    // which is the defect this whole change closes. It fails loudly instead.
    expect(() =>
      render(<TranscriptRow {...rowRendererProps(sampleRunRow({ type: "tool.invoked" }))} />),
    ).toThrow(/retained row state provider/);
  });
});

describe("registering the transcript row renderer", () => {
  it("registers it under the transcript's own owner", () => {
    expect(findTranscriptRowRenderer()).toBeUndefined();
    registerTranscriptRows();
    expect(findTranscriptRowRenderer()).toBe(TranscriptRow);
  });

  it("refuses a second owner rather than replacing the transcript's renderer", () => {
    // A second owner is refused at import time, by name, instead of a winner being
    // picked by import order.
    registerTranscriptRows();
    expect(() => {
      registerTranscriptRowRenderer("another owner", () => null);
    }).toThrow(/transcript row renderer/);
  });

  it("negative control: the same owner may re-register", () => {
    // A hot reload re-runs the owning module, so an unconditional refusal would make
    // the transcript undevelopable.
    registerTranscriptRows();
    expect(() => {
      registerTranscriptRowRenderer(TRANSCRIPT_ROW_OWNER, TranscriptRow);
    }).not.toThrow();
  });
});
