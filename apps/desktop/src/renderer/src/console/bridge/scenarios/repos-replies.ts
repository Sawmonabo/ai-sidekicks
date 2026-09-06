// What a call gets back in the repos scenario.
//
// Split out of `repos.ts` on that file's own seam — see `repos-fixture-data.ts`'s
// header. Every answer here is a shape `packages/contracts` registers, because the
// repos section parses each `repo.*` reply with the contract's own schema and a
// reply that failed to parse would render as an absence rather than as the fixture
// the scenario meant to state.
//
// THE THREE MOUNT READS AND THEIR CAPABILITIES ARE NEXT DOOR.
// `repos-mount-reads.ts` holds the two entity-scoped `repo.*` tables and the reader
// that keys them, because those answer PER REQUEST while everything here answers per
// METHOD. What is left in this module is the session-scoped rows — the workspace
// roster, the execution-root status, and the accepted mode switch — plus the branch
// context, which is entity-scoped and stays because it is `gitflow.*` rather than
// `repo.*` and belongs with no repo table. The list at the bottom composes all of it,
// and the mutation replies the acts send arrive by spread from
// `repos-mutation-replies.ts`.
//
// A SCENARIO STATES BOTH ARMS OF A MUTATION, WHICH IS WHY THE SPREAD IS WORTH A FILE.
// Every act this family sends can be refused with a typed daemon code, and a fixture
// that only ever answered success would leave every recovery in `mount-refusal-copy.ts`
// unreachable — the surfaces would ship having drawn one of their two states.

import {
  WorktreeStatusReadResponseSchema,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import type { ConsoleScenario } from "../scenario-runtime/index.js";

import { scenarioInstant, secondsBeforeStart } from "./repos-beats.js";
import { capabilitiesFor, mountReadFor } from "./repos-mount-reads.js";
import { REPOS_MUTATION_REPLIES } from "./repos-mutation-replies.js";
import {
  DRIFTED_MOUNT_ID,
  DRIFTED_WORKSPACE_ID,
  EPHEMERAL_CLONE_ID,
  RECLAIMED_CLONE_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_BRANCH_CONTEXT_ID,
  IMPLEMENTER_WORKTREE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REVIEWER_BRANCH_CONTEXT_ID,
  REVIEWER_WORKTREE_ID,
  SESSION_ID,
} from "./repos-fixture-data.js";

/**
 * What `gitflow.branchContextRead` answers, per execution root.
 *
 * FLAT, because `BranchContextReadResponse` is: the context's fields ride the reply
 * directly and there is no `branchContext` envelope. A fixture that wrapped them
 * scripted a shape no daemon sends.
 *
 * Two rows, and the pair is the point. Each names its own `branchContextId` and its own
 * head branch — the same string the matching `repo.worktreeStatusRead` row carries as
 * that root's `branchName`, because the gate drawn under a root and the root itself are
 * one piece of work. `workspaceId` is the same on both: two worktrees of one mount
 * belong to one workspace, which is exactly why the worktree alone is not the key.
 */
const BRANCH_CONTEXTS_BY_WORKTREE_ID: Readonly<Record<string, unknown>> = {
  [IMPLEMENTER_WORKTREE_ID]: {
    branchContextId: IMPLEMENTER_BRANCH_CONTEXT_ID,
    workspaceId: GIT_WORKSPACE_ID,
    baseBranch: "develop",
    headBranch: "feat/rate-limit-wiring",
    upstreamRef: "origin/feat/rate-limit-wiring",
    worktreeId: IMPLEMENTER_WORKTREE_ID,
  },
  [REVIEWER_WORKTREE_ID]: {
    branchContextId: REVIEWER_BRANCH_CONTEXT_ID,
    workspaceId: GIT_WORKSPACE_ID,
    baseBranch: "develop",
    headBranch: "review/rate-limit-wiring",
    // No `upstreamRef`: the reviewer's branch has not been pushed, which is the state
    // that makes the member's absence reachable rather than a value nothing exercises.
    worktreeId: REVIEWER_WORKTREE_ID,
  },
};

/**
 * The context this scenario holds for the root one request names, or `undefined`.
 *
 * BOTH KEYS ARE CHECKED, because the pair is the key: a request naming another
 * workspace's id would resolve no row on the real wire, and answering it from the
 * worktree alone would teach a surface that a worktree id is globally unique when
 * `branch_contexts` retains one across workspaces. A request this scenario has no
 * context for returns `undefined` and settles as unscripted, which the fixture answers
 * with its own refusal.
 */
function branchContextFor(request: unknown): unknown {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const { workspaceId, worktreeId } = request as Readonly<Record<string, unknown>>;
  if (workspaceId !== GIT_WORKSPACE_ID || typeof worktreeId !== "string") {
    return undefined;
  }
  return BRANCH_CONTEXTS_BY_WORKTREE_ID[worktreeId];
}

/**
 * The scripted `repo.worktreeStatusRead` answer, typed by the wire it answers on.
 *
 * Parsed ONCE, here, against the contract — this module sits inside `bridge/`, which
 * is where the console's schemas are bound and the one place a suite outside it may
 * not reach them from. Exported as the typed value so a suite that rebuilds this reply
 * with one array changed (the reader test strips the clones to prove the two arrays
 * travel independently) spreads a wire-typed object instead of parsing the scenario a
 * second time, and so a fixture that drifts from the wire fails at import rather than
 * inside whichever surface first reads it.
 */
export const REPOS_WORKTREE_STATUS_REPLY: WorktreeStatusReadResponse =
  WorktreeStatusReadResponseSchema.parse({
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
        createdAt: secondsBeforeStart(51 * 60 + 26),
        updatedAt: secondsBeforeStart(3 * 60 + 40),
      },
      {
        worktreeId: REVIEWER_WORKTREE_ID,
        repoMountId: GIT_MOUNT_ID,
        branchName: "review/rate-limit-wiring",
        fsRoot: "/Users/dev/code/ai-sidekicks-worktrees/review-rate-limit-wiring",
        state: "ready",
        createdBySessionId: SESSION_ID,
        createdAt: secondsBeforeStart(28 * 60 + 2),
        updatedAt: secondsBeforeStart(28 * 60 + 2),
      },
    ],
    ephemeralClones: [
      {
        cloneId: EPHEMERAL_CLONE_ID,
        // WORKSPACE-anchored, where a worktree row is mount-anchored. The git
        // workspace, because a clone is a git clone and the plain-directory mount
        // could not host one.
        workspaceId: GIT_WORKSPACE_ID,
        cloneRoot: "/Users/dev/code/ai-sidekicks-clones/rate-limit-audit",
        branchName: "audit/rate-limit-wiring",
        state: "ready",
        cleanupPolicy: "on_run_complete",
        // AHEAD of the scenario's instant, which is what puts this clone on the
        // `scheduled` arm: the disposal is coming and the card draws the countdown.
        expiresAt: scenarioInstant(12 * 60_000),
        createdAt: secondsBeforeStart(17 * 60 + 15),
      },
      {
        cloneId: RECLAIMED_CLONE_ID,
        workspaceId: GIT_WORKSPACE_ID,
        cloneRoot: "/Users/dev/code/ai-sidekicks-clones/rate-limit-probe",
        branchName: "probe/rate-limit-wiring",
        state: "ready",
        cleanupPolicy: "on_run_complete",
        // Ahead of the start like the row above, so what separates the two clones is
        // NOT the deadline but the `cleanedAt` below: this one was reclaimed while its
        // deadline is still coming, the only way to reach the reclaimed disposition.
        expiresAt: scenarioInstant(30 * 60_000),
        createdAt: secondsBeforeStart(25 * 60 + 48),
        cleanedAt: secondsBeforeStart(9 * 60 + 12),
      },
    ],
  });

