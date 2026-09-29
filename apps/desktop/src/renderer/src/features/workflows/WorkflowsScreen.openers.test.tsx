// The opener this screen hands its run list, and whether it holds still.
//
// Separate from `WorkflowsScreen.test.tsx` because the run list is substituted here and
// that file's premise is that it is real. What a prop's identity is across a re-render is not
// a fact any rendered markup carries, so the only place to read it is where it is handed
// over. The probe records what it was given and renders nothing else.
//
// It matters because `WorkflowRuns` memoizes its projection on the read state, so a row value
// is replaced when and only when something in that run changed, which is what makes
// `RunListItem`'s `memo` worth having. An opener minted inline is a fresh identity every
// pass, the shallow compare fails for every row, and any state change above re-renders the
// whole list.

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

/**
 * What the run list was handed, in render order.
 *
 * A box hoisted with the mock rather than a value closed over: `vi.mock` factories are
 * lifted above the imports, so a plain binding is not initialized when they run.
 */
const handedDown = vi.hoisted(() => ({ runOpeners: [] as unknown[] }));

vi.mock("./runs/WorkflowRuns.js", () => ({
  WorkflowRuns: (props: { readonly onOpenRun?: unknown }) => {
    handedDown.runOpeners.push(props.onOpenRun);
    return null;
  },
}));

/** One read state for every render, so a re-render differs only where a case says. */
const DIRECTORY: WorkflowRunDirectoryState = { status: "served", runs: [] };

/** The element every case renders. */
function screenElement(composed: ComposedWindow): React.JSX.Element {
  return <WorkflowsScreen context={composed.context} directory={DIRECTORY} />;
}

/** What the run list was handed on the most recent render. */
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

    // The premise: there really were two renders to compare.
    expect(handedDown.runOpeners.length).toBeGreaterThanOrEqual(2);
    expect(handedDown.runOpeners.at(-1)).toBe(handedDown.runOpeners.at(-2));
  });

  it("negative control: a different composition for opened panes is a different opener", () => {
    // Without this, the case above would pass over an opener memoized on an empty
    // dependency list — which would go on opening panes into the board the screen was
    // mounted over first, however the window around it had since been recomposed.
    const rendered = render(screenElement(composeWindow()));
    const openersBefore = handedDown.runOpeners.length;
    rendered.rerender(screenElement(composeWindow()));

    expect(handedDown.runOpeners.length).toBeGreaterThan(openersBefore);
    expect(handedDown.runOpeners.at(-1)).not.toBe(handedDown.runOpeners.at(openersBefore - 1));
  });

  it("negative control: the opener it hands down still opens what it is called with", () => {
    // Without this, the two cases above would be satisfied by a stable callback that
    // opened nothing — the identity claim says where the address comes from and not
    // that one arrives.
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
