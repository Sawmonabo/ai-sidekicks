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
// THE TWO ENTITY-SCOPED READS ANSWER PER ENTITY. `ScenarioEngine.replyFor` matches on
// the method name, so a constant reply is one answer for every call of that method —
// right for `repo.workspaceList`, which is session-scoped, and wrong for
// `repo.mountRead` and `repo.executionModeCapabilitiesRead`, which each name the thing
// they want. Both are `resultFor` computations over the request, keyed by the tables
// below; a request naming neither entity returns `undefined` and the fixture refuses,
// which is the honest answer for a scenario that scripts two mounts and is asked about
// a third.
//
// THE PLAIN MOUNT IS NOT A COPY OF THE GIT ONE WITH A DIFFERENT ID. It is `none`-vcs
// and `unreachable`, agreeing with the `workspace.stale` beat and with the workspace
// row's own `lastError`; its capabilities are the D-009-5 answer for a non-git mount —
// `read-only` alone, with a reason per excluded mode, which is the I-009-8 explicit
// gap. A fixture that served the git answer for both would have drawn four execution
// modes on a mount that can host one.

import type { ConsoleScenario } from "../scenario.js";

import {
  BRANCH_CONTEXT_ID,
  EPHEMERAL_CLONE_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  NODE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REVIEWER_WORKTREE_ID,
  SESSION_ID,
} from "./repos-fixture-data.js";

/**
 * What `repo.mountRead` answers, per mount.
 *
 * The GIT mount's `localPath` and `canonicalRoot` differ on purpose: it was entered
 * from a nested subdirectory, which is the case that separates provenance from
 * resolved identity and the reason the card surfaces both. The PLAIN mount's agree,
 * because it was entered at its own root — the contrast is what makes the pair worth
 * scripting rather than one row twice.
 *
 * The plain mount is `unreachable`, agreeing with the `workspace.stale` beat and with
 * the `lastError` its workspace row carries below. Health is the one axis this read
 * alone carries, so a session whose every mount is healthy cannot reach the degraded
 * card at all.
 */
const MOUNT_READS_BY_MOUNT_ID: Readonly<Record<string, unknown>> = {
  [GIT_MOUNT_ID]: {
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
  [PLAIN_MOUNT_ID]: {
    id: PLAIN_MOUNT_ID,
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    localPath: "/Users/dev/notes",
    canonicalRoot: "/Users/dev/notes",
    // `none`, which is `Spec-009`'s honest non-git classification (I-009-4) and not a
    // third "unknown" verdict: the resolver either found a repository or did not.
    vcsType: "none",
    state: "attached",
    health: { status: "unreachable", checkedAt: "2026-01-01T09:05:01.000Z" },
    // The instant the `repo.attached` beat states for this mount. Two spellings of
    // one attachment is how a fixture stops representing a session.
    attachedAt: "2026-01-01T09:05:00.420Z",
  },
};

/**
 * What the workspace-scoped arm of `repo.executionModeCapabilitiesRead` answers.
 *
 * `defaultMode` is deliberately NOT the workspace's current mode: both workspace rows
 * below are bound `read-only`, which is what a new workspace stays until a run
 * explicitly selects otherwise, while this field reports the default for the next
 * writable coding run. The picker labels the two separately and a reader who conflates
 * them will think one is wrong.
 *
 * The plain workspace is the D-009-5 answer for a `none` mount: `read-only` alone,
 * `read-only` as the default because no writable mode exists to default to, and a
 * reason for each excluded mode — I-009-8's explicit-gap mandate, which is the half a
 * surface renders when it explains why a control is not offered.
 */
const CAPABILITIES_BY_WORKSPACE_ID: Readonly<Record<string, unknown>> = {
  [GIT_WORKSPACE_ID]: {
    // All four, with no `restrictions` map at all, because a git mount restricts
    // nothing (D-009-5), and `worktree` the default per ADR-006.
    availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
    defaultMode: "worktree",
  },
  [PLAIN_WORKSPACE_ID]: {
    availableModes: ["read-only"],
    defaultMode: "read-only",
    restrictions: {
      branch: "This mount is not a git repository, so there is no branch to create.",
      worktree: "This mount is not a git repository, so no worktree can be added.",
      "ephemeral clone": "This mount is not a git repository, so there is nothing to clone.",
    },
  },
};

/**
 * The answer this table holds for the entity one request names, or `undefined`.
 *
 * The request reaches a computed reply as `unknown` and is read rather than cast: a
 * fixture that trusted the shape would throw from inside the settlement seam on a
 * malformed call, where the fixture's own "scripts no reply" refusal is the answer a
 * surface can act on. `undefined` reaches the caller as exactly that refusal.
 */
function answerFor(
  answersByEntityId: Readonly<Record<string, unknown>>,
  entityIdMember: string,
  request: unknown,
): unknown {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const requestedEntityId = (request as Readonly<Record<string, unknown>>)[entityIdMember];
  return typeof requestedEntityId === "string" ? answersByEntityId[requestedEntityId] : undefined;
}

/** Every scripted answer this scenario has, in the order a reader meets them. */
export const REPOS_SCENARIO_REPLIES: ConsoleScenario["replies"] = [
  {
    // `Spec-009`'s only health-carrying read, answered per mount.
    call: "repo.mountRead",
    resultFor: (request) => answerFor(MOUNT_READS_BY_MOUNT_ID, "repoMountId", request),
  },
  {
    // The WORKSPACE-scoped arm of `repo.executionModeCapabilitiesRead` — the
    // post-bind question the mode picker asks, answered per workspace.
    call: "repo.executionModeCapabilitiesRead",
    resultFor: (request) => answerFor(CAPABILITIES_BY_WORKSPACE_ID, "workspaceId", request),
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
    // `ephemeralClones` carries ONE row, and it is the only way this scenario can reach
    // that list at all: clone transitions are not separately evented, so no beat can
    // state a clone and this read is the whole surface. It is past its disposal time on
    // purpose — the elapsed reading is the one state on §10.3's surface that arrives
    // with nobody acting, and a fixture whose clone was merely scheduled could not
    // reach it.
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
          expiresAt: "2026-01-01T09:05:01.500Z",
          createdAt: "2026-01-01T09:05:00.960Z",
        },
      ],
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
