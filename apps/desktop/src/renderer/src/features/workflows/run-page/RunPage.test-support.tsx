// What the run pane's suites need before they can render a pane.

import { render } from "@testing-library/react";

import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { PARKED_RUN, PROBE_SESSION_ID } from "../workflows-probe.test-support.js";
import { RunPage } from "./RunPage.js";

/** The address the run pane is meant to open. */
export const ADDRESSED_RUN: EntityRef = {
  kind: "workflow-run",
  id: PARKED_RUN.workflowRunId,
};

/** An address of another kind, which the pane must refuse. */
export const MISADDRESSED: EntityRef = {
  kind: "workflow-definition",
  id: "definition-01",
};

/**
 * The fields the pane and its chrome read, and nothing else. Cast rather than built: a real
 * pane context carries stores that open a database, and the cases drive addresses the pane's
 * type makes unconstructible.
 */
export function paneContext(entity: EntityRef | undefined): PaneContextOf<"workflow-run"> {
  return {
    kind: "workflow-run",
    entity,
    sessionStore: { sessionId: PROBE_SESSION_ID },
  } as unknown as PaneContextOf<"workflow-run">;
}

/** Mount the pane against one context and hand back the pane's own section. */
export function renderRunPage(context: PaneContextOf<"workflow-run">): HTMLElement {
  const { container } = render(<RunPage context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}
