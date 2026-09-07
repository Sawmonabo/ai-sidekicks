// The definition read has four endings, and the three calls inside it settle apart.
//
// Every case drives a REAL growth port — the fixture's over the workflows scenario, the
// refusing one, or the refusing one with a single arm replaced — rather than a promise
// shaped like one. A stand-in port would agree with whatever the hook did with it.
//
// THE CLAIM THAT MATTERS IS THE PARTIAL ONE. Folding three reads into one refusal would
// withdraw facts the daemon answered: a definition whose version body was refused still
// has a name, a scope and a latest version, and a surface that showed none of that
// would be reporting the daemon as more silent than it was.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../../../bridge/index.js";
import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import {
  DEFINITION_INCIDENT_TRIAGE_SHARED,
  DEFINITION_RELEASE_CHECKS_PROJECT,
  DEFINITION_RELEASE_CHECKS_SESSION,
} from "../../../bridge/scenarios/workflow-fixture-ids.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenarios/workflows.js";
import { observeSubjectRead } from "../../../store/subject-read-commits.test-support.js";
import { settle } from "../../workflows-probe.test-support.js";
import {
  useWorkflowDefinitionDetail,
  type WorkflowDefinitionDetailState,
} from "./definition-detail-read.js";

afterEach(cleanup);

/** The scenario's own port, which answers all three reads for its own definitions. */
function scriptedPort(): GrowthPort {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }).growth;
}

/** Every state one mount committed, oldest first. */
function observeDetail(
  growth: GrowthPort,
  workflowDefinitionId: string | undefined,
): readonly WorkflowDefinitionDetailState[] {
  return observeSubjectRead<GrowthPort, WorkflowDefinitionDetailState, string>(
    useWorkflowDefinitionDetail,
    { source: growth, subject: workflowDefinitionId },
  ).committed;
}

/** The last state a mount committed, which is what a surface would be showing. */
function latest(
  committed: readonly WorkflowDefinitionDetailState[],
): WorkflowDefinitionDetailState {
  const last = committed.at(-1);
  if (last === undefined) {
    throw new Error("the probe committed nothing");
  }
  return last;
}

