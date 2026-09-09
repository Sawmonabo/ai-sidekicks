// The shell, and the deletion obligation that makes replacing it work.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenario/ledger/ledger-quiet.js";
import {
  LedgerRowLeaseProvider,
  LedgerShellConditionProvider,
  type LedgerRowLease,
} from "../../frame/index.js";
// The condition that closes no control, from the one module that builds shell
// conditions: an ask row dispatches a mutating call and reads the window's supervisor
// through the ledger, so a harness without one is a mount this shell refuses.
import { quietShell } from "../../../store/shell-condition.test-support.js";
// Deeply, at the modules that DECLARE them: the family door imports the cards' sheet,
// and a suite has no reason to pull one in to reach a fold and a provider.
import { LedgerAskTerminalProvider } from "../bodies/AskTerminalProvider.js";
import { deriveDriverAskTerminals } from "../bodies/input-ask.js";
import {
  registerTimelineRowRenderer,
  timelineRowRenderer,
  type TimelineRowSlotProps,
} from "../../../seats/index.js";
// Deeply: the teardown is reached by tests alone, so it is not a door line.
import { unregisterTimelineRowRenderer } from "../../../seats/slots/timeline-row-slot.js";
import {
  FIXTURE_SHELL_OWNER,
  FixtureShellRow,
  registerFixtureShellRows,
} from "./FixtureShellRows.js";
import { sampleGeneralRow, sampleRunRow } from "../row-samples.test-support.js";

/**
 * A second run, for the one property one run cannot state.
 *
 * ULID-shaped like the builder's own default, so the two rows differ in exactly the
 * member the fold keys on.
 */
const SECOND_RUN_ID = "01J0000000000000000000000C";

afterEach(() => {
  unregisterTimelineRowRenderer();
});

function slotProps(row: TimelineRowSlotProps["row"]): TimelineRowSlotProps {
  return { row, participantHue: undefined, isSuperseded: false, density: "collapsed" };
}

/**
 * The bridge every row now renders inside.
 *
 * The shell's rows hold two registered daemon calls — the reasoning-surface read a
 * reasoning row offers, and the answer an ask row delivers — so a row rendered
 * outside the provider is a row whose hooks cannot resolve a bridge at all. The
 * quiet scenario is the one with no beats: the harness needs a bridge to exist and
 * needs it to answer nothing, and a scripted session would put a log behind rows
 * these cases hand in one at a time.
 */
