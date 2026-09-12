// What an ACT gets back in the repos scenario, on both of its arms.
//
// SPLIT OFF `repos-replies.ts` BECAUSE THE SUBJECT IS DIFFERENT, not because that file
// grew. A read answers with the state of something that already exists; an act answers
// with what the daemon DID, and every one of these can be refused with a typed code the
// console renders a named recovery for. A fixture that scripted only the success arm
// would ship every one of those recoveries undrawn — so each act below is scripted so
// that a person opening this scenario can reach both arms by choosing a different
// subject, and none of them needs a second scenario to do it.
//
// THE REFUSING ARM IS CHOSEN BY THE REQUEST, WHICH IS WHY THESE ARE COMPUTED REPLIES.
// A `refusal` entry refuses every call of that method, which would put the success arm
// out of reach; a `resultFor` that throws a `WireErrorEnvelope` refuses exactly the
// requests the scenario says the daemon would refuse and serves the rest. The two are
// different facts and the computed arm is the only one that can hold both.
//
// THE FIXTURE MAY COMPARE A PATH AND THE RENDERER MAY NOT. `repo.attach` below refuses
// `repo.already_attached` for the git mount's own root, which means reading the request
// and comparing a string — the daemon's job under the local trust envelope, and this
// module is standing in for the daemon. Nothing in `console/repos/` does the same,
// and the recovery that refusal renders is deliberately a place to go rather than a
// link the console resolves.
//
// EVERY REPLY IS A SHAPE `packages/contracts` REGISTERS, on `repos-replies.ts`'s rule:
// the call door parses each `repo.*` reply with the contract's own schema, so a reply
// this scenario invented a member on would arrive at a surface as a refusal rather than
// as the fixture the scenario meant to state. The one exception is the last entry,
// which answers a GROWTH operation the corpus registers no shape for at all — and it is
// keyed under the `growth:` prefix precisely so that nothing reads it as a wire method.

import type { ConsoleScenario } from "../runtime/index.js";

import { refuseAs, requestedIdentifier } from "../computed-reply.js";
import { scenarioInstant } from "./repos-beats.js";
import {
  ATTACHED_MOUNT_ID,
  ATTACHED_WORKSPACE_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_BOUND_ROOT,
  GIT_WORKSPACE_CHECKOUT_ROOT,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  PREPARED_BRANCH_CONTEXT_ID,
  PREPARED_CLONE_ID,
  PREPARED_WORKTREE_ID,
  RECLAIMED_CLONE_ID,
  REVIEWER_WORKTREE_ID,
} from "./repos-fixture-data.js";

/**
 * How this scenario keys the workspace execution-context read.
 *
 * THE `growth:` PREFIX IS THE RULE AND NOT A STYLE. That operation's ledger row
 * registers no wire method — the normalized checkout root is a column on a daemon table
 * and the fallback marker is no field anywhere — so there is no method name to
 * transcribe, and `bridge/scenario/wire-truth/reply-walk.ts` admits exactly this shape
 * for a row in that position. Inventing a plausible `repo.…` string instead would
 * script the fixture against a key the live transport can never send.
 *
 * Exported because the fixture's own handler routes on it: restated as a literal there,
 * a rename would move this constant and the reply and leave that handler answering a
 * key nothing sends.
 */
export const REPOS_EXECUTION_CONTEXT_CALL = "growth:workspaceExecutionContextRead";

/** The root the scenario's healthy git mount resolves to. */
const GIT_CANONICAL_ROOT = "/Users/dev/code/ai-sidekicks";

/**
 * The root the mount `repo.attach` mints resolves to.
 *
 * One constant because three replies state it — the attach that mints the mount, the
 * read-only bind that answers with its `fsRoot`, and the execution context that runs
 * there — and a fixture whose three views of one root were three literals would drift
 * in exactly the direction the disclosure under test reads.
 */
export const ATTACHED_CANONICAL_ROOT = "/Users/dev/code/telemetry-agent";

/** Where this scenario's worktrees live, one directory up from the checkout. */
const WORKTREE_PARENT = "/Users/dev/code/ai-sidekicks-worktrees";