describe("the definition detail read — the four states it can be in", () => {
  it("asks nothing where the pane names no definition", async () => {
    const committed = observeDetail(scriptedPort(), undefined);
    await settle();

    expect(latest(committed).status).toBe("unasked");
  });

  it("reads before it answers, so the first frame is not an absence", async () => {
    // The finding this pins: the builder pane rendered "this definition has not been
    // read in this window" under every bridge, because there was no read to put. The
    // first committed frame is now `reading` — an answer is coming — and only the last
    // one carries it.
    const committed = observeDetail(scriptedPort(), DEFINITION_RELEASE_CHECKS_SESSION);

    expect(committed[0]?.status).toBe("reading");
    await settle();
    expect(latest(committed).status).toBe("served");
  });

  it("serves the definition, its version body and its chain together", async () => {
    const committed = observeDetail(scriptedPort(), DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.definition.id).toBe(DEFINITION_RELEASE_CHECKS_SESSION);
    expect(state.detail.version.status).toBe("served");
    expect(state.detail.chain.status).toBe("served");
  });

  it("refuses the whole reading where the SUBJECT read refused", async () => {
    // The definition read is the subject: without it there is nothing to render, and a
    // console that drew an empty definition would be asserting that it has no phases.
    const committed = observeDetail(createRefusingGrowthPort(), DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    expect(latest(committed).status).toBe("unavailable");
  });
});

describe("the definition detail read — the two reads that qualify rather than replace", () => {
  it("keeps the identity on screen when the version body is refused", async () => {
    // The partial claim. The port below answers the definition and refuses the body,
    // which is exactly what an older daemon or a pruned version row produces — and the
    // name, scope and latest version are all still facts somebody answered.
    const scripted = scriptedPort();
    const growth: GrowthPort = {
      ...createRefusingGrowthPort(),
      workflowDefinitionRead: scripted.workflowDefinitionRead.bind(scripted),
      workflowVersionChainRead: scripted.workflowVersionChainRead.bind(scripted),
    };
    const committed = observeDetail(growth, DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.definition.name).not.toBe("");
    expect(state.detail.version.status).toBe("unavailable");
  });

  it("refuses the chain on its own where the fixture states none for that version", async () => {
    // Two of the five definitions this scenario lists are pinned to by no run, so it
    // states no chain for either — a real partial reading rather than a contrived one.
    const committed = observeDetail(scriptedPort(), DEFINITION_RELEASE_CHECKS_PROJECT);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.version.status).toBe("served");
    expect(state.detail.chain.status).toBe("unavailable");
  });

  it("does not ask for a chain the definition read gave no id for", async () => {
    // `workflowVersionId` is additive-optional, and the chain read is addressed by
    // nothing else — so an absent id is a question that could not be PUT, which is a
    // different fact from one that was put and refused. A console that composed an id
    // from the version number would be inventing an encoding this wire has none of.
    const scripted = scriptedPort();
    const growth: GrowthPort = {
      ...createRefusingGrowthPort(),
      workflowDefinitionRead: async (request) => {
        const outcome = await scripted.workflowDefinitionRead(request);
        if (outcome.status !== "served") {
          return outcome;
        }
        const { workflowVersionId: _dropped, ...withoutVersionId } = outcome.value;
        return { status: "served", value: withoutVersionId };
      },
      workflowVersionRead: scripted.workflowVersionRead.bind(scripted),
      workflowVersionChainRead: scripted.workflowVersionChainRead.bind(scripted),
    };
    const committed = observeDetail(growth, DEFINITION_INCIDENT_TRIAGE_SHARED);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.chain.status).toBe("unaddressable");
  });

  it("issues the chain read without waiting for the version body", async () => {
    // The chain is addressed by `definition.workflowVersionId`, which the SUBJECT read
    // already answered, so nothing about it comes out of the version body. Put after
    // that body, a version read that never settles held the chain question back
    // entirely — the daemon had answered the definition and the surface was still
    // waiting on a request it had not sent.
    const scripted = scriptedPort();
    const chainReadsFor: string[] = [];
    const growth: GrowthPort = {
      ...createRefusingGrowthPort(),
      workflowDefinitionRead: scripted.workflowDefinitionRead.bind(scripted),
      // Never settles. The claim is about what is in flight WHILE it is outstanding,
      // which a refusing arm could not state: a refusal settles, and the reads after
      // it would go out either way.
      workflowVersionRead: () => new Promise(() => undefined),
      workflowVersionChainRead: async (request) => {
        chainReadsFor.push(request.workflowVersionId);
        return scripted.workflowVersionChainRead(request);
      },
    };
    const committed = observeDetail(growth, DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    expect(chainReadsFor).toHaveLength(1);
    // And the composed answer is still in flight, because one of its two qualifying
    // reads is: starting them together changes when each is PUT and not what the
    // settlement is composed from.
    expect(latest(committed).status).toBe("reading");
  });

  it("negative control: no chain read goes out while the SUBJECT read is outstanding", async () => {
    // Without this, the case above would hold over a read that put all three requests
    // at once — which would address the chain with an id nothing had answered yet.
    const chainReadsFor: string[] = [];
    const growth: GrowthPort = {
      ...createRefusingGrowthPort(),
      workflowDefinitionRead: () => new Promise(() => undefined),
      workflowVersionChainRead: async (request) => {
        chainReadsFor.push(request.workflowVersionId);
        return { status: "served", value: { versions: [] } };
      },
    };
    const committed = observeDetail(growth, DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    expect(chainReadsFor).toStrictEqual([]);
    expect(latest(committed).status).toBe("reading");
  });

  it("negative control: the same definition resolves a chain when the id is carried", async () => {
    // Without this, the case above would hold over a hook that answered
    // `unaddressable` for every definition — the right answer for one input, arrived at
    // from a read that never composes the chain request at all.
    const committed = observeDetail(scriptedPort(), DEFINITION_INCIDENT_TRIAGE_SHARED);
    await settle();
    const state = latest(committed);

    expect(state.status).toBe("served");
    if (state.status !== "served") {
      return;
    }
    expect(state.detail.chain.status).toBe("served");
  });
});
