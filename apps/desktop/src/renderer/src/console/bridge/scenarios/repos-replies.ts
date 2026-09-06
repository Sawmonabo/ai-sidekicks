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
// THE THREE ENTITY-SCOPED READS ANSWER PER ENTITY. `ScenarioEngine.replyFor` matches
// on the method name, so a constant reply is one answer for every call of that method —
// right for `repo.workspaceList`, which is session-scoped, and wrong for
// `repo.mountRead`, `repo.executionModeCapabilitiesRead`, and `gitflow.branchContextRead`,
// which each name the thing they want. All three are `resultFor` computations over the
// request, keyed by the tables below; a request naming no entity this scenario holds
// returns `undefined` and the fixture refuses, which is the honest answer for a
// scenario that scripts two mounts and is asked about a third.
//
// THE PLAIN MOUNT IS NOT A COPY OF THE GIT ONE WITH A DIFFERENT ID. It is `none`-vcs
// and `unreachable`, agreeing with the `workspace.stale` beat and with the workspace
// row's own `lastError`; its capabilities are the D-009-5 answer for a non-git mount —
// `read-only` alone, with a reason per excluded mode, which is the I-009-8 explicit
// gap. A fixture that served the git answer for both would have drawn four execution
// modes on a mount that can host one.

import {
  WorktreeStatusReadResponseSchema,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import type { ConsoleScenario } from "../scenario.js";

import { scenarioInstant } from "./repos-beats.js";
import {
  EPHEMERAL_CLONE_ID,
  RECLAIMED_CLONE_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_BRANCH_CONTEXT_ID,
  IMPLEMENTER_WORKTREE_ID,
  NODE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REVIEWER_BRANCH_CONTEXT_ID,
  REVIEWER_WORKTREE_ID,
  SESSION_ID,
} from "./repos-fixture-data.js";

/**
 * A stamp for something the session ALREADY HAD when the scenario opens.
 *
 * DERIVED FROM THE ONE START AND NEGATIVE ON PURPOSE. Every record below states a
 * fact the fixture wants already true at the first read — a mount attached, a root
 * created, a probe taken, a clone reclaimed — and each was transcribed as a literal
 * a fraction of a second AFTER `REPOS_SCENARIO_STARTED_AT_ISO`. That is not a
 * rounding difference: the section's read lands one debounce interval after the
 * start, `repo-mounts-reader.ts` stamps that instant onto the reading, and
 * `WorktreeCard.tsx` draws `formatRelativeTime(record.createdAt, nowMilliseconds)` —
 * so a root created 0.70 s after the start rendered "Created in 1 second", a
 * future-tense age on a card describing something that had to exist before the
 * session could run in it.
 *
 * Derived rather than re-transcribed, so the ordering is a property of this module:
 * a stamp that belongs in the past is written as the distance it lies behind the
 * start, and a record added later cannot land ahead of it by a typo. `expiresAt` is
 * the one member that is NOT written through this, because a disposal deadline is a
 * future instant by definition — and `repos.test.ts` asserts exactly that split.
 */
function secondsBeforeStart(seconds: number): string {
  return scenarioInstant(-seconds * 1_000);
}

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
    health: { status: "healthy", checkedAt: secondsBeforeStart(9) },
    attachedAt: secondsBeforeStart(53 * 60 + 11),
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
    health: { status: "unreachable", checkedAt: secondsBeforeStart(9) },
    // BEHIND THE SCENARIO'S OWN START, like every stamp in this file, and therefore
    // NOT the instant the `repo.attached` beat carries. The two are not one instant:
    // a beat's `occurredAt` is where the line sits in a replay window two seconds
    // wide, and this is the durable row's own field, which is what a card measures an
    // age against. Spelled as the beat's position, as it was, every card drew an age
    // in the future.
    attachedAt: secondsBeforeStart(23 * 60 + 4),
  },
};

/**
 * What the workspace-scoped arm of `repo.executionModeCapabilitiesRead` answers.
 *
 * `defaultMode` is deliberately NOT the workspace's current mode: the git row below is
 * bound `branch` and the plain one `read-only`, while this field reports the default
 * for the next writable coding run — `worktree` on the git mount, which agrees with
 * neither. The picker labels the two separately and a reader who conflates them will
 * think one is wrong.
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
        // `scheduled` arm — the disposal is still coming and the card draws the
        // countdown to it. One of the two members in this file written forward, for
        // the reason the sibling row states.
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
        // Ahead of the scenario's own instant, like the row above, because a disposal
        // deadline is a future instant by definition — and the two are the only members
        // in this file written forward. What separates the two clones is therefore NOT
        // the deadline: it is the stamp below. This one has been reclaimed while its
        // deadline is still coming, which is the only way to reach the reclaimed
        // disposition, and a card that derived disposition from `expiresAt` alone would
        // draw it as awaiting a disposal that has already happened.
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
    // SCHEDULED arm — its disposal is still coming, which is the reading the countdown
    // is drawn from and the one the section's own clock case pins. The second carries
    // `cleanedAt` while its deadline is likewise still ahead, which is the only way to
    // reach the reclaimed disposition: a card that derived disposition from `expiresAt`
    // alone would draw it as awaiting a disposal that has already happened.
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
];