/**
 * What `repo.attach` answers, per entered path.
 *
 * THREE ARMS, EACH REACHABLE FROM THE DIALOG. A path this scenario does not recognise
 * attaches and mints its default `read-only` workspace, which is
 * the unconditional post-attach state and the shape the
 * dialog's success path renders. The git mount's own root refuses `repo.already_attached`
 * — a second working tree of one repository being a re-attach by design — and the one
 * path below that names a file rather than a repository refuses
 * `repo.root_resolution_failed`, which the console must never re-read as "attached as a
 * plain directory".
 *
 * The DRIFTED mount's root is deliberately NOT one of the refusing arms: re-attaching
 * after an identity mismatch is the remedy that surface offers, and it has to succeed —
 * minting a new mount row, which is exactly what the confirm says it will do.
 */
function attachResultFor(request: unknown): unknown {
  const localPath = requestedIdentifier(request, "localPath");
  if (localPath === GIT_CANONICAL_ROOT) {
    refuseAs(
      "repo.already_attached",
      "The resolved root is already attached to this session on this node.",
    );
  }
  if (localPath === "/Users/dev/code/vendor-sdk/README.md") {
    refuseAs(
      "repo.root_resolution_failed",
      "No repository root could be resolved for the supplied path.",
    );
  }
  return {
    repoMountId: ATTACHED_MOUNT_ID,
    state: "attached",
    vcsType: "git",
    canonicalRoot: ATTACHED_CANONICAL_ROOT,
    defaultWorkspaceId: ATTACHED_WORKSPACE_ID,
  };
}

/**
 * What `repo.workspaceBind` answers, per mount and mode.
 *
 * The two arms are the two the contract's own optionality is FOR. A `read-only` bind has
 * its root immediately and carries `fsRoot` on the same reply; a writable bind returns
 * `provisioning` with no root at all, because the execution root does not exist yet and
 * a placeholder would be a guess. A surface that only ever saw one of them would have
 * rendered "Root pending" never or always.
 *
 * The PLAIN mount refuses `workspace.mode_unsupported` for every writable mode, agreeing
 * with the capabilities read that restricts each of them with a reason — which is what
 * makes that code's recovery, the mount's own restriction reason, reachable.
 */
function bindResultFor(request: unknown): unknown {
  const executionMode = requestedIdentifier(request, "executionMode");
  const repoMountId = requestedIdentifier(request, "repoMountId");
  if (executionMode === undefined) {
    return undefined;
  }
  if (repoMountId !== GIT_MOUNT_ID && repoMountId !== ATTACHED_MOUNT_ID) {
    if (executionMode !== "read-only") {
      refuseAs(
        "workspace.mode_unsupported",
        "This workspace cannot be bound in the requested execution mode.",
      );
    }
  }
  if (executionMode === "read-only") {
    return {
      workspaceId: ATTACHED_WORKSPACE_ID,
      fsRoot: ATTACHED_CANONICAL_ROOT,
      executionMode,
      state: "ready",
    };
  }
  return { workspaceId: ATTACHED_WORKSPACE_ID, executionMode, state: "provisioning" };
}

/**
 * What `repo.executionRootPrepare` answers.
 *
 * BOTH REFUSALS THE FORM CAN EARN ARE HERE, and each is a different mistake. A writable
 * prepare with no branch draws `workspace.branch_name_required`, which is the one field
 * whose optionality on the wire does not mean optional — a wire prepare is pre-run by
 * definition and the daemon has nothing to derive a slug from. A branch that already has
 * a live checkout draws `worktree.branch_collision`, because a name a user typed
 * is never silently adapted.
 *
 * The served arm carries `worktreeId` and `branchContextId` and no `ephemeralCloneId`:
 * the three ids are mode-discriminated, and a prepare that returned two of them would be
 * a shape no producer can emit.
 *
 * AND IT SETTLES `ready`, WHICH IS THE ONLY STATE A SUCCESSFUL PREPARE HAS. The live
 * service awaits the reprovision completion before it answers and returns `ready`
 * unconditionally on that path; every way of not reaching it throws instead, so
 * `provisioning` — which this entry used to answer — is a settlement no producer can
 * emit and a surface pinned against it was drawing a state that will never arrive.
 * In-flight provisioning is real and reaches the console by another road: the workspace
 * lifecycle, where `repo.executionModeSelect` answers `provisioning` and the roster row
 * follows the transition. A mutation's own reply is not that road.
 */
