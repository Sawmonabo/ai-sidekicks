// The child-run summary row, held to the four things it claims to show.
//
// Every case reads the RENDERED line, because the defect this row answers was that
// `childRunSummary` was carried on every row and drawn nowhere: a case over the
// derivation would have passed against a console that showed none of it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type ChildRunSummary, type RunId } from "@ai-sidekicks/contracts";

import { ChildRunSummaryRow } from "./ChildRunSummaryRow.js";
import { CHILD_RUN_SUMMARIZED, type ChildRunExpansion } from "./child-run-expansion.js";
import { type ChildRunEntry } from "./child-run-entries.js";

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
    />,
  );
  const line = container.querySelector<HTMLElement>(".meridian-child-run-row");
  if (line === null) {
    throw new Error("the child-run row drew no line");
  }
  return line;
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
    const { container } = render(
      <ChildRunSummaryRow
        entry={entryWith({})}
        wireType="subagent.started"
        expansion={{
          status: "expand-failed",
          entries: [],
          hasUnreadEntries: false,
          refusal: {
            code: "ledger.child_run_expand_unreachable",
            detail: "The child run could not be expanded.",
            origin: "ledger",
          },
        }}
        onToggleExpansion={() => undefined}
      />,
    );
    expect(container.querySelector(".meridian-child-run-row")?.textContent).toContain("run-child");
    expect(container.textContent).toContain("could not be expanded");
    const control = container.querySelector<HTMLButtonElement>(
      ".meridian-child-run-row__disclosure",
    );
    expect(control?.textContent).toContain("Retry");
  });

  it("reports what an expansion read and whether more is unread", () => {
    const { container } = render(
      <ChildRunSummaryRow
        entry={entryWith({})}
        wireType="subagent.started"
        expansion={{
          status: "expanded",
          entries: [],
          hasUnreadEntries: true,
          refusal: undefined,
        }}
        onToggleExpansion={() => undefined}
      />,
    );
    const expansion = container.querySelector(".meridian-child-run-row__expansion");
    expect(expansion?.textContent).toContain("0");
    expect(expansion?.querySelector(".meridian-nothing")).not.toBeNull();
  });
});
