// The gitflow reads — one answers nothing, the other refuses.
//
// `Spec-011 §Interfaces And Contracts` puts two operations in front of the repos
// surfaces — a branch-context read and a PR preparation — and the console had a
// port entry for neither, so a branch-context summary built against the fixture
// had to invent the shape inside a view family, which is the thing the growth port
// exists to prevent.
//
// The subject of these cases is the DISTINCTION the two of them draw. One is
// served and answers that there is nothing; the other refuses. Those are two
// different kinds of nothing (`Spec-023 §Console Design (Meridian)`), a summary
// renders them differently, and a port that collapsed them would let the surface
// ship having only ever been driven through one.

import { describe, expect, it } from "vitest";

import { findScenariosNaming, fixturePort } from "./fixture-growth-port.test-support.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthBranchContext } from "./growth-values/index.js";
import type { ConsoleScenario } from "./scenario.js";
import { CONSOLE_SCENARIOS } from "./scenarios/index.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { createLiveBridge } from "./live-bridge.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/**
 * Names a member that would only appear if a scenario stated a branch.
 *
 * The two `BranchContextReadResponse` requires and cannot be derived from anything
 * a scenario plays, plus the id that would name a context outright and the
 * request-side name a scenario would script one under.
 */
const BRANCH_NAMING_MEMBERS = [
  "branchContextId",
  "baseBranch",
  "headBranch",
  "branchName",
] as const;

/**
 * Names a member that would only appear if a scenario stated a prepared proposal.
 *
 * The two `gitflowPrPrepare` answers with that nothing else in the corpus produces,
 * plus the target a request would carry. `branchContextId` is deliberately NOT here:
 * it is the finder above's, and a scenario stating one would fail that case first —
 * which is the right order, because without a branch context there is nothing to
 * prepare a proposal from in the first place.
 */
const PR_PREPARATION_NAMING_MEMBERS = ["prPreparationId", "proposalBlob", "targetBranch"] as const;

/**
 * Two branch contexts in one workspace, keyed by the worktree each belongs to.
 *
 * Two rather than one, because one cannot tell a read that threads its request from
 * a read that answers whatever it has: both look identical when there is only one
 * answer to give.
 */
const BRANCH_CONTEXT_BY_WORKTREE_ID: Readonly<Record<string, GrowthBranchContext>> = {
  "worktree-1": {
    branchContextId: "branch-context-1",
    workspaceId: "workspace-1",
    worktreeId: "worktree-1",
    baseBranch: "develop",
    headBranch: "feature/first",
  },
  "worktree-2": {
    branchContextId: "branch-context-2",
    workspaceId: "workspace-1",
    worktreeId: "worktree-2",
    baseBranch: "develop",
    headBranch: "feature/second",
  },
};