/** Every scripted answer this scenario has, in the order a reader meets them. */
export const REPOS_SCENARIO_REPLIES: ConsoleScenario["replies"] = [
  {
    // `Spec-009`'s only health-carrying read, answered per mount.
    call: "repo.mountRead",
    resultFor: (request) => mountReadFor(request),
  },
  {
    // The WORKSPACE-scoped arm of `repo.executionModeCapabilitiesRead` — the
    // post-bind question the mode picker asks, answered per workspace.
    call: "repo.executionModeCapabilitiesRead",
    resultFor: (request) => capabilitiesFor(request),
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
    // Session-scoped rather than mount-scoped. The git workspace is bound `branch`,
    // which is the one writable mode whose execution root is the mount's own checkout
    // and mints no worktree and no clone row — so it is the only binding under which a
    // fixture reaches the in-place root's change-proposal gate at all, and a scenario
    // that left both rows `read-only` drew two of the three writable roots and never
    // the third. The plain one stays `read-only`: its mount is `none`-vcs, and the
    // capabilities read above restricts every writable mode on it with a reason. That
    // row is `stale` besides, agreeing with the beat above it, and carries the
    // daemon's own sentence about why rather than an empty row.
    call: "repo.workspaceList",
    result: {
      workspaces: [
        {
          id: GIT_WORKSPACE_ID,
          repoMountId: GIT_MOUNT_ID,
          executionMode: "branch",
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
        {
          // The drifted mount's default workspace, `read-only` and `ready` — the row
          // states nothing about the mismatch, which is exactly the point: the
          // workspace list carries no health member by design, so this row is where a
          // surface must NOT be able to learn about it and the mount card is where it
          // does.
          id: DRIFTED_WORKSPACE_ID,
          repoMountId: DRIFTED_MOUNT_ID,
          executionMode: "read-only",
          state: "ready",
          fsRoot: "/Users/dev/code/vendor-sdk",
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
    // `ephemeralClones` carries TWO rows, and this read is the only way this scenario
    // can reach that list at all: clone transitions are not separately evented, so no
    // beat can state a clone and this read is the whole surface. The first is on the
    // SCHEDULED arm, which is the reading the countdown is drawn from and the one the
    // section's own clock case pins; the second carries `cleanedAt` while its deadline
    // is likewise still ahead, which is what the reclaimed disposition is read from. A
    // card deriving either from `expiresAt` alone would draw the reclaimed one as
    // awaiting a disposal that has already happened.
    //
    // The IMPLEMENTER's root is `dirty`, agreeing with the beat above it: the reclaim
    // controls have to be unavailable somewhere, and a fixture whose every root is
    // clean cannot reach that state.
    call: "repo.worktreeStatusRead",
    result: REPOS_WORKTREE_STATUS_REPLY,
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
    // ANSWERED PER ROOT, on the same rule the two entity-scoped `repo.*` reads above
    // follow. A method-only reply is one answer for every call, and this read is keyed
    // by the `(workspaceId, worktreeId)` PAIR — so a constant handed the reviewer's
    // gate the implementer's context id and the implementer's head branch, and the
    // scenario's screenshots and accessibility checks passed over a gate that had
    // never been bound per root at all.
    resultFor: (request) => branchContextFor(request),
  },
  // The acts. Spread rather than written here, so this module's subject stays "what a
  // READ answers" and the mutations' two-armed scripting has one home.
  ...REPOS_MUTATION_REPLIES,
];
