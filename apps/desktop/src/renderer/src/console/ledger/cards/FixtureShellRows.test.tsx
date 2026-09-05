// The shell, and the deletion obligation that makes replacing it work.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LedgerRowLeaseProvider, type LedgerRowLease } from "../frame/index.js";
import {
  registerTimelineRowRenderer,
  timelineRowRenderer,
  type TimelineRowSlotProps,
} from "../../seats/index.js";
// Deeply: the teardown is reached by tests alone, so it is not a door line.
import { unregisterTimelineRowRenderer } from "../../seats/timeline-row-slot.js";
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

/**
 * The shell inside a list that owns its density, which is what a ledger is.
 *
 * Every routing case above renders the row bare, and that is deliberate: routing is
 * a decision the shell makes alone. Density is not — the shell writes a lease and
 * the LIST hands the answer back, so a harness that did not close that loop would be
 * asserting over a component that no longer decides anything.
 */
function MountedInAList(props: {
  readonly row: TimelineRowSlotProps["row"];
  readonly listDensity: TimelineRowSlotProps["density"];
  readonly onLeaseWritten?: (rowKey: string, lease: LedgerRowLease) => void;
}): React.JSX.Element {
  const [leased, setLeased] = useState<LedgerRowLease | undefined>(undefined);
  return (
    <LedgerRowLeaseProvider
      channel={{
        setLease: (rowKey, lease) => {
          props.onLeaseWritten?.(rowKey, lease);
          setLeased(lease);
        },
      }}
    >
      <FixtureShellRow {...slotProps(props.row)} density={leased?.density ?? props.listDensity} />
    </LedgerRowLeaseProvider>
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

  it("sends everything else to the one-line receipt row", () => {
    const { container } = render(
      <MountedInAList
        row={sampleGeneralRow({ type: "session.created" })}
        listDensity="collapsed"
      />,
    );
    expect(container.querySelector(".meridian-receipt-row")?.textContent).toBe(
      "The session was created.",
    );
    expect(container.querySelector(".meridian-message-card")).toBeNull();
  });

  it("names an empty receipt rather than rendering a blank line", () => {
    const { container } = render(
      <MountedInAList row={sampleGeneralRow({ summary: "" })} listDensity="collapsed" />,
    );
    expect(container.querySelector(".meridian-receipt-row")).toBeNull();
    expect(container.textContent).toContain("no summary");
  });
});

describe("standing in for the list's density decision", () => {
  it("writes a reader's press to the list rather than remembering it here", () => {
    // The whole point of the change. A `useState` here was discarded the moment the
    // virtualizer scrolled the row out of the mounted range, so the choice had to
    // leave the component — and this asserts on the value that leaves it, keyed by
    // the row, which is what the window parks and re-parks across a prune.
    const written: Array<{ readonly rowKey: string; readonly lease: LedgerRowLease }> = [];
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

  it("negative control: an untouched row honours a list that opened it", () => {
    // Without this, a shell that kept any state of its own would pass the case above
    // while ignoring the list entirely.
    const { container } = render(
      <MountedInAList row={sampleRunRow({ type: "tool.invoked" })} listDensity="expanded" />,
    );
    expect(disclosureState(container)).toBe("true");
  });

  it("closes a row the list opened on the first press, not the second", () => {
    // The press inverts the EFFECTIVE density — what is on screen — so one press on
    // an open row closes it. A shell that inverted some private "have I been
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

  it("refuses to mount outside a ledger rather than swallowing the press", () => {
    // A no-op default channel would look exactly like a row that will not open,
    // which is the defect this whole change closes. It fails loudly instead.
    expect(() =>
      render(<FixtureShellRow {...slotProps(sampleRunRow({ type: "tool.invoked" }))} />),
    ).toThrow(/lease provider/);
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
