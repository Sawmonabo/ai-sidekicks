// The repos family's `repo.*` calls, named once — the reads and the mutations both.
//
// EVERY ONE OF THEM GOES THROUGH `callDaemon`, and this module holds nothing that
// door already holds. The parse in both directions, the refusal vocabulary, and the
// normalizer that reads a rejection are the bridge family's, registered against
// `bridge/daemon/daemon-reply-registry.ts`, so a method the corpus has not registered is a
// compile error here rather than an `unknown` somebody remembered to check. What is
// left is the part that IS this family's: which calls the repos, workspaces, and
// execution-root surfaces make, and why each of them is the call it is.
//
// THE ONE REGISTERED METHOD THAT IS NOT HERE. `repo.detach` is registered beside the
// twelve below and is deliberately absent, because `Spec-009 §Detach Semantics (V1
// Definition)` gives the desktop renderer no detach surface in V1: a wrapper here
// would put the call one import away from a surface that must not offer it. The mount
// card DISCLOSES where detach lives rather than being silent about the absence, and
// there is no force option on a refused detach anywhere in this family.
//
// THE READS AND THE MUTATIONS ARE ONE MODULE AND NOT TWO, because what separates them
// is not this file's subject: every function below is one `callDaemon` line over one
// registered pair, and the READ-versus-ACT seam this family does draw is the one
// between the classes that CALL them — `repo-mounts-reader.ts` against
// `execution-mode-selection.ts`, `attach/attach-acts.ts`, `roots/execution-root-acts.ts`
// — each of which owns a register, a settle rule, and a teardown. Splitting the
// one-liners by verb would put that seam in the wrong place and make a surface import
// two modules to send one act's read and its write.

