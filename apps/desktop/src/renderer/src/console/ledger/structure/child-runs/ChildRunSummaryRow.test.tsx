// The child-run summary row, held to the four things it claims to show.
//
// Every case reads the RENDERED line, because the defect this row answers was that
// `childRunSummary` was carried on every row and drawn nowhere: a case over the
// derivation would have passed against a console that showed none of it.
//
// AND THE SAME RULE GOVERNS THE EXPANSION. `timeline.childRunExpand` answers with the
// child run's rows, and the row read that page only to count it — so the cases below
// assert the entry BODIES are in the document, not that the page arrived.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { type ChildRunSummary, type RunId, type TimelineRow } from "@ai-sidekicks/contracts";

import { type TimelineRowSlotProps } from "../../../seats/index.js";
import { ChildRunSummaryRow, type ChildRunSummaryRowProps } from "./ChildRunSummaryRow.js";
import { CHILD_RUN_SUMMARIZED, type ChildRunExpansion } from "./child-run-expansion.js";
import { type ChildRunEntry } from "./child-run-entries.js";
import { rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";
import { useLedgerAskTerminal } from "../../cards/bodies/AskTerminalProvider.js";
import { readDriverAsk, type DriverAskReading } from "../../cards/bodies/input-ask.js";

const CHILD_RUN_ID = "run-child" as RunId;

function entryWith(summary: Partial<ChildRunSummary>): ChildRunEntry {
  return {
    rowId: "r1",
    summary: {
      runId: CHILD_RUN_ID,
      parentRunId: "run-parent" as RunId,
      state: "running",
      eventCount: 12,
      completeness: { state: "complete" },
      ...summary,
    },
    actorId: "agent-reviewer",
    timestamp: "2026-01-01T09:00:00.000Z",
    resummarizedRowIds: [],
  };
}

/**
 * A row body seat that draws what it was handed, so a case can read it back.
 *
 * The real seat is whichever plan owns a session's row bodies, and it is handed down
 * from the feed — so a case drives the row exactly as the feed does, with a renderer
 * whose output it can assert against rather than a mount of the whole card family.
 */
function probeRowBody(props: TimelineRowSlotProps): React.JSX.Element {
  return (
    <p data-testid="entry-body" data-superseded={String(props.isSuperseded)}>
      {props.row.summary}
    </p>
  );
}

/** A child run's own row, in the shape the expansion reply carries one. */
function childEntryRow(sequence: number, summary: string): TimelineRow {
  return runRow({
    id: `child-${String(sequence)}`,
    sequence,
    type: "tool.invoked",
    summary,
    actor: "agent-reviewer",
    runId: CHILD_RUN_ID,
    position: sequence,
  });
}

/** An `expanded` expansion holding the entries a case names. */
function expandedWith(
  entries: readonly TimelineRow[],
  hasUnreadEntries = false,
): ChildRunExpansion {
  return { status: "expanded", entries, hasUnreadEntries, refusal: undefined };
}

function renderRow(
  entry: ChildRunEntry,
  expansion: ChildRunExpansion = CHILD_RUN_SUMMARIZED,
  onToggleExpansion: (childRunId: RunId) => void = () => undefined,
): HTMLElement {
  const { container } = render(
    <ChildRunSummaryRow
      entry={entry}
      wireType="subagent.started"
      expansion={expansion}
      onToggleExpansion={onToggleExpansion}
      renderTimelineRow={probeRowBody}
      hueForActor={() => undefined}
    />,
  );
  const line = container.querySelector<HTMLElement>(".meridian-child-run-row");
  if (line === null) {
    throw new Error("the child-run row drew no line");
  }
  return line;
}

/** The whole row, for the cases that read what hangs BELOW the summary line. */
function renderWhole(
  expansion: ChildRunExpansion,
  overrides: {
    readonly hueForActor?: ChildRunSummaryRowProps["hueForActor"];
    readonly renderTimelineRow?: ChildRunSummaryRowProps["renderTimelineRow"];
  } = {},
): HTMLElement {
  const { container } = render(
    <ChildRunSummaryRow
      entry={entryWith({})}
      wireType="subagent.started"
      expansion={expansion}
      onToggleExpansion={() => undefined}
      renderTimelineRow={overrides.renderTimelineRow ?? probeRowBody}
      hueForActor={overrides.hueForActor ?? (() => undefined)}
    />,
  );
  return container;
}

/**
 * The row inside a holder that owns its expansion, which is what the ledger is.
 *
 * The row is controlled — it offers the toggle and renders whatever state it is
 * handed — so a case about what a PRESS leaves on screen has to close that loop, or
 * it is asserting over a component that decides nothing.
 */
function MountedWithExpansion(props: { readonly settled: ChildRunExpansion }): React.JSX.Element {
  const [expansion, setExpansion] = useState<ChildRunExpansion>(CHILD_RUN_SUMMARIZED);
  return (
    <ChildRunSummaryRow
      entry={entryWith({})}
      wireType="subagent.started"
      expansion={expansion}
      onToggleExpansion={() => {
        setExpansion(props.settled);
      }}
      renderTimelineRow={probeRowBody}
      hueForActor={() => undefined}
    />
  );
}

describe("the child-run summary row — state, count and producing node", () => {
  it("draws the run, its state and its entry count", () => {
    const line = renderRow(entryWith({}));
    expect(line.textContent).toContain("run-child");
    expect(line.textContent).toContain("running");
    expect(line.textContent).toContain("12");
  });

  it("draws the producing node where the summary resolved one", () => {
    const line = renderRow(entryWith({ producingNodeId: "node-alpha" as never }));
    expect(line.textContent).toContain("node-alpha");
  });

  it("names the absence where no node is resolved rather than guessing one", () => {
    const line = renderRow(entryWith({}));
    expect(line.querySelector(".meridian-nothing")).not.toBeNull();
    expect(line.textContent).not.toContain("unknown");
  });

  it("says the count is a running total only while the summary is incomplete", () => {
    expect(renderRow(entryWith({})).textContent).not.toContain("so far");
    const incomplete = renderRow(
      entryWith({
        completeness: {
          state: "incomplete",
          cause: "detail_fetch_failed",
          observedAt: "2026-01-01T09:00:00.000Z",
        },
      }),
    );
    expect(incomplete.textContent).toContain("so far");
  });
});

describe("the expand control — one act, and every state of it", () => {
  it("offers the expansion and hands back the child's own run id", () => {
    const onToggleExpansion = vi.fn();
    const line = renderRow(entryWith({}), CHILD_RUN_SUMMARIZED, onToggleExpansion);
    const control = line.querySelector<HTMLButtonElement>(".meridian-child-run-row__disclosure");
    expect(control?.textContent).toContain("Expand");
    expect(control?.getAttribute("aria-expanded")).toBe("false");
    control?.click();
    expect(onToggleExpansion).toHaveBeenCalledWith(CHILD_RUN_ID);
  });

  it("is inert while an expansion is in flight", () => {
    const line = renderRow(entryWith({}), {
      ...CHILD_RUN_SUMMARIZED,
      status: "expanding",
    });
    const control = line.querySelector<HTMLButtonElement>(".meridian-child-run-row__disclosure");
    expect(control?.disabled).toBe(true);
  });

  it("keeps the summary on screen and names the refusal when an expand fails", () => {
    const container = renderWhole({
      status: "expand-failed",
      entries: [],
      hasUnreadEntries: false,
      refusal: {
        code: "ledger.child_run_expand_unreachable",
        detail: "The child run could not be expanded.",
        origin: "ledger",
      },
    });
    expect(container.querySelector(".meridian-child-run-row")?.textContent).toContain("run-child");
    expect(container.textContent).toContain("could not be expanded");
    const control = container.querySelector<HTMLButtonElement>(
      ".meridian-child-run-row__disclosure",
    );
    expect(control?.textContent).toContain("Retry");
  });

  it("reports what an expansion read and whether more is unread", () => {
    const container = renderWhole(expandedWith([], true));
    const expansion = container.querySelector(".meridian-child-run-row__expansion");
    expect(expansion?.textContent).toContain("0");
    expect(expansion?.querySelector(".meridian-nothing")).not.toBeNull();
  });
});

describe("the expansion draws the child run's own work", () => {
  it("renders the returned entries through the row body seat after Expand", () => {
    // THE DEFECT, EXERCISED. The row read `expansion.entries` only to print how many
    // there were, so a person who pressed Expand was told a number and shown nothing
    // — the whole point of expanding background work is seeing what it did.
    const { container } = render(
      <MountedWithExpansion
        settled={expandedWith([
          childEntryRow(1, "read the failing spec"),
          childEntryRow(2, "patched the guard"),
        ])}
      />,
    );
    expect(container.querySelectorAll("[data-testid='entry-body']")).toHaveLength(0);

    fireEvent.click(container.querySelector(".meridian-child-run-row__disclosure") as Element);

    const bodies = [...container.querySelectorAll("[data-testid='entry-body']")].map(
      (body) => body.textContent,
    );
    expect(bodies).toStrictEqual(["read the failing spec", "patched the guard"]);
  });

  it("draws each entry through the seat it was handed and never a renderer of its own", () => {
    // Without this, a row that grew a private one-line renderer for the child's
    // entries would pass the case above while drawing the child's log in a vocabulary
    // the parent's rows do not use.
    const renderTimelineRow = vi.fn(probeRowBody);
    renderWhole(expandedWith([childEntryRow(1, "first"), childEntryRow(2, "second")]), {
      renderTimelineRow,
    });
    expect(renderTimelineRow).toHaveBeenCalledTimes(2);
    expect(renderTimelineRow.mock.calls.map(([props]) => props.row.id)).toStrictEqual([
      "child-1",
      "child-2",
    ]);
  });

  it("keeps the unread-remainder marker beside the rows rather than instead of them", () => {
    // A page that just stopped would read as the whole of the child's work.
    const container = renderWhole(expandedWith([childEntryRow(1, "only page")], true));
    expect(container.querySelectorAll("[data-testid='entry-body']")).toHaveLength(1);
    expect(
      container.querySelector(".meridian-child-run-row__expansion .meridian-nothing"),
    ).not.toBeNull();
  });

  it("ranks the child's own rollback against the child's page and not the parent's", () => {
    // The page can hold the child run's own boundary, and a row past one is superseded
    // in the child's log exactly as it is in the parent's. Asserted through the seat's
    // own prop, so a row drawn undimmed is a red check rather than a styling question.
    // The row AT the cutoff survives — `Spec-013`'s "exceeds" — which is what makes
    // this a ranking rather than "everything before a boundary".
    const container = renderWhole(
      expandedWith([
        childEntryRow(1, "the turn it rewound to"),
        childEntryRow(2, "rewound away"),
        rollbackBoundaryRow({
          id: "child-3",
          sequence: 3,
          runId: CHILD_RUN_ID,
          position: 3,
          targetPosition: 1,
        }),
      ]),
    );
    const superseded = [...container.querySelectorAll("[data-testid='entry-body']")].map((body) =>
      body.getAttribute("data-superseded"),
    );
    expect(superseded).toStrictEqual(["false", "true", "true"]);
  });

  it("asks the session's allocator for each entry's own author hue", () => {
    // Without this the child's rows would be drawn unattributed while the same actor
    // carries a hue two lines above, in the parent's log.
    const hueForActor = vi.fn(() => undefined);
    renderWhole(expandedWith([childEntryRow(1, "did the work")]), { hueForActor });
    expect(hueForActor).toHaveBeenCalledWith("agent-reviewer");
  });

  it("draws no list at all for an expansion that read nothing", () => {
    const container = renderWhole(expandedWith([]));
    expect(container.querySelector(".meridian-child-run-row__entries")).toBeNull();
  });
});

// AN EXPANDED PAGE IS ITS OWN WINDOW FOR AN ASK'S TERMINAL.
//
// The entries a child run's expansion returns are the child's rows, and the outer
// ledger's terminal map holds only the parent window's. Rendered under that map a
// child's request found no terminal, kept offering its answer controls, and let a
// participant re-answer an ask the log had already settled — so the page provides its
// own fold, over its own entries.
//
// The probe is a seat filler and not a stand-in: it reads the REAL reader and the REAL
// hook, which is the pair the fix wires up.

const ASK_ID_IN_CHILD_PAGE = "ask-1";
const CHILD_ASK_PROBE = "[data-child-ask-probe]";

function ChildAskProbe(props: { readonly ask: DriverAskReading }): React.JSX.Element {
  const terminal = useLedgerAskTerminal(props.ask);
  return (
    <span data-child-ask-probe={props.ask.askId} data-ask-terminal={terminal?.state ?? "none"} />
  );
}

function askProbeRowBody(props: TimelineRowSlotProps): React.JSX.Element {
  const ask = readDriverAsk(props.row);
  return ask === undefined ? probeRowBody(props) : <ChildAskProbe ask={ask} />;
}

/** One `driver_ask.*` row of the child's own page. */
function childAskRow(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): TimelineRow {
  return runRow({
    id: `child-ask-${String(sequence)}`,
    sequence,
    type,
    summary: type,
    actor: "agent-reviewer",
    runId: CHILD_RUN_ID,
    position: sequence,
    payload: { kind: "input", askId: ASK_ID_IN_CHILD_PAGE, ...payload },
  });
}

describe("a child run's expanded page settles its own asks", () => {
  it("finds the terminal for a request the same page answered", () => {
    const container = renderWhole(
      expandedWith([
        childAskRow(1, "driver_ask.requested", { prompt: "Which branch?" }),
        childAskRow(2, "driver_ask.responded", { response: "develop" }),
      ]),
      { renderTimelineRow: askProbeRowBody },
    );

    const probes = [...container.querySelectorAll<HTMLElement>(CHILD_ASK_PROBE)];
    expect(probes.map((probe) => probe.dataset["askTerminal"])).toStrictEqual([
      "responded",
      "responded",
    ]);
  });

  // Without this the case above would pass over a probe that reported "responded" for
  // any row, and over a fold that invented a terminal for an ask nothing settled.
  it("negative control: a page holding only the request reports no terminal", () => {
    const container = renderWhole(
      expandedWith([childAskRow(1, "driver_ask.requested", { prompt: "Which branch?" })]),
      { renderTimelineRow: askProbeRowBody },
    );

    const probe = container.querySelector<HTMLElement>(CHILD_ASK_PROBE);
    expect(probe?.dataset["askTerminal"]).toBe("none");
  });
});
