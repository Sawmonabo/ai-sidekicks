// What every run-pane suite needs before it can render a pane.
//
// The pane's cases split by concern — the arms, the graph's park treatment, the
// address guard, the run-detail mount, the multi-form routing — and all five mount
// the pane the same way, against one of the same two bridges, at one of the same two
// addresses. One home for that, so a change to how the pane is stood up is one edit
// rather than five that drift apart while every suite stays green.
//
// TWO BRIDGES, AND THE PAIR IS THE POINT. The workflows scenario scripts the run
// read, so the pane mounted against it shows what a daemon would have said; the
// flagship scenario scripts no workflow reply at all, so the same pane against it
// shows the port's typed refusal. Without the second, a green run would not
// distinguish a pane that reads from one that renders the served arm unconditionally.
//
// What is deliberately NOT here is anything one suite reads: the derived runs with
// two human waits, the park-attention projection the graph is measured against, and
// the slot spies each have exactly one reader and stay beside it. A helper hoisted
// before it has a second caller is a helper whose shape is decided by nobody.

import { render } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenarios/workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "../../bridge/scenarios/workflows.js";
import type { ConsolePaneContext } from "../../seats/index.js";
import type { ConsoleEntityRef } from "../../store/index.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";

/**
 * What a cast pane context may be addressed at.
 *
 * Any console entity or none — the set the pane's own two guards project, rather than
 * `ConsolePaneAddress`'s own arm for this kind, because the cases below drive exactly
 * the addresses the arm makes unconstructible and the guards still refuse.
 */
export type AddressedEntity = ConsoleEntityRef | undefined;

/** The address the run view is meant to open. */
export const PARKED: ConsoleEntityRef = {
  kind: "workflow-run",
  id: WORKFLOWS_PARKED_RUN.workflowRunId,
};

// An address this pane must not open. `CONSOLE_ENTITY_KINDS` registers
// `workflow-definition` beside `workflow-run`, and the deck hands a pane whichever
// one its layout carried — so the run view is reachable at a definition, and the id
// under it is a definition id.
export const MISADDRESSED: ConsoleEntityRef = {
  kind: "workflow-definition",
  id: "definition-01",
};

/**
 * The fields the chrome reads, and nothing else.
 *
 * Cast rather than constructed, the idiom `frame/legacy-surfaces.test.ts`
 * established: a real pane context carries three stores, one of which opens a
 * database on construction, and building all of that to hand three fields to a
 * component that reads three fields would make the setup the subject. The bridge is
 * real, because the pane now asks it something.
 */
export function paneContext(entity: AddressedEntity, bridge: ConsoleBridge): ConsolePaneContext {
  return {
    kind: "workflow-run",
    entity,
    bridge,
    sessionStore: { sessionId: WORKFLOWS_PARKED_RUN.sessionId },
  } as unknown as ConsolePaneContext;
}

/** A bridge that answers the workflow reads. */
export function answeringBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
}

/** And one that answers nothing, so the pane renders the port's refusal instead. */
export function silentBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
}

export function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowRunPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}
