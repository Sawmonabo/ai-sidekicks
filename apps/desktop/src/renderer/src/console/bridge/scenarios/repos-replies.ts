// What a call gets back in the repos scenario.
//
// Split out of `repos.ts` on that file's own seam — see `repos-fixture-data.ts`'s
// header. Every answer here is a shape `packages/contracts` registers, because the
// repos section parses each `repo.*` reply with the contract's own schema and a
// reply that failed to parse would render as an absence rather than as the fixture
// the scenario meant to state.
//
// THE HEALTH VERDICTS ARE THE TWO THE CONTRACT SHIPS. `RepoMountHealth.status` in
// `packages/contracts/src/repo.ts` is `healthy | unreachable` today; the third
// verdict the console's repos design renders lands with Plan-009's own phase, and a
// fixture that served it now would be scripting a value no daemon can send.
//
// ONE ANSWER PER CALL, WHICH BOUNDS WHAT THIS FILE CAN STATE. `ScenarioEngine.replyFor`
// matches on the method name alone and ignores the request, so `repo.mountRead` has
// exactly one answer for a session with two mounts. The git mount is the one it
// answers with, because it is the mount both health axes and the reduced-capability
// contrast are read against; the plain mount reaches the section through
// `repo.workspaceList`, which is session-scoped and names both.

import type { ConsoleScenario } from "../scenario.js";

import {
  BRANCH_CONTEXT_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  NODE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REVIEWER_WORKTREE_ID,
  SESSION_ID,
} from "./repos-fixture-data.js";

/** Every scripted answer this scenario has, in the order a reader meets them. */
export const REPOS_SCENARIO_REPLIES: ConsoleScenario["replies"] = [
  {
    // `Spec-009`'s only health-carrying read. `localPath` and `canonicalRoot`
    // differ here on purpose: the mount was entered from a nested subdirectory,
    // which is the case that separates provenance from resolved identity and the
    // reason the card surfaces both.
    call: "repo.mountRead",
    result: {
      id: GIT_MOUNT_ID,
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      localPath: "/Users/dev/code/ai-sidekicks/packages/contracts",
      canonicalRoot: "/Users/dev/code/ai-sidekicks",
      vcsType: "git",
      state: "attached",
      health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
      attachedAt: "2026-01-01T09:05:00.200Z",
    },
  },
  {
    // The WORKSPACE-scoped arm of `repo.executionModeCapabilitiesRead` — the
    // post-bind question the mode picker asks. The answer is the git mount's,
    // matching the mount `repo.mountRead` above returns: all four modes, with
    // `worktree` the default for the next writable coding run per ADR-006, and no
    // `restrictions` map at all, because a git mount restricts nothing (D-009-5).
    // `defaultMode` is deliberately NOT the workspace's current mode: the rows
    // below are all bound `read-only`, which is what a new workspace stays until a
    // run explicitly selects otherwise, and the picker labels the two separately.
    call: "repo.executionModeCapabilitiesRead",
    result: {
      availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
      defaultMode: "worktree",
    },
  },
  {
    // What an explicit switch answers with. `provisioning` rather than `ready`,
    // and no `executionRoot`: a writable select returns while the workspace is
    // still provisioning and the root does not exist yet, and a placeholder root
    // would be a guess the contract admits no fallback for (I-010-7).
    call: "repo.executionModeSelect",
    result: {
      workspaceId: GIT_WORKSPACE_ID,
      executionMode: "worktree",
      state: "provisioning",
    },
  },
  {
    // Session-scoped rather than mount-scoped. The git workspace is `read-only`,
    // which is what a new workspace stays until a run explicitly selects a writable
    // mode; the plain one is `stale`, agreeing with the beat above it, and carries
    // the daemon's own sentence about why rather than an empty row.
    call: "repo.workspaceList",
    result: {
      workspaces: [
        {
          id: GIT_WORKSPACE_ID,
          repoMountId: GIT_MOUNT_ID,
          executionMode: "read-only",
          state: "ready",
          fsRoot: "/Users/dev/code/ai-sidekicks",
        },
        {
          id: PLAIN_WORKSPACE_ID,
          repoMountId: PLAIN_MOUNT_ID,
          executionMode: "read-only",
          state: "stale",
          fsRoot: "/Users/dev/notes",
          lastError: "The bound path is no longer reachable on this node.",
        },
      ],
    },
  },
  {
    // The roots the two `worktree.ready` beats above created, as the only read that
    // names a worktree at all returns them. Both hang off the GIT mount: a worktree is
    // a git-backed execution root, so the plain-directory mount has none and the
    // section draws that mount's roots as the `empty` kind of nothing rather than as
    // an unasked question.
    //
    // `ephemeralClones` is present and empty rather than omitted, because the contract
    // requires both arrays and a session that has bound no clone returns an empty one —
    // which is a lawful answer and the one this scenario states, since its two agents
    // both run in worktrees.
    //
    // The IMPLEMENTER's root is `dirty`, agreeing with the beat above it: the reclaim
    // controls have to be unavailable somewhere, and a fixture whose every root is
    // clean cannot reach that state.
    call: "repo.worktreeStatusRead",
    result: {
      worktrees: [
        {
          worktreeId: IMPLEMENTER_WORKTREE_ID,
          repoMountId: GIT_MOUNT_ID,
          // The same string the branch context below carries as its head branch: the
          // gate drawn under this root and the root itself are one piece of work, and
          // two spellings of one branch is how a fixture stops representing a session.
          branchName: "feat/rate-limit-wiring",
          fsRoot: "/Users/dev/code/ai-sidekicks-worktrees/rate-limit-wiring",
          state: "dirty",
          createdBySessionId: SESSION_ID,
          createdAt: "2026-01-01T09:05:00.700Z",
          updatedAt: "2026-01-01T09:05:01.200Z",
        },
        {
          worktreeId: REVIEWER_WORKTREE_ID,
          repoMountId: GIT_MOUNT_ID,
          branchName: "review/rate-limit-wiring",
          fsRoot: "/Users/dev/code/ai-sidekicks-worktrees/review-rate-limit-wiring",
          state: "ready",
          createdBySessionId: SESSION_ID,
          createdAt: "2026-01-01T09:05:00.840Z",
          updatedAt: "2026-01-01T09:05:00.840Z",
        },
      ],
      ephemeralClones: [],
    },
  },
  {
    // The first growth read this fixture answers from a SCRIPT rather than from a
    // derivation. `createFixtureGrowthPort` routes `gitflowBranchContextRead`
    // through `answerFromScriptedReply`, so the reply below is served verbatim on
    // the frozen clock, and the two non-arrival refusals a real read has stay
    // reachable. Until this entry existed the port answered every scenario with the
    // absence, and the proposal gate could only ever be drawn against a session
    // with no branch context at all.
    //
    // The four values are `Spec-011 §Interfaces And Contracts`'s and are wire
    // strings the console never computes: nothing here derives a branch name from a
    // pane, a tab, or a focused view. `worktreeId` is the anchoring this context
    // actually has — `branch_contexts` carries an at-most-one association check, so
    // naming `ephemeralCloneId` beside it would be a shape no producer can emit.
    call: "gitflow.branchContextRead",
    result: {
      branchContext: {
        branchContextId: BRANCH_CONTEXT_ID,
        workspaceId: GIT_WORKSPACE_ID,
        baseBranch: "develop",
        headBranch: "feat/rate-limit-wiring",
        upstreamRef: "origin/feat/rate-limit-wiring",
        worktreeId: IMPLEMENTER_WORKTREE_ID,
      },
    },
  },
];
