// A pane with no run and a pane with an unread run are different absences, and the
// pane's two arms differ in more than their copy.
//
// The tests assert the KIND modifiers and the mounted regions rather than the
// sentences, because the copy is this family's to reword and what the arms owe is a
// rule: pick a run versus wait for a read, and a start affordance offered only where
// there is no run to compete with it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsolePaneContext } from "../../workspace/index.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";

/**
 * The two fields the chrome reads, and nothing else.
 *
 * Cast rather than constructed, the idiom `frame/legacy-surfaces.test.ts`
 * established: a real pane context carries a bridge and three stores, one of which
 * opens a database on construction, and building all of that to hand two fields to
 * a component that reads two fields would make the setup the subject.
 */
function paneContext(entity: ConsolePaneContext["entity"]): ConsolePaneContext {
  return {
    kind: "workflow-run",
    entity,
    sessionStore: { sessionId: "session-01" },
  } as unknown as ConsolePaneContext;
}

function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowRunPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

const ADDRESSED = { kind: "workflow-run", id: "wfr-01" } as const;

describe("workflow run pane — the two arms and what each offers", () => {
  it("reports an unaddressed pane as empty and offers the start affordance there", () => {
    const section = renderPane(paneContext(undefined));
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    // One slot, and it is the conversational start: a run view with no run "offers
    // the start affordance and a route into the definitions browser", which is the
    // empty state as designed rather than a fallback.
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
  });

  it("reports an addressed but unread run as not checked", () => {
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("offers no start affordance beside a run it already names", () => {
    // Negative control for the first case: both would pass over a pane that mounted
    // the same regions on every arm. The addressed arm mounts the run detail and the
    // human form and NOT the start, so a second entry point never competes with the
    // run in front of the operator.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
  });

  it("states that neither run control is reachable, rather than hiding the question", () => {
    // "Can I stop this run?" needs no run read to answer, and on this build nothing
    // admits either control — no `workflow.*` operation is on the bridge. Two typed
    // refusals is the honest answer; no controls at all would leave an operator
    // waiting for a button that is never going to appear.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-refusal--inline")).toHaveLength(2);
    expect(section.querySelectorAll("button")).toHaveLength(0);
  });

  it("negative control: the unaddressed arm asserts no run controls at all", () => {
    // Without this, the case above would pass over a pane that rendered the control
    // cluster unconditionally — including where there is no run to control.
    const section = renderPane(paneContext(undefined));
    expect(section.querySelectorAll(".meridian-refusal--inline")).toHaveLength(0);
    expect(section.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});
