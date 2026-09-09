// Which comparisons the repos scenario's diff plane mints for, and what every other
// one is refused as.
//
// THE SUBJECT WAS NEVER THE WHOLE REQUEST, and until these cases existed the fixture
// behaved as though it were: a create naming the implementer's run came back with the
// row's prewritten patch whatever two refs rode beside it, so `foo`..`bar` produced a
// convincing change set the surface then labelled as that comparison. The cases below
// are the pair-scoped half — the scripted pair mints, and the OTHER row's pair, which
// is a real comparison in this same repository, is refused on the arm that does not
// script it.
//
// THEY DRIVE THE REAL FIXTURE PORT rather than calling the reply function, because the
// refusal's shape is half the claim: `refuseAs` throws the wire's own `{code, message}`
// envelope, and what a surface receives is that envelope carried on the port's
// `call-rejected` — which is exactly the wrapping `diff-creation-controller.ts` reads
// through.

import { describe, expect, it } from "vitest";

// The direct specifiers `repos.test.ts` takes: a suite inside `bridge/` reaching its
// own barrel would close a cycle through every plane that barrel composes.
import { createFixtureBridge } from "../../fixture/call-plane/bridge.js";
import type { GrowthDiffArtifactCreateRequest } from "../../growth-values/gitflow.js";
import { REPOS_SCENARIO } from "../repos.js";
import {
  DIFF_ARTIFACT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_RUN_ID,
  WORKSPACE_DIFF_ARTIFACT_ID,
} from "./repos-fixture-data.js";
import {
  RUN_ATTRIBUTED_COMPARED_STATES,
  UNSCRIPTED_COMPARISON_REFUSAL_CODE,
  WORKSPACE_FALLBACK_COMPARED_STATES,
  type ScenarioComparedStates,
} from "./repos-diff-replies.js";

/** A create over the implementer's run, comparing whichever two states a case names. */
function runAttributedCreate(
  comparedStates: ScenarioComparedStates,
): GrowthDiffArtifactCreateRequest {
  return {
    attributionMode: "run_attributed",
    runId: IMPLEMENTER_RUN_ID,
    baseRef: comparedStates.baseRef,
    headRef: comparedStates.headRef,
  };
}

/** The same, over the git workspace, which is the fallback arm's own key. */
function workspaceFallbackCreate(
  comparedStates: ScenarioComparedStates,
): GrowthDiffArtifactCreateRequest {
  return {
    attributionMode: "workspace_fallback",
    workspaceId: GIT_WORKSPACE_ID,
    baseRef: comparedStates.baseRef,
    headRef: comparedStates.headRef,
  };
}

/** Mint one diff against the scenario, and hand back whatever the port produced. */
async function mint(request: GrowthDiffArtifactCreateRequest): Promise<unknown> {
  const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  return await bridge.growth.gitflowDiffArtifactCreate(request);
}

/** The wire envelope a refused create rejects with, read without trusting its shape. */
async function refusalFrom(request: GrowthDiffArtifactCreateRequest): Promise<{
  readonly code: unknown;
  readonly message: unknown;
}> {
  try {
    await mint(request);
  } catch (rejection) {
    const envelope = rejection as Readonly<Record<string, unknown>>;
    return { code: envelope["code"], message: envelope["message"] };
  }
  throw new Error("the create answered where the case expected a refusal");
}

describe("repos diff replies — the comparison each arm scripts", () => {
  it("mints the run-attributed change set for the pair that run's branch context names", async () => {
    const minted = await mint(runAttributedCreate(RUN_ATTRIBUTED_COMPARED_STATES));
    expect(minted).toMatchObject({ status: "served" });
    expect(minted).toMatchObject({ value: { diffArtifactId: DIFF_ARTIFACT_ID } });
  });

  it("mints the workspace-fallback change set for the pair that checkout compares", async () => {
    const minted = await mint(workspaceFallbackCreate(WORKSPACE_FALLBACK_COMPARED_STATES));
    expect(minted).toMatchObject({ value: { diffArtifactId: WORKSPACE_DIFF_ARTIFACT_ID } });
  });

  it("negative control: a comparison no row scripts is refused rather than answered", async () => {
    // The case the fixture used to answer with a change set: two refs nobody scripted,
    // over a subject the scenario does hold.
    const refusal = await refusalFrom(runAttributedCreate({ baseRef: "foo", headRef: "bar" }));
    expect(refusal.code).toBe(UNSCRIPTED_COMPARISON_REFUSAL_CODE);
  });

  it("negative control: the other arm's own pair is refused on the arm that does not script it", async () => {
    // The sharper control, because both refs are real comparisons in this repository:
    // a per-row pair is what makes the two arms two comparisons rather than one reply
    // wearing whichever labels a caller typed.
    const onTheRunArm = await refusalFrom(runAttributedCreate(WORKSPACE_FALLBACK_COMPARED_STATES));
    const onTheWorkspaceArm = await refusalFrom(
      workspaceFallbackCreate(RUN_ATTRIBUTED_COMPARED_STATES),
    );
    expect(onTheRunArm.code).toBe(UNSCRIPTED_COMPARISON_REFUSAL_CODE);
    expect(onTheWorkspaceArm.code).toBe(UNSCRIPTED_COMPARISON_REFUSAL_CODE);
  });

  it("names the comparison the subject does resolve, and neither ref the caller typed", async () => {
    // The refs are participant input and the message is rendered verbatim, so a
    // refusal that echoed them would put unbounded text through the one sentence this
    // console does not paraphrase.
    const refusal = await refusalFrom(
      runAttributedCreate({ baseRef: "typed-base", headRef: "typed-head" }),
    );
    expect(refusal.message).toContain(RUN_ATTRIBUTED_COMPARED_STATES.headRef);
    expect(refusal.message).toContain(RUN_ATTRIBUTED_COMPARED_STATES.baseRef);
    expect(refusal.message).not.toContain("typed-base");
    expect(refusal.message).not.toContain("typed-head");
  });

  it("negative control: the subject is still checked first, under its own code", async () => {
    // The pair check must not swallow the subject one: a run this session does not
    // hold has not got as far as being a comparison, and the two facts have two codes.
    const refusal = await refusalFrom({
      attributionMode: "run_attributed",
      runId: "9f2c4a10-0000-4000-8000-0000000000ff",
      baseRef: RUN_ATTRIBUTED_COMPARED_STATES.baseRef,
      headRef: RUN_ATTRIBUTED_COMPARED_STATES.headRef,
    });
    expect(refusal.code).toBe("run.not_found");
  });
});