function executionRootPrepareResultFor(request: unknown): unknown {
  const branchName = requestedIdentifier(request, "branchName");
  if (branchName === undefined) {
    refuseAs(
      "workspace.branch_name_required",
      "A pre-run execution-root prepare must name the branch.",
    );
  }
  if (branchName === "feat/rate-limit-wiring") {
    refuseAs("worktree.branch_collision", "That branch already has a live checkout on this mount.");
  }
  return {
    executionRoot: `${WORKTREE_PARENT}/${branchName.replaceAll("/", "-")}`,
    state: "ready",
    worktreeId: PREPARED_WORKTREE_ID,
    branchContextId: PREPARED_BRANCH_CONTEXT_ID,
  };
}

/**
 * What `repo.worktreeReuseCheck` answers, per branch.
 *
 * THE THREE ANSWERS ARE THE THREE THE CONTROL HAS TO DRAW DIFFERENTLY, and none is
 * reachable from either of the others. The implementer's branch has a live candidate
 * that is DIRTY and compatible — the one case that offers the separate acknowledgement.
 * The reviewer's has a live candidate that is clean and INCOMPATIBLE, which offers no
 * override at all, because it is never bindable. Any
 * other branch has no candidate, which is the complete, well-formed negative answer.
 */
function reuseCheckResultFor(request: unknown): unknown {
  const branchName = requestedIdentifier(request, "branchName");
  if (branchName === "feat/rate-limit-wiring") {
    return {
      available: true,
      worktreeId: IMPLEMENTER_WORKTREE_ID,
      state: "dirty",
      branchName,
      isClean: false,
      compatible: true,
      reason: "The checkout has uncommitted changes.",
    };
  }
  if (branchName === "review/rate-limit-wiring") {
    return {
      available: true,
      worktreeId: REVIEWER_WORKTREE_ID,
      state: "ready",
      branchName,
      isClean: true,
      compatible: false,
      reason: "The candidate was created under a different branch strategy.",
    };
  }
  return { available: false };
}

/**
 * What `repo.worktreeRetire` answers, per worktree.
 *
 * The implementer's root is the one an active run holds, so retiring it draws
 * `worktree.retire_conflict` — the refusal that makes the confirm's consequence real
 * rather than decorative. Every other root retires, and the reply carries no `cleanedAt`
 * because at the moment it is produced nothing has been cleaned.
 */
function retireResultFor(request: unknown): unknown {
  const worktreeId = requestedIdentifier(request, "worktreeId");
  if (worktreeId === IMPLEMENTER_WORKTREE_ID) {
    refuseAs(
      "worktree.retire_conflict",
      "This worktree is the execution root an active run holds.",
    );
  }
  if (worktreeId === undefined) {
    return undefined;
  }
  return { worktreeId, state: "retired" };
}

/**
 * What `repo.ephemeralCloneDispose` answers, per clone.
 *
 * The already-reclaimed clone draws `clone.not_found`, which is the state a disposal
 * race actually reaches: the deadline sweep took it between the read that drew the card
 * and the press. Every other clone disposes.
 */
function disposeResultFor(request: unknown): unknown {
  const cloneId = requestedIdentifier(request, "cloneId");
  if (cloneId === RECLAIMED_CLONE_ID) {
    refuseAs("clone.not_found", "This ephemeral clone no longer exists.");
  }
  if (cloneId === undefined) {
    return undefined;
  }
  return { cloneId, state: "retired" };
}

