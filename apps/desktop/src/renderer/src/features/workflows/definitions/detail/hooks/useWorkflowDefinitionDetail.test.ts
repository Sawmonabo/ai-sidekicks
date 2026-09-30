// The definition read's three states, and that the version and chain reads go out together once
// the definition read lands, neither waiting on the other.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { observeSubjectRead } from "@test/helpers/subject-read-commits.js";
import { settle } from "../../../workflows-probe.test-support.js";
import {
  DEFINITION_ID,
  RELEASE_CHECKS_BODY,
  RELEASE_CHECKS_DEFINITION,
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

describe("the definition detail read — the three states it can be in", () => {
  it("asks nothing where the pane names no definition", async () => {
    const readDefinition = vi.fn(answeringDetailCalls().readDefinition);
    const committed = observeDetail(answeringDetailCalls({ readDefinition }), undefined);
    await settle();

    expect(latest(committed).status).toBe("unasked");
    expect(readDefinition).not.toHaveBeenCalled();
  });

  it("reads before it answers, so the first frame is not an absence", async () => {
    const committed = observeDetail(answeringDetailCalls(), DEFINITION_ID);

    expect(committed[0]?.status).toBe("reading");
    await settle();
    expect(latest(committed).status).toBe("served");
  });

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

describe("the definition detail read — the two reads that qualify the definition", () => {
  it("does not ask for a chain the definition read gave no id for", async () => {
    // The chain read is addressed by the version id alone, so an absent id is a question that
    // could not be put; an id composed from the version number would invent an encoding.
    const { workflowVersionId: _dropped, ...withoutVersionId } = RELEASE_CHECKS_DEFINITION;
    const readChain = vi.fn(answeringDetailCalls().readChain);
    const committed = observeDetail(
      answeringDetailCalls({ readDefinition: async () => withoutVersionId, readChain }),
      DEFINITION_ID,
    );
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.chain.status).toBe("unaddressable");
    expect(readChain).not.toHaveBeenCalled();
  });

  it("issues the chain read without waiting for the version body", async () => {
    // The chain is addressed by the id the definition read already answered, so it must not
    // wait on the version body.
    const chainReadsFor: string[] = [];
    const committed = observeDetail(
      answeringDetailCalls({
        // Never settles: the claim is about what is in flight while it is outstanding.
        readVersion: () => new Promise(() => undefined),
        readChain: async (request) => {
          chainReadsFor.push(request.workflowVersionId);
          return { versions: [] };
        },
      }),
      DEFINITION_ID,
    );
    await settle();

    expect(chainReadsFor).toStrictEqual([RELEASE_CHECKS_BODY.workflowVersionId]);
    // The composed answer is still in flight because the version read is.
    expect(latest(committed).status).toBe("reading");
  });

  it("negative control: no chain read goes out while the definition read is pending", async () => {
    // Without this, the case above would pass over a read that put all three requests at once.
    const readChain = vi.fn(answeringDetailCalls().readChain);
    const committed = observeDetail(
      answeringDetailCalls({ readDefinition: () => new Promise(() => undefined), readChain }),
      DEFINITION_ID,
    );
    await settle();

    expect(readChain).not.toHaveBeenCalled();
    expect(latest(committed).status).toBe("reading");
  });

  it("negative control: the same definition resolves a chain when the id is carried", async () => {
    // Without this, the unaddressable case would pass over a hook that answered it for every
    // definition.
    const committed = observeDetail(answeringDetailCalls(), DEFINITION_ID);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.chain.status).toBe("served");
  });
});
