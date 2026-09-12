// What a diff can be taken OVER in this console, read off the pane's own address.
//
// THE WIRE HAS TWO ARMS AND THE PANE HAS FOUR SUBJECT KINDS, AND THAT MISMATCH IS THE
// WHOLE SUBJECT OF THIS MODULE. `DiffArtifactCreateRequest` is a union discriminated on
// `attributionMode`: the `run_attributed` arm is keyed by a run and the
// `workspace_fallback` arm by a workspace, and there is no third arm and no arm carrying
// both. `seats/pane/pane-address.ts` opens a diff pane over a repo, a workspace, a worktree,
// or the user. So two of those four name nothing the create can be keyed
// by, and the honest answer for them is that no diff can be asked for from here — not a
// control that is offered and then refuses.
//
// AND THE WORKTREE IS THE INTERESTING ONE. A worktree row is MOUNT-anchored — it carries
// `repoMountId` and no workspace — so it cannot key the fallback arm. What it does carry
// is `createdByRunId`, the run that provisioned it, which is exactly the `run_attributed`
// arm's key. That id is not on the address, so the subject below carries the worktree and
// the resolution happens against `repo.worktreeStatusRead`. A worktree whose row names no
// run is a real state — `worktrees.created_by_run_id` is nullable because a pre-run
// prepare mints one with no run to attribute — and it settles as a refusal that says so
// rather than as a diff attributed to a run this console picked.
//
// NOTHING HERE GUESSES AN ATTRIBUTION. Pretending a workspace diff is run-attributed is
// the pitfall; the mapping below is total, one address kind to one
// arm or to nothing, and there is no fallback branch in which an unresolved subject
// becomes the other arm.

import type { GrowthDiffArtifactCreateRequest } from "../../../bridge/index.js";
import type { DiffAttribution } from "../diff-model.js";
import type { ComparedStates } from "../patch-parse.js";

/**
 * What a diff is being asked for over, before any wire resolution.
 *
 * The WORKSPACE arm is complete — its id IS the fallback arm's key — and the WORKTREE arm
 * is not, because the run it resolves to lives on a read rather than on the address. Two
 * arms and not one optional member, so a consumer cannot forget that one of them still
 * has a question to ask.
 */
export type DiffCreateSubject =
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "worktree"; readonly worktreeId: string; readonly sessionId: string };

/** The entity a diff pane was opened over, as much of it as this module reads. */
export interface DiffPaneSubjectEntity {
  readonly kind: string;
  readonly id: string;
}

/**
 * A subject with its arm's key in hand — the shape a request can actually be built from.
 *
 * The worktree arm resolves INTO this rather than being one of its members: once the run
 * is read, a worktree-borne diff and a run-borne one are the same request, and carrying
 * the worktree id past this point would invite a surface to render it as the subject the
 * daemon attributed to.
 */
export type ResolvedDiffCreateSubject =
  | { readonly attributionMode: "run_attributed"; readonly runId: string }
  | { readonly attributionMode: "workspace_fallback"; readonly workspaceId: string };

/**
 * Which subject a diff pane's address names, or `undefined` where it names none.
 *
 * `undefined` IS THE ANSWER FOR TWO OF THE FOUR KINDS and is not a gap. A repository
 * holds several checkouts and resolves to no one of them; the user row has no working
 * tree at all. `DiffPane`'s own absence copy already says what each of those two would
 * mean, so this returns nothing and that copy stands.
 *
 * A WORKTREE WITH NO SESSION ALSO ANSWERS `undefined`, fail-closed: resolving its run
 * takes a session-scoped read, so a pane opened on a bare route has no way to ask and
 * offering a control that could only refuse would be worse than not offering one.
 */
export function diffCreateSubjectFor(
  entity: DiffPaneSubjectEntity,
  sessionId: string | undefined,
): DiffCreateSubject | undefined {
  if (entity.kind === "workspace") {
    return { kind: "workspace", workspaceId: entity.id };
  }
  if (entity.kind === "worktree" && sessionId !== undefined) {
    return { kind: "worktree", worktreeId: entity.id, sessionId };
  }
  return undefined;
}

/**
 * The key one subject's creation is held under.
 *
 * KIND AND ID, because the two id spaces are different: a workspace id and a worktree id
 * are both opaque strings and nothing about either says which it is, so a key of the id
 * alone would let one subject's in-flight create settle into the other's reading if the
 * daemon ever minted the same string in both spaces.
 */
export function diffCreateSubjectKey(subject: DiffCreateSubject): string {
  return subject.kind === "workspace"
    ? `workspace:${subject.workspaceId}`
    : `worktree:${subject.worktreeId}`;
}

/**
 * The attribution a resolved subject carries, in the model both diff surfaces render.
 *
 * DERIVED FROM THE ARM THAT WAS SENT AND NEVER FROM THE REPLY. `DiffArtifactCreateResponse`
 * carries three ids and no attribution, so the mode the model shows is the mode the
 * request named — which is why the wrong shape is unrepresentable end to end: a caller
 * that asked for a workspace diff cannot receive something it may label with a run.
 */
export function diffAttributionFor(resolved: ResolvedDiffCreateSubject): DiffAttribution {
  return resolved.attributionMode === "run_attributed"
    ? { mode: "run_attributed", runId: resolved.runId }
    : { mode: "workspace_fallback", workspaceId: resolved.workspaceId };
}

/** The registered request, from a resolved subject and the two refs a person named. */
export function diffCreateRequestFor(
  resolved: ResolvedDiffCreateSubject,
  comparedStates: ComparedStates,
): GrowthDiffArtifactCreateRequest {
  return resolved.attributionMode === "run_attributed"
    ? {
        attributionMode: "run_attributed",
        runId: resolved.runId,
        baseRef: comparedStates.baseRef,
        headRef: comparedStates.headRef,
      }
    : {
        attributionMode: "workspace_fallback",
        workspaceId: resolved.workspaceId,
        baseRef: comparedStates.baseRef,
        headRef: comparedStates.headRef,
      };
}

/**
 * Whether both compared states have been named.
 *
 * TRIMMED, because whitespace is not a ref and a form that sent one would put a request
 * on the wire the daemon can only refuse. Named here rather than in the form so the
 * controller and the control agree on what "named" means.
 */
export function comparedStatesNamed(comparedStates: ComparedStates): boolean {
  return comparedStates.baseRef.trim().length > 0 && comparedStates.headRef.trim().length > 0;
}

/** The refs as they travel: trimmed once, at the boundary, and never re-trimmed after. */
export function trimmedComparedStates(comparedStates: ComparedStates): ComparedStates {
  return { baseRef: comparedStates.baseRef.trim(), headRef: comparedStates.headRef.trim() };
}
