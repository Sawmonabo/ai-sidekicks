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
// and comparing a string — the daemon's job under
// `Spec-009 §Local Trust Envelope (V1 Definition)`, and this module is standing in for
// the daemon. Nothing in `console/repos/` does the same, and the recovery that refusal
// renders is deliberately a place to go rather than a link the console resolves.
//
// EVERY REPLY IS A SHAPE `packages/contracts` REGISTERS, on `repos-replies.ts`'s rule:
// the call door parses each `repo.*` reply with the contract's own schema, so a reply
// this scenario invented a member on would arrive at a surface as a refusal rather than
// as the fixture the scenario meant to state. The one exception is the last entry,
// which answers a GROWTH operation the corpus registers no shape for at all — and it is
// keyed under the `growth:` prefix precisely so that nothing reads it as a wire method.

import type { WireErrorEnvelope } from "../../core/index.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

import { scenarioInstant } from "./repos-beats.js";
import {
  ATTACHED_MOUNT_ID,
  ATTACHED_WORKSPACE_ID,
  GIT_MOUNT_ID,
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
 * transcribe, and `bridge/scenarios/wire-truth/reply-walk.ts` admits exactly this shape
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

/** Where this scenario's worktrees live, one directory up from the checkout. */
const WORKTREE_PARENT = "/Users/dev/code/ai-sidekicks-worktrees";

/** The member of a request this module reads, without trusting the request's shape. */
function requestedString(request: unknown, member: string): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const value = (request as Readonly<Record<string, unknown>>)[member];
  return typeof value === "string" ? value : undefined;
}

/**
 * Refuse as the daemon would, in the shape the wire refuses in.
 *
 * A thrown `WireErrorEnvelope` reaches the caller exactly as the `refusal` arm's does,
 * so a computed reply can hold a refusal and a success without the scenario needing two
 * entries for one call — which it could not have, since a second entry for one call is
 * unreachable.
 */
function refuseAs(code: string, message: string): never {
  const envelope: WireErrorEnvelope = { code, message };
  throw envelope;
}

/**
 * What `repo.attach` answers, per entered path.
 *
 * THREE ARMS, EACH REACHABLE FROM THE DIALOG. A path this scenario does not recognise
 * attaches and mints its default `read-only` workspace, which is
 * `Spec-009 §Default Behavior`'s unconditional post-attach state and the shape the
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
  const localPath = requestedString(request, "localPath");
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
    canonicalRoot: "/Users/dev/code/telemetry-agent",
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
  const executionMode = requestedString(request, "executionMode");
  const repoMountId = requestedString(request, "repoMountId");
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
      fsRoot: "/Users/dev/code/telemetry-agent",
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
 * a live checkout draws `worktree.branch_collision`, because a name a participant typed
 * is never silently adapted.
 *
 * The served arm carries `worktreeId` and `branchContextId` and no `ephemeralCloneId`:
 * the three ids are mode-discriminated, and a prepare that returned two of them would be
 * a shape no producer can emit.
 */
function executionRootPrepareResultFor(request: unknown): unknown {
  const branchName = requestedString(request, "branchName");
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
    state: "provisioning",
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
 * override at all, because `Spec-010 §Fallback Behavior` makes it never bindable. Any
 * other branch has no candidate, which is the complete, well-formed negative answer.
 */
function reuseCheckResultFor(request: unknown): unknown {
  const branchName = requestedString(request, "branchName");
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
  const worktreeId = requestedString(request, "worktreeId");
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
  const cloneId = requestedString(request, "cloneId");
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
 * three roots genuinely differ: it is bound `branch`, so its execution root is the
 * mount's own checkout while the snapshot service operates on a normalized checkout root
 * of its own. A disclosure drawn only against `worktree`-mode workspaces would show
 * three copies of one string and prove nothing.
 *
 * IT ALSO CARRIES THE FALLBACK MARKER, naming the mode it was substituted away FROM.
 * `Spec-010 §Fallback Behavior` requires a substituted mode to be marked distinctly from
 * normal worktree mode, and a scenario in which nothing was ever substituted cannot draw
 * that badge at all.
 *
 * The DRIFTED workspace is deliberately absent from this table: a mount whose binds are
 * already refusing has no execution context to report, and the disclosure draws that as
 * the unanswered question it is rather than as an absence of roots.
 */
function executionContextResultFor(request: unknown): unknown {
  const workspaceId = requestedString(request, "workspaceId");
  if (workspaceId === GIT_WORKSPACE_ID) {
    return {
      workspaceId,
      boundRoot: GIT_CANONICAL_ROOT,
      checkoutRoot: `${GIT_CANONICAL_ROOT}/.`,
      fallbackFromMode: "worktree",
    };
  }
  if (workspaceId === ATTACHED_WORKSPACE_ID) {
    return { workspaceId, boundRoot: "/Users/dev/code/telemetry-agent" };
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
    // than an omission: every member of a clone prepare that a participant can get
    // wrong — the workspace, the branch — is refused by one of the acts above under a
    // code this table would only be restating. What it does state is the EFFECTIVE
    // cleanup policy, which the daemon applies and echoes back, and a deadline ahead of
    // the scenario's own instant so the prepared clone's countdown is drawable.
    call: "repo.ephemeralClonePrepare",
    result: {
      cloneId: PREPARED_CLONE_ID,
      cloneRoot: "/Users/dev/code/ai-sidekicks-clones/telemetry-probe",
      state: "creating",
      cleanupPolicy: "on_run_complete",
      branchName: "probe/telemetry",
      expiresAt: scenarioInstant(45 * 60_000),
    },
  },
  { call: "repo.worktreeRetire", resultFor: retireResultFor },
  { call: "repo.ephemeralCloneDispose", resultFor: disposeResultFor },
  { call: REPOS_EXECUTION_CONTEXT_CALL, resultFor: executionContextResultFor },
];
