// The repos family's five `repo.*` reads, named once.
//
// EVERY ONE OF THEM GOES THROUGH `callDaemon`, and this module holds nothing that
// door already holds. The parse in both directions, the refusal vocabulary, and the
// normalizer that reads a rejection are the bridge family's, registered against
// `bridge/daemon/daemon-reply-registry.ts`, so a method the corpus has not registered is a
// compile error here rather than an `unknown` somebody remembered to check. What is
// left is the part that IS this family's: which five reads the repos and workspaces
// sections make, and why each of them is the read it is.
//
// THE FIVE, AND THE THREE THAT ARE NOT AMONG THEM. `repo.attach`, `repo.workspaceBind`,
// and `repo.detach` are the three the surfaces would otherwise reach for, for three
// different reasons each recorded where the surface that would call it lives: attach
// needs a node roster this section does not read, bind needs the directory picker
// attach would open, and detach is offered by no renderer surface at all in V1
// (`Spec-009 §Detach Semantics (V1 Definition)`).

import type {
  ExecutionMode,
  ExecutionModeSelectResponse,
  RepoMountId,
  RepoMountReadResponse,
  SessionId,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
  WorkspaceListResponse,
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
 */
function forwardedSessionId(sessionId: string): SessionId {
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