describe("the fixture's gitflow reads — one answers nothing, the other refuses", () => {
  it("plays no scenario that states a branch, which is what makes the absence honest", () => {
    // The fixture answers the branch-context read with an absence, and this is the
    // premise that answer rests on rather than a restatement of it: no scenario
    // carries a repo mount, and no registered event payload names a branch, so
    // there is nothing to derive one from.
    expect(findScenariosNaming(CONSOLE_SCENARIOS, BRANCH_NAMING_MEMBERS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that DOES state a branch", () => {
    // Scripted as a canned reply, because that is how a scenario would really state
    // a branch context — `gitflow.branchContextRead` is a request/response call and
    // no event payload in the census carries a branch name at all.
    const withBranchContext: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "states-a-branch",
      replies: [
        {
          call: "gitflow.branchContextRead",
          result: { baseBranch: "develop", headBranch: "feature/topic" },
        },
      ],
    };

    expect(findScenariosNaming([withBranchContext], BRANCH_NAMING_MEMBERS)).toStrictEqual([
      "states-a-branch",
    ]);
  });

  it("serves the branch-context read, answering that this workspace has none", async () => {
    const port = fixturePort();

    const outcome = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.branchContext).toBeUndefined();
    }
  });

  it("keeps that absence distinct from the live bridge's not-checked refusal", async () => {
    // The two facts a repos summary has to tell apart. Under the fixture the read
    // happened and found nothing; under the live bridge nobody asked, and the
    // refusal names who owes the wire. A port that answered the same way under both
    // would let the summary ship rendering one state for two situations.
    const bridge = createLiveBridge(createTier1Bridge());

    const outcome = await bridge.growth.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.slateRow).toBe("gitflow-actions");
      expect(outcome.owningDocument).toContain("Spec-011");
    }
    expect(outcome).not.toHaveProperty("value");
  });

  it("answers a scripted branch context per worktree, which is what the request is for", async () => {
    // The read is ENTITY-scoped: it names a workspace and a worktree. A scenario
    // answering it through `resultFor` is handed the request the caller sent, so a
    // session holding two worktrees gets each worktree's own context — which is the
    // whole point of the computed arm. Before the request was threaded, `resultFor`
    // was invoked with `undefined` and this scenario answered the same way twice.
    const port = createFixtureBridge({
      scenario: {
        ...FLAGSHIP_SCENARIO,
        id: "scripts-two-branch-contexts",
        replies: [
          {
            call: "gitflow.branchContextRead",
            resultFor: (request) => {
              const { worktreeId } = request as { readonly worktreeId: string };
              return { branchContext: BRANCH_CONTEXT_BY_WORKTREE_ID[worktreeId] };
            },
          },
        ],
      },
    }).growth;

    const first = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });
    const second = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-2",
    });

    expect(first.status).toBe("served");
    expect(second.status).toBe("served");
    if (first.status !== "served" || second.status !== "served") {
      throw new Error("the fixture refused a branch-context read its scenario scripts");
    }
    expect(first.value.branchContext?.headBranch).toBe("feature/first");
    expect(second.value.branchContext?.headBranch).toBe("feature/second");
  });

  it("negative control: an unscripted worktree takes the absence, never another's context", async () => {
    // The half that proves the case above is about the request rather than about
    // call order. A worktree the scenario answers for by name gets its context; one
    // it does not gets the served absence, because `resultFor` answering `undefined`
    // settles as unscripted and the port supplies its own honest answer. A helper
    // that discarded the request could not tell these two apart at all.
    const port = createFixtureBridge({
      scenario: {
        ...FLAGSHIP_SCENARIO,
        id: "scripts-one-branch-context",
        replies: [
          {
            call: "gitflow.branchContextRead",
            resultFor: (request) =>
              (request as { readonly worktreeId: string }).worktreeId === "worktree-1"
                ? { branchContext: BRANCH_CONTEXT_BY_WORKTREE_ID["worktree-1"] }
                : undefined,
          },
        ],
      },
    }).growth;

    const unscripted = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-2",
    });

    expect(unscripted.status).toBe("served");
    if (unscripted.status !== "served") {
      throw new Error("the fixture refused the unscripted worktree rather than answering it");
    }
    expect(unscripted.value.branchContext).toBeUndefined();
  });

  it("plays no scenario that states a prepared proposal, which is what makes the refusal honest", () => {
    // The premise the refusal below rests on rather than a restatement of it. The
    // served set omits `gitflowPrPrepare` and the module header says why; this is the
    // half of that reasoning a reader can check — nothing a scenario says could be
    // turned into a proposal, so the port is not withholding one it has.
    expect(findScenariosNaming(CONSOLE_SCENARIOS, PR_PREPARATION_NAMING_MEMBERS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that DOES state a proposal", () => {
    const withPreparedProposal: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "states-a-prepared-proposal",
      replies: [
        {
          call: "gitflow.prPrepare",
          result: { prPreparationId: "preparation-1", state: "draft", proposalBlob: {} },
        },
      ],
    };

    expect(
      findScenariosNaming([withPreparedProposal], PR_PREPARATION_NAMING_MEMBERS),
    ).toStrictEqual(["states-a-prepared-proposal"]);
  });

  it("refuses the PR preparation under both bridges, no daemon standing behind it", async () => {
    const liveBridge = createLiveBridge(createTier1Bridge());
    const request = { branchContextId: "branch-context-1", targetBranch: "develop" };

    for (const outcome of [
      await fixturePort().gitflowPrPrepare(request),
      await liveBridge.growth.gitflowPrPrepare(request),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.slateRow).toBe("gitflow-actions");
        // A reviewable proposal is a daemon act — `Spec-011 §Required Behavior`
        // puts it before any remote mutation — so a fixture that answered would be
        // standing in for the review, not for the wire.
        expect(outcome.detail).toContain("not registered on this build yet");
      }
    }
  });
});
