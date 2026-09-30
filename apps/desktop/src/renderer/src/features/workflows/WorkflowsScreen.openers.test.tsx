// The opener the screen hands its run list must keep its identity across re-renders.
// `RunListItem` is memoized, so an opener minted inline would fail the shallow compare for
// every row and re-render the whole list on any state change above. Identity is not visible
// in markup, so `WorkflowRuns` is replaced with a probe that records the prop.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunListProjection, type WorkflowRunListRow } from "./runs/run-list-projection.js";
import { run } from "./runs/run-list-projection.test-support.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import {
  composeWindow,
  probeRunPane,
  type ComposedWindow,
} from "./WorkflowsScreen.test-support.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/** Hoisted with the mock: `vi.mock` factories run before a plain binding is initialized. */
const handedDown = vi.hoisted(() => ({ runOpeners: [] as unknown[] }));

vi.mock("./runs/WorkflowRuns.js", () => ({
  WorkflowRuns: (props: { readonly onOpenRun?: unknown }) => {
    handedDown.runOpeners.push(props.onOpenRun);
    return null;
  },
}));

/** One read state for every render, so a re-render differs only where a case says. */
const DIRECTORY: WorkflowRunDirectoryState = { status: "served", runs: [] };

function screenElement(composed: ComposedWindow): React.JSX.Element {
  return <WorkflowsScreen context={composed.context} directory={DIRECTORY} />;
}

function latestRunOpener(): (row: WorkflowRunListRow) => void {
  const opener = handedDown.runOpeners.at(-1);
  if (typeof opener !== "function") {
    throw new Error("the screen handed the run list no opener");
  }
  return opener as (row: WorkflowRunListRow) => void;
}

describe("the opener the screen hands its run list", () => {
  it("hands the list the same opener across a re-render", () => {
    const composed = composeWindow();
    const rendered = render(screenElement(composed));
    rendered.rerender(screenElement(composed));

    expect(handedDown.runOpeners.length).toBeGreaterThanOrEqual(2);
    expect(handedDown.runOpeners.at(-1)).toBe(handedDown.runOpeners.at(-2));
  });

  it("negative control: a different composition for opened panes is a different opener", () => {
    // Guards against an opener memoized on an empty dependency list, which would keep opening
    // panes into the first board.
    const rendered = render(screenElement(composeWindow()));
    const openersBefore = handedDown.runOpeners.length;
    rendered.rerender(screenElement(composeWindow()));

    expect(handedDown.runOpeners.length).toBeGreaterThan(openersBefore);
    expect(handedDown.runOpeners.at(-1)).not.toBe(handedDown.runOpeners.at(openersBefore - 1));
  });

  it("negative control: the opener it hands down still opens what it is called with", () => {
    // Guards against a stable callback that opens nothing; identity alone does not show an address.
    const composed = composeWindow();
    const openedContexts = probeRunPane(composed.paneRegistry);
    render(screenElement(composed));
    const [row] = new RunListProjection([run({ workflowRunId: "run-opener" })]).rows;
    if (row === undefined) {
      throw new Error("the projection produced no row");
    }
    act(() => {
      latestRunOpener()(row);
    });

    expect(openedContexts).toHaveLength(1);
    expect(openedContexts[0]).toMatchObject({
      kind: "workflow-run",
      entity: { kind: "workflow-run", id: "run-opener" },
    });
  });
});