function InBridge(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
      {props.children}
    </SidekicksBridgeProvider>
  );
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
  /**
   * The window this row sits in, where a case is about one.
   *
   * Folded through the real derivation rather than a hand-built map: the rule under
   * test is what the fold decides, and a map written here would be this file asserting
   * against its own copy of it. Absent, the row is mounted with no window around it —
   * which is what every routing case above is, and what a bare row genuinely is.
   */
  readonly windowRows?: readonly TimelineRowSlotProps["row"][];
}): React.JSX.Element {
  const [leased, setLeased] = useState<LedgerRowLease | undefined>(undefined);
  // Minted once and kept: a fresh store on every render would be a fresh subscription
  // on every render for the ask row that reads it.
  const [frameStore] = useState(quietShell);
  const row = (
    <FixtureShellRow {...slotProps(props.row)} density={leased?.density ?? props.listDensity} />
  );
  return (
    <InBridge>
      <LedgerRowLeaseProvider
        channel={{
          setLease: (rowKey, lease) => {
            props.onLeaseWritten?.(rowKey, lease);
            setLeased(lease);
          },
        }}
      >
        <LedgerShellConditionProvider channel={{ frameStore }}>
          {props.windowRows === undefined ? (
            row
          ) : (
            <LedgerAskTerminalProvider
              terminalsByAskIdentity={deriveDriverAskTerminals(props.windowRows)}
            >
              {row}
            </LedgerAskTerminalProvider>
          )}
        </LedgerShellConditionProvider>
      </LedgerRowLeaseProvider>
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

  it("gives a reasoning row the reasoning surface rather than the machine body", () => {
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

  it("sends an input ask to the ask card ahead of the family table", () => {
    const { container } = render(
      <MountedInAList
        row={sampleRunRow({
          type: "driver_ask.requested",
          payload: { askId: "ask-01", kind: "input", prompt: "Which branch?" },
        })}
        listDensity="collapsed"
      />,
    );
    expect(container.textContent).toContain("Which branch?");
    // The classifier answers `receipt` for this type, which is the right answer for
    // the family table and the wrong surface for a run blocked on a question.
    expect(container.querySelector(".meridian-receipt-row")).toBeNull();
  });

  it("retires the request's controls once the window holds its terminal", () => {
    const request = sampleRunRow({
      id: "row-01",
      type: "driver_ask.requested",
      payload: { askId: "ask-09", kind: "input", prompt: "Which branch?" },
    });
    const response = sampleRunRow({
      id: "row-02",
      type: "driver_ask.responded",
      payload: { askId: "ask-09", kind: "input", response: "develop" },
    });
    const { container } = render(
      <MountedInAList row={request} listDensity="collapsed" windowRows={[request, response]} />,
    );
    // The question stays on screen — it is the request row's and the terminal row
    // carries none — and the disposition is what replaces the controls.
    expect(container.textContent).toContain("Which branch?");
    expect(container.textContent).toContain("This ask was answered");
    expect(container.querySelector(".meridian-input-ask__arms")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("negative control: the same request keeps its controls while nothing has settled it", () => {
    // Without this, a card that retired its controls on the presence of a window
    // rather than on its own ask's terminal would pass the case above and leave every
    // open ask unanswerable.
    const request = sampleRunRow({
      id: "row-01",
      type: "driver_ask.requested",
      payload: { askId: "ask-09", kind: "input", prompt: "Which branch?" },
    });
    const otherAnswer = sampleRunRow({
      id: "row-02",
      type: "driver_ask.responded",
      payload: { askId: "ask-10", kind: "input", response: "develop" },
    });
    const { container } = render(
      <MountedInAList row={request} listDensity="collapsed" windowRows={[request, otherAnswer]} />,
    );
    expect(container.querySelector(".meridian-input-ask__arms")).not.toBeNull();
    expect(container.textContent).not.toContain("This ask was answered");
  });

  it("keeps a second run's ask open when another run settled the same ask id", () => {
    // A provider mints its ask ids per provider session, so two runs blocked at once
    // legitimately raise `ask-09` each. Keyed on that id alone, the first run's answer
    // settled the second run's card: it read as answered and lost its arms while its
    // own run was still blocked with nobody able to answer it.
    const answeredElsewhere = sampleRunRow({
      id: "row-01",
      runId: SECOND_RUN_ID,
      type: "driver_ask.responded",
      payload: { askId: "ask-09", kind: "input", response: "develop" },
    });
    const request = sampleRunRow({
      id: "row-02",
      type: "driver_ask.requested",
      payload: { askId: "ask-09", kind: "input", prompt: "Which branch?" },
    });
    const { container } = render(
      <MountedInAList
        row={request}
        listDensity="collapsed"
        windowRows={[answeredElsewhere, request]}
      />,
    );
    expect(container.querySelector(".meridian-input-ask__arms")).not.toBeNull();
    expect(container.textContent).not.toContain("This ask was answered");
  });

  it("negative control: a permission ask is not drawn here", () => {
    const { container } = render(
      <MountedInAList
        row={sampleRunRow({
          type: "driver_ask.requested",
          payload: { askId: "ask-02", kind: "permission", prompt: "Run this command?" },
        })}
        listDensity="collapsed"
      />,
    );
    expect(container.querySelector(".meridian-input-ask")).toBeNull();
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
