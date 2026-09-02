// A pane with no run and a pane with an unread run are different absences.
//
// They shipped as one in an earlier draft of this chrome, and the reason to keep
// them apart is the operator's next move: pick a run, versus wait for a read. The
// tests assert the two kind modifiers rather than the copy, because the copy is
// this family's to reword and the KIND is the rule.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsolePaneContext } from "../../workspace/index.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";

/**
 * The one field the chrome reads, and nothing else.
 *
 * Cast rather than constructed, the idiom `frame/legacy-surfaces.test.ts`
 * established: a real pane context carries a bridge and three stores, one of which
 * opens a database on construction, and building all of that to hand one field to a
 * component that reads one field would make the setup the subject.
 */
function paneContext(entity: ConsolePaneContext["entity"]): ConsolePaneContext {
  return { kind: "workflow-run", entity } as unknown as ConsolePaneContext;
}

function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowRunPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

describe("workflow run pane — what it says before it has read anything", () => {
  it("reports an unaddressed pane as empty", () => {
    const section = renderPane(paneContext(undefined));
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("reports an addressed but unread run as not checked", () => {
    // Negative control for the case above: both would pass over a chrome that
    // rendered one absence kind whatever its address said.
    const section = renderPane(paneContext({ kind: "workflow-run", id: "run-01" }));
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(section.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("mounts no plan-owned body while the read has not happened", () => {
    // The slots are inside the `ready` arm, so a chrome that leaked them into an
    // absence would be showing reserved holes beside "nobody asked".
    expect(
      renderPane(paneContext({ kind: "workflow-run", id: "run-01" })).querySelectorAll(
        ".meridian-workflow__slot",
      ),
    ).toHaveLength(0);
  });
});
