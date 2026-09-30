// The definition read: once the definition lands, its version body and chain are served with it.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { observeSubjectRead } from "@test/helpers/subject-read-commits.js";
import { settle } from "../../../workflows-probe.test-support.js";
import {
  DEFINITION_ID,
  RELEASE_CHECKS_BODY,
  answeringDetailCalls,
} from "./useWorkflowDefinitionAuthoring.test-support.js";
import {
  useWorkflowDefinitionDetail,
  type WorkflowDefinitionDetailCalls,
  type WorkflowDefinitionDetailState,
} from "./useWorkflowDefinitionDetail.js";

afterEach(cleanup);

/** Every state one mount committed, oldest first. */
function observeDetail(
  calls: WorkflowDefinitionDetailCalls,
  workflowDefinitionId: string | undefined,
): readonly WorkflowDefinitionDetailState[] {
  return observeSubjectRead<WorkflowDefinitionDetailCalls, WorkflowDefinitionDetailState, string>(
    useWorkflowDefinitionDetail,
    { source: calls, subject: workflowDefinitionId },
  ).committed;
}

/** The last state a mount committed, which is what the definition detail would be showing. */
function latest(
  committed: readonly WorkflowDefinitionDetailState[],
): WorkflowDefinitionDetailState {
  const last = committed.at(-1);
  if (last === undefined) {
    throw new Error("the probe committed nothing");
  }
  return last;
}

describe("the definition detail read", () => {
  it("serves the definition, its version body and its chain together", async () => {
    const committed = observeDetail(answeringDetailCalls(), DEFINITION_ID);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.definition.id).toBe(DEFINITION_ID);
    expect(state.detail.version).toStrictEqual(RELEASE_CHECKS_BODY);
    expect(state.detail.chain.status).toBe("served");
  });
});