import type {
  EphemeralCloneDisposeResponse,
  EphemeralCloneId,
  EphemeralClonePrepareRequest,
  EphemeralClonePrepareResponse,
  ExecutionMode,
  ExecutionModeSelectResponse,
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareResponse,
  NodeId,
  RepoAttachResponse,
  RepoMountId,
  RepoMountReadResponse,
  SessionId,
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
  WorkspaceListResponse,
  WorktreeId,
  WorktreeRetireResponse,
  WorktreeReuseCheckResponse,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";
import { normalizeWireRejection, type ConsoleRefusal } from "../core/index.js";
import {
  callDaemon,
  type ConsoleBridge,
  type DaemonReply,
  type DaemonReplyRefusalCode,
} from "../bridge/index.js";

/** The subsystem every refusal this module raises names as its author. */
export const REPO_READS_REFUSAL_ORIGIN = "repos";

/**
 * The one place the console re-narrows a session id.
 *
 * The store holds it as a plain string because it arrived from the wire as one;
 * `SessionId` is a compile-time marker over that same opaque value, and the console
 * never mints one — it forwards the one it was given.
 *
 * EXPORTED FOR THE ATTACH CONTROLLER, which needs the same narrowing for a call this
 * module does not own: the runtime-node roster read is a bridge namespace rather than
 * a `repo.*` daemon method, so it has no home here — and a second copy of this cast
 * beside it would be a second place the console decides what a session id is.
 */
export function forwardedSessionId(sessionId: string): SessionId {
  return sessionId as SessionId;
}

/** One mount, with the freshly probed health verdict only this read carries. */
export async function readRepoMount(
  bridge: ConsoleBridge,
  repoMountId: RepoMountId,
): Promise<DaemonReply<RepoMountReadResponse>> {
  return callDaemon(bridge, "repo.mountRead", { repoMountId });
}

/**
 * Every workspace in the session.
 *
 * SESSION-SCOPED, and it is also how the section learns which mounts exist: there is
 * no `repo.mountList` on the wire, and `workspaces.repo_mount_id` is NOT NULL under
 * the mount-first funnel, so the workspace roster names every mount that has one —
 * which, per `Spec-009 §Default Behavior`, is every mount, since attach always mints
 * a default `read-only` workspace.
 */
export async function readSessionWorkspaces(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<DaemonReply<WorkspaceListResponse>> {
  return callDaemon(bridge, "repo.workspaceList", { sessionId: forwardedSessionId(sessionId) });
}

/**
 * Which modes this workspace may take now.
 *
 * The WORKSPACE-scoped arm of the two the one method admits — the post-bind question.
 * The mount-scoped arm answers the pre-bind question and belongs to the bind flow,
 * and the request refuses if both are named, so the two are never sent together.
 */
export async function readExecutionModeCapabilities(
  bridge: ConsoleBridge,
  workspaceId: WorkspaceId,
): Promise<DaemonReply<WorkspaceExecutionModeCapabilitiesReadResponse>> {
  return callDaemon(bridge, "repo.executionModeCapabilitiesRead", { workspaceId });
}

/**
 * What a workspace on this MOUNT could be bound as — the pre-bind arm of the same read.
 *
 * A SECOND FUNCTION RATHER THAN AN OPTIONAL ARGUMENT, because the request admits
 * exactly one of the two scopes and refuses both-present and neither-present alike. One
 * function taking two optionals would make the refusable shapes expressible at every
 * call site; two functions make the choice at the call, where the caller already knows
 * which question it is asking.
 *
 * THE TWO ANSWERS ARE DIFFERENT QUESTIONS AND NOT ONE ANSWER AT TWO SCOPES. This one is
 * "what could a workspace on this mount do", which is what a bind form offers; the
 * workspace-scoped one is "what may this workspace do now", which is what the mode
 * picker offers on a row that already exists.
 */
export async function readMountExecutionModeCapabilities(
  bridge: ConsoleBridge,
  repoMountId: RepoMountId,
): Promise<DaemonReply<WorkspaceExecutionModeCapabilitiesReadResponse>> {
  return callDaemon(bridge, "repo.executionModeCapabilitiesRead", { repoMountId });
}

/**
 * Record one explicit mode switch.
 *
 * EXACTLY ONE MUTATION per switch. `Spec-010 §Interfaces And Contracts` forbids a
 * client-sequenced select-then-prepare chain, so this function sends the select and
 * stops — the workspace's own `ready -> provisioning -> ready` transition is what the
 * row renders next, on its existing id.
 */
export async function selectExecutionMode(
  bridge: ConsoleBridge,
  workspaceId: WorkspaceId,
  executionMode: ExecutionMode,
): Promise<DaemonReply<ExecutionModeSelectResponse>> {
  return callDaemon(bridge, "repo.executionModeSelect", { workspaceId, executionMode });
}

/**
 * Every execution root this session holds, both kinds, in one read.
 *
 * SESSION-SCOPED and deliberately unfiltered. The request admits an optional
 * `repoMountId` narrowing, and passing one would turn a single read into one per
 * mount for a section that draws them all — the filter exists for a caller that has
 * one mount in view, and this family has a list.
 *
 * It is the ONLY read that names a worktree at all: `workspaces` carries no worktree
 * id, so without this the section could not name the roots a session is running in,
 * and the change-proposal gate — which is asked per worktree — would have nothing to
 * be asked about.
 */
export async function readWorktreeStatus(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<DaemonReply<WorktreeStatusReadResponse>> {
  return callDaemon(bridge, "repo.worktreeStatusRead", {
    sessionId: forwardedSessionId(sessionId),
  });
}

/**
 * Attach one local checkout to this session, on one node.
 *
 * THE PATH TRAVELS VERBATIM. `Spec-009 §Local Trust Envelope (V1 Definition)` puts
 * resolution, canonicalization, containment, symlink following, and case folding with
 * the daemon, so this console sends the string a participant typed and renders whatever
 * comes back — including `repo.root_resolution_failed`, which it never re-reads as
 * "attached as a plain directory".
 *
 * THE NODE IS ALWAYS NAMED, never defaulted here. Mount ownership sits on the runtime
 * node that can actually reach the path (`Spec-009 §Implementation Notes`) and the
 * active-root uniqueness index is keyed on it, so the same absolute path on two nodes
 * names two filesystems and both may attach. A caller with one node in the roster
 * pre-fills the control; this function is handed the answer either way.
 */
export async function attachRepository(
  bridge: ConsoleBridge,
  sessionId: string,
  localPath: string,
  nodeId: NodeId,
): Promise<DaemonReply<RepoAttachResponse>> {
  return callDaemon(bridge, "repo.attach", {
    sessionId: forwardedSessionId(sessionId),
    localPath,
    nodeId,
  });
}

/**
 * Bind a workspace on one mount, in one explicit execution mode.
 *
 * ONE `directory` FIELD AND NO SELECTOR BESIDE IT. The wire carries both forms the
 * trust envelope admits — a subtree relative to the mount's canonical root, and an
 * absolute path naming a registered working tree — over the same optional member, so a
 * second control saying which kind it is would be the console splitting a field the
 * contract deliberately keeps whole. Omitting it binds the mount root, which is the
 * default-workspace case.
 *
 * The mode is REQUIRED and never defaulted on this side: the contract refuses to make
 * "the caller omitted a mode" and "the caller chose `read-only`" the same request, and
 * a default written here would put that distinction back.
 */
export async function bindWorkspace(
  bridge: ConsoleBridge,
  request: WorkspaceBindRequest,
): Promise<DaemonReply<WorkspaceBindResponse>> {
  return callDaemon(bridge, "repo.workspaceBind", request);
}

/**
 * Prepare an execution root now, ahead of any run.
 *
 * THE WHOLE REQUEST TRAVELS AS ONE VALUE rather than as four positional arguments,
 * because three of its members are conditional on each other in ways only the caller
 * knows: a branch name that is required for a writable mode and ignored for
 * `read-only`, a base ref whose absence means the mount's current HEAD, and the reuse
 * pair — a named candidate and the separate consent that admits a dirty one. Spreading
 * them here would invite a call site to pass `acknowledgeDirtyCandidate` without
 * `reuseWorktreeId`, which is a request that consents to nothing.
 */
export async function prepareExecutionRoot(
  bridge: ConsoleBridge,
  request: ExecutionRootPrepareRequest,
): Promise<DaemonReply<ExecutionRootPrepareResponse>> {
  return callDaemon(bridge, "repo.executionRootPrepare", request);
}

/**
 * Ask whether one branch already has a live checkout on this mount.
 *
 * MOUNT-SCOPED AND SINGULAR. The active-branch index admits at most one live checkout
 * per `(mount, branch)`, so this answers about ONE candidate and never a list — and the
 * three verdicts it can carry (`available`, `isClean`, `compatible`) are the daemon's,
 * which is why `Spec-010 §Interfaces And Contracts` puts them on the reply as decided
 * booleans rather than as raw git state for a client to interpret.
 */
export async function checkWorktreeReuse(
  bridge: ConsoleBridge,
  repoMountId: RepoMountId,
  branchName: string,
): Promise<DaemonReply<WorktreeReuseCheckResponse>> {
  return callDaemon(bridge, "repo.worktreeReuseCheck", { repoMountId, branchName });
}

/**
 * Prepare an ephemeral clone.
 *
 * NO TTL MEMBER, and its absence is the contract's: the disposal deadline is daemon
 * configuration and reaches the caller only on the reply's `expiresAt`. What a caller
 * DOES choose is the cleanup policy, and omitting it means `on_run_complete` — applied
 * daemon-side and echoed back, so the effective policy a card renders is the one that
 * was applied rather than the one that was requested.
 */
export async function prepareEphemeralClone(
  bridge: ConsoleBridge,
  request: EphemeralClonePrepareRequest,
): Promise<DaemonReply<EphemeralClonePrepareResponse>> {
  return callDaemon(bridge, "repo.ephemeralClonePrepare", request);
}

/**
 * Record one worktree's retirement.
 *
 * RECORDED, NOT DELETED, and the reply says so by carrying no `cleanedAt`: the row
 * transition and its event land before any disk mutation, and the sweep stamps the
 * cleanup instant afterwards, which the status read is where a surface sees. So a
 * retired root with files still on disk is an ordinary state rather than a failure, and
 * the card that draws it says which of the two it is.
 */
export async function retireWorktree(
  bridge: ConsoleBridge,
  worktreeId: WorktreeId,
): Promise<DaemonReply<WorktreeRetireResponse>> {
  return callDaemon(bridge, "repo.worktreeRetire", { worktreeId });
}

/**
 * Dispose one ephemeral clone.
 *
 * The `manual` cleanup-policy path and the operator-driven one. A clone whose policy is
 * `on_run_complete` reaches the same terminal without this call, so offering it is not
 * the only way a clone ends — which is why the confirm beside it states what disposal
 * takes with it rather than implying the clone would otherwise survive.
 */
export async function disposeEphemeralClone(
  bridge: ConsoleBridge,
  cloneId: EphemeralCloneId,
): Promise<DaemonReply<EphemeralCloneDisposeResponse>> {
  return callDaemon(bridge, "repo.ephemeralCloneDispose", { cloneId });
}

/**
 * Say that one repos call was rejected, in the console's one refusal shape.
 *
 * A DELEGATION, NOT A NORMALIZER. `core/wire-rejection.ts` holds the console's only
 * reading of a rejected promise — the carried-refusal unwrap that survives a realm
 * crossing, the JSON-RPC `data.type` arm whose dotted code a `{ code: string }` guard
 * cannot see, the flat envelope that keeps the daemon's code and sentence verbatim,
 * and the retry hint a rate-limit envelope registers. This module's three-arm copy of
 * that reading dropped the first two of those, so a rejection carrying a project code
 * arrived as `call-rejected`. What is left here is the pair that IS this family's: the
 * origin its refusals carry, and the sentence for a rejection that said nothing
 * machine-readable.
 *
 * THE REJECTED VALUE IS NOT QUOTED INTO THE SENTENCE. It names the leg and stops
 * there — a rejection off the wire can carry participant content as readily as a
 * schema failure can, which is the rule `Spec-023 §Console Design (Meridian)` rule 9
 * sets and which the copy this replaces broke by stringifying the rejection into it.
 */
export function repoCallRefusal(leg: string, rejection: unknown): ConsoleRefusal {
  return normalizeWireRejection(REPO_READS_REFUSAL_ORIGIN, rejection, {
    code: "call-rejected" satisfies DaemonReplyRefusalCode,
    detail: `${leg} was rejected.`,
  });
}
