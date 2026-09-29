// The opener this destination hands down, and whether it holds still.
//
// Separate from `WorkflowsDestination.test.tsx` because the run list is substituted here and
// that file's premise is that it is real. What a prop's identity is across a re-render is not
// a fact any rendered markup carries, so the only place to read it is where it is handed
// over. The probe records what it was given and renders nothing else.
//
// It matters because `WorkflowRuns` memoizes its projection on the read state, so a row value
// is replaced when and only when something in that run changed, which is what makes
// `RunListItem`'s `memo` worth having. An opener minted inline is a fresh identity every
// pass, the shallow compare fails for every row, and any state change above re-renders the
// whole list.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsolePaneAddress, ConsolePaneOpener } from "@renderer/console/seats/index.js";
import { RunListProjection, type WorkflowRunListRow } from "./runs/run-list-projection.js";
import { run } from "./runs/run-list-projection.test-support.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import { WorkflowsDestination } from "./WorkflowsScreen.js";

/**
 * What the run list was handed, in render order.
 *
 * A box hoisted with the mock rather than a value closed over: `vi.mock` factories are
 * lifted above the imports, so a plain binding is not initialised when they run.
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
function destination(openPane: ConsolePaneOpener): React.JSX.Element {
  return <WorkflowsDestination directory={DIRECTORY} openPane={openPane} />;
}

/** What the run list was handed on the most recent render. */
function latestRunOpener(): (row: WorkflowRunListRow) => void {
  const opener = handedDown.runOpeners.at(-1);
  if (typeof opener !== "function") {
    throw new Error("the destination handed the run list no opener");
  }
  return opener as (row: WorkflowRunListRow) => void;
}

describe("the opener the destination hands its run list", () => {
  it("hands the list the same opener across a re-render", () => {
    const openPane = vi.fn();
    const rendered = render(destination(openPane));
    rendered.rerender(destination(openPane));

    // The premise: there really were two renders to compare.
    expect(handedDown.runOpeners.length).toBeGreaterThanOrEqual(2);
    expect(handedDown.runOpeners.at(-1)).toBe(handedDown.runOpeners.at(-2));
  });

  it("negative control: a different destination for opened panes is a different opener", () => {
    // Without this, the case above would pass over an opener memoized on an empty
    // dependency list — which would go on opening panes into the surface that mounted
    // the destination first, however the surface above had since been recomposed.
    const rendered = render(destination(vi.fn()));
    const openersBefore = handedDown.runOpeners.length;
    rendered.rerender(destination(vi.fn()));

    expect(handedDown.runOpeners.length).toBeGreaterThan(openersBefore);
    expect(handedDown.runOpeners.at(-1)).not.toBe(handedDown.runOpeners.at(openersBefore - 1));
  });

  it("negative control: the opener it hands down still opens what it is called with", () => {
    // Without this, the two cases above would be satisfied by a stable callback that
    // opened nothing — the identity claim says where the address comes from and not
    // that one arrives.
    const openPane = vi.fn<(address: ConsolePaneAddress) => void>();
    render(destination(openPane));
    const [row] = new RunListProjection([run({ workflowRunId: "run-opener" })]).rows;
    if (row === undefined) {
      throw new Error("the projection produced no row");
    }
    latestRunOpener()(row);

    expect(openPane).toHaveBeenCalledWith({
      kind: "workflow-run",
      entity: { kind: "workflow-run", id: "run-opener" },
    });
  });
});
