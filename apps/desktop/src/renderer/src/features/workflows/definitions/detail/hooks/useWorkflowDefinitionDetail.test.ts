// The definition read: once the definition lands, its version body and chain are served with it.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { latestCommitted, observeSubjectRead } from "@test/helpers/subject-read-commits.js";
import { settle } from "@test/helpers/settle.js";
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
  definitionId: string | undefined,
): readonly WorkflowDefinitionDetailState[] {
  return observeSubjectRead<WorkflowDefinitionDetailCalls, WorkflowDefinitionDetailState, string>(
    useWorkflowDefinitionDetail,
    { source: calls, subject: definitionId },
  ).committed;
}

describe("the definition detail read", () => {
  it("serves the definition, its version body and its chain together", async () => {
    const committed = observeDetail(answeringDetailCalls(), DEFINITION_ID);
    await settle();
    const state = latestCommitted(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.definition.id).toBe(DEFINITION_ID);
    expect(state.detail.version).toStrictEqual(RELEASE_CHECKS_BODY);
    expect(state.detail.chain.status).toBe("served");
  });
});