/**
 * What the workspace execution-context read answers, per workspace.
 *
 * THE GIT WORKSPACE IS THE INTERESTING ONE, and it is the only binding in which the
 * three roots genuinely differ. It is bound `branch`, which under
 * turn-boundary snapshots mean the execution root is the user's own
 * live working tree — here a linked worktree rather than the checkout the mount resolved
 * to — and it is bound at a SUBDIRECTORY of that tree, which the same rule normalizes to
 * the enclosing working-tree top level. So the bound root is nested inside the
 * normalized checkout root, and both differ from the mount's canonical root: three
 * facts about one binding rather than one path written three ways.
 *
 * THE NESTING IS THE CLAIM, AND THE FIXTURE USED TO STATE A TYPO INSTEAD. This entry
 * once answered `boundRoot` and the same directory suffixed `/.`, which the disclosure
 * reports as "the roots differ" because it compares bytes — a true reading of a fixture
 * that was saying nothing, and a surface pinned against a spelling discrepancy rather
 * than against the case it exists to draw.
 *
 * IT ALSO CARRIES THE FALLBACK MARKER, naming the mode it was substituted away FROM.
 * A substituted mode has to be marked distinctly from
 * normal worktree mode, and a scenario in which nothing was ever substituted cannot draw
 * that badge at all.
 *
 * THE ATTACHED WORKSPACE IS THE OTHER HALF OF THE COMPARISON, and it is the only
 * binding whose three roots agree: it is bound in the mount's own checkout, so the
 * snapshot service normalizes to the root it was bound at. Without it the summary's
 * agreement arm is unreachable from any workspace this scenario holds, and a surface
 * whose only served reading is a disagreement cannot show that it can tell the two
 * apart.
 *
 * The DRIFTED workspace is deliberately absent from this table: a mount whose binds are
 * already refusing has no execution context to report, and the disclosure draws that as
 * the unanswered question it is rather than as an absence of roots.
 */
function executionContextResultFor(request: unknown): unknown {
  const workspaceId = requestedIdentifier(request, "workspaceId");
  if (workspaceId === GIT_WORKSPACE_ID) {
    return {
      workspaceId,
      boundRoot: GIT_WORKSPACE_BOUND_ROOT,
      checkoutRoot: GIT_WORKSPACE_CHECKOUT_ROOT,
      fallbackFromMode: "worktree",
    };
  }
  if (workspaceId === ATTACHED_WORKSPACE_ID) {
    return {
      workspaceId,
      boundRoot: ATTACHED_CANONICAL_ROOT,
      checkoutRoot: ATTACHED_CANONICAL_ROOT,
    };
  }
  return undefined;
}

/** Every act this scenario answers, spread into the scenario's one reply list. */
export const REPOS_MUTATION_REPLIES: ConsoleScenario["replies"] = [
  { call: "repo.attach", resultFor: attachResultFor },
  { call: "repo.workspaceBind", resultFor: bindResultFor },
  { call: "repo.executionRootPrepare", resultFor: executionRootPrepareResultFor },
  { call: "repo.worktreeReuseCheck", resultFor: reuseCheckResultFor },
  {
    // The one act with no refusing arm scripted, and the reason is the request rather
    // than an omission: every member of a clone prepare that a user can get
    // wrong — the workspace, the branch — is refused by one of the acts above under a
    // code this table would only be restating. What it does state is the EFFECTIVE
    // cleanup policy, which the daemon applies and echoes back, and a deadline ahead of
    // the scenario's own instant so the prepared clone's countdown is drawable.
    //
    // `ready` FOR THE PREPARE ABOVE'S REASON, on the same rule: the clone service's own
    // return type narrows this member to `ready` and documents that a prepare which did
    // not reach it throws, so `creating` — which this entry used to answer — is a state
    // the row passes through and the reply never carries.
    call: "repo.ephemeralClonePrepare",
    result: {
      cloneId: PREPARED_CLONE_ID,
      cloneRoot: "/Users/dev/code/ai-sidekicks-clones/telemetry-probe",
      state: "ready",
      cleanupPolicy: "on_run_complete",
      branchName: "probe/telemetry",
      expiresAt: scenarioInstant(45 * 60_000),
    },
  },
  { call: "repo.worktreeRetire", resultFor: retireResultFor },
  { call: "repo.ephemeralCloneDispose", resultFor: disposeResultFor },
  { call: REPOS_EXECUTION_CONTEXT_CALL, resultFor: executionContextResultFor },
];
