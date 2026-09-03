// The gitflow reads — one answers nothing, the other refuses.
//
// `Spec-011 §Interfaces And Contracts` puts two operations in front of the repos
// surfaces — a branch-context read and a PR preparation — and the console had a
// port entry for neither, so a branch-context summary built against the fixture
// had to invent the shape inside a view family, which is the thing the growth port
// exists to prevent.
//
// The subject of these cases is what each one ANSWERS WITH. The branch-context read
// serves a scenario's scripted context — flat, exactly as `BranchContextReadResponse`
// returns it — and refuses where no scenario scripts one, because that reply carries no
// member an absence could ride on and a `(workspace, worktree)` pair resolving no row
// refuses on the real wire too. The PR preparation refuses under every scenario. A
// fixture that answered either with a fabricated empty value would be scripting a shape
// no daemon sends.

import { describe, expect, it } from "vitest";

import { findScenariosNaming, fixturePort } from "./fixture-growth-port.test-support.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthBranchContext } from "./growth-values/index.js";
import type { ConsoleScenario } from "./scenario.js";
import { CONSOLE_SCENARIOS } from "./scenarios/index.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { REPOS_SCENARIO } from "./scenarios/repos.js";
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

describe("the fixture's gitflow reads — one answers from the script, the other refuses", () => {
  it("plays exactly one scenario that states a branch, and every other takes the absence", () => {
    // The fixture answers the branch-context read from the SCRIPT where a scenario
    // has one and from its own absence where none does, and this case is what keeps
    // the second half honest rather than a restatement of it: no registered event
    // payload names a branch, so a scenario that scripts no
    // `gitflow.branchContextRead` reply has nothing anywhere for a derivation to
    // read, and the absence is the true answer for it.
    //
    // The repos scenario scripts one — which is why it is NAMED here rather than
    // merely tolerated: a scenario that quietly stopped scripting it would leave the
    // proposal gate reachable only through the empty state again, and this assertion
    // is what fails at that moment.
    expect(findScenariosNaming(CONSOLE_SCENARIOS, BRANCH_NAMING_MEMBERS)).toStrictEqual([
      REPOS_SCENARIO.id,
    ]);
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

  it("refuses the branch-context read for a scenario that scripts none", async () => {
    // The registered reply is FLAT: it returns the context's fields directly and has no
    // member on which "there is none" could ride. So a fabricated empty value would be
    // a shape no daemon sends, and the honest answer for a script that has not said is
    // the same "not checked" the live bridge takes.
    const port = fixturePort();

    const outcome = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome).not.toHaveProperty("value");
  });

  it("serves a scripted context flat, where the live bridge refuses by name", async () => {
    // The distinction that survives: a scenario that states a context is answered with
    // the registered shape, and a release build refuses the same call naming who owes
    // the wire. A summary renders those differently, and both halves have to be
    // reachable for it to have been built against either.
    const scripted = await createFixtureBridge({
      scenario: REPOS_SCENARIO,
    }).growth.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });
    expect(scripted.status).toBe("served");
    if (scripted.status === "served") {
      expect(scripted.value.baseBranch).toBe("develop");
    }

    const live = await createLiveBridge(createTier1Bridge()).growth.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
    });

    expect(live.status).toBe("unavailable");
    if (live.status === "unavailable") {
      expect(live.slateRow).toBe("gitflow-actions");
      expect(live.owningDocument).toContain("Spec-011");
    }
    expect(live).not.toHaveProperty("value");
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
              return BRANCH_CONTEXT_BY_WORKTREE_ID[worktreeId];
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
    expect(first.value.headBranch).toBe("feature/first");
    expect(second.value.headBranch).toBe("feature/second");
  });

  it("negative control: an unscripted worktree refuses, never another's context", async () => {
    // The half that proves the case above is about the request rather than about call
    // order. A worktree the scenario answers for by name gets its context; one it does
    // not is refused, because `resultFor` answering `undefined` settles as unscripted.
    // A helper that discarded the request could not tell these two apart at all, and a
    // port that fell back to whatever it last had would hand one root another's branch.
    const port = createFixtureBridge({
      scenario: {
        ...FLAGSHIP_SCENARIO,
        id: "scripts-one-branch-context",
        replies: [
          {
            call: "gitflow.branchContextRead",
            resultFor: (request) =>
              (request as { readonly worktreeId: string }).worktreeId === "worktree-1"
                ? BRANCH_CONTEXT_BY_WORKTREE_ID["worktree-1"]
                : undefined,
          },
        ],
      },
    }).growth;

    const unscripted = await port.gitflowBranchContextRead({
      workspaceId: "workspace-1",
      worktreeId: "worktree-2",
    });

    expect(unscripted.status).toBe("unavailable");
    expect(unscripted).not.toHaveProperty("value");
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
