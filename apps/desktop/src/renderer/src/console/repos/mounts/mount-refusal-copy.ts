// The next move, per daemon refusal code, for every call this family makes.
//
// ONE TABLE FOR THE WHOLE FAMILY, and that is the point rather than a convenience.
// `Spec-023 §Console Design (Meridian)` rule 9 fixes what reaches the screen from the
// daemon — the code in mono, the message verbatim, never paraphrased — and leaves the
// NEXT MOVE to the caller as a slot. Written per call site, that slot is where a code's
// recovery gets invented twice and the two copies drift; written once, a code has one
// answer wherever it surfaces, and the codes with no console-side move have visibly
// none rather than a sentence somebody felt obliged to write.
//
// THE RECOVERY IS NEVER THE DAEMON'S SENTENCE RESTATED. Each entry below says what a
// PERSON does next, which is a different claim from what the daemon said happened, and
// three of them are the reason this module exists at all:
//
//   • `repo.already_attached` is not a failure to correct. A second working tree of one
//     repository is, by design, a re-attach: the resolved root is already live on this
//     node, so the move is to go to the mount that holds it rather than to change the
//     path and try again.
//   • `workspace.mode_unsupported` is answered by the capabilities read and not by this
//     table: the mount's own reason for that mode is a wire string, so the recovery
//     CARRIES it rather than composing one. A mode refused with no reason on file says
//     exactly that, and does not invent one.
//   • `worktree.reuse_conflict` covers three different situations with three different
//     moves, and the daemon's own message says which. So the recovery enumerates all
//     three rather than picking one — the console cannot tell them apart from the code
//     alone, and a single generic sentence would be wrong two times in three.
//
// WHAT IS DELIBERATELY ABSENT. `repo.detach_conflict` is registered beside these and is
// not here, because no renderer surface in this family sends `repo.detach`
// (`Spec-009 §Detach Semantics (V1 Definition)`) — an entry would be a next move for a
// refusal this console cannot receive. There is no force option in any entry either:
// `Spec-010 §Turn-Boundary Snapshots` leaves force-override unscheduled, and V1 has no
// force-detach, so a recovery offering one would name a control that does not exist.
//
// THE LOOKUP TAKES A `string`, not the union. A refusal arrives off the wire and the
// console never asserts that a code it has not seen is one of these — an unlisted code
// answers `undefined` and renders with no next move beside it, which is the honest
// reading of a refusal this family has no move for.

import type { ExecutionMode } from "@ai-sidekicks/contracts";

/**
 * Every daemon refusal code the repos mount surfaces can receive.
 *
 * Transcribed from `docs/architecture/contracts/error-contracts.md` §Repo, §Workspace,
 * §Worktree, and §Ephemeral Clone — the four namespaces the twelve `repo.*` methods
 * this console binds refuse in. A tuple rather than a count in prose, on the family's
 * own rule: a number in a sentence is not something a missing code can fail against.
 */
export const MOUNT_REFUSAL_CODES = [
  "repo.not_found",
  "repo.root_resolution_failed",
  "repo.outside_trust_envelope",
  "repo.already_attached",
  "workspace.not_found",
  "workspace.provisioning_failed",
  "workspace.mode_unsupported",
  "workspace.stale",
  "workspace.branch_mismatch",
  "workspace.busy",
  "workspace.execution_root_unresolved",
  "workspace.branch_name_required",
  "worktree.not_found",
  "worktree.create_failed",
  "worktree.branch_collision",
  "worktree.reuse_conflict",
  "worktree.retire_conflict",
  "clone.not_found",
  "clone.prepare_failed",
] as const;

/** One code this family has a next move for. Derived, so the vocabulary has one home. */
export type MountRefusalCode = (typeof MOUNT_REFUSAL_CODES)[number];

/**
 * What a person does next, and the alternatives where there is more than one.
 *
 * `distinctions` is a LIST rather than a second sentence because the cases it holds are
 * exclusive: the reader is choosing between them, and prose that ran them together
 * would read as a sequence of steps. An empty list is the ordinary shape — most codes
 * have exactly one move — and it is a real empty rather than an absent member, so a
 * renderer maps it without asking whether it is there.
 */
export interface MountRefusalRecovery {
  readonly nextMove: string;
  readonly distinctions: readonly string[];
}

/**
 * What the caller knows that the code alone does not.
 *
 * ONE MEMBER, and it exists because one code's recovery is a wire string this table
 * must not write: `workspace.mode_unsupported` is paired with the mount's own reason
 * for the mode that was refused, which arrives on
 * `WorkspaceExecutionModeCapabilitiesReadResponse.restrictions` and is sparse. Absent
 * means the read gave no reason for that mode, which the recovery says outright rather
 * than filling in.
 */
export interface MountRefusalContext {
  readonly restrictionReason?: string | undefined;
}

const NO_DISTINCTIONS: readonly string[] = [];

/**
 * The table. Total over the codes above, so a code added to the tuple and not here
 * fails to compile rather than surfacing with no move.
 */
const MOUNT_REFUSAL_RECOVERIES: Readonly<Record<MountRefusalCode, MountRefusalRecovery>> = {
  "repo.not_found": {
    nextMove:
      "This mount is gone from the session. The list re-reads itself; if the row is still here after that, the read and the daemon disagree.",
    distinctions: NO_DISTINCTIONS,
  },
  "repo.root_resolution_failed": {
    // NEVER "attached as a plain directory". `Spec-009 §Repo Identity And
    // Common-Directory Keying (V1 Definition)` states outright that a failed
    // resolution and a non-git attach must not be conflated: one is an attach that
    // did not happen, the other is a mount that exists with git features off.
    nextMove:
      "Nothing was attached. The daemon's message above says what it could not resolve; one named case is a linked worktree, which attaches from the main checkout instead.",
    distinctions: NO_DISTINCTIONS,
  },
  "repo.outside_trust_envelope": {
    // The console does not name the path here, and it could not: the daemon's message
    // for this code deliberately does not echo the attempted path, and the console
    // resolves and compares no path of its own.
    nextMove:
      "The resolved path is outside the roots this session admits. Attaching a root the session already admits is what brings a path inside the envelope; the console cannot widen it.",
    distinctions: NO_DISTINCTIONS,
  },
  "repo.already_attached": {
    // ROUTING, NOT CORRECTION. The reply carries no mount id and this console will not
    // guess one: matching the entered path against a rendered `canonicalRoot` would be
    // the renderer comparing paths, which is the daemon's rule under
    // `Spec-009 §Local Trust Envelope (V1 Definition)`. So the move is stated as the
    // place to go rather than as a link the console fabricates a target for.
    nextMove:
      "This repository is already attached to the session on this node — a second working tree of one repository is a re-attach by design. Close this and use the mount that already holds it; nothing needs attaching twice.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.not_found": {
    nextMove:
      "This workspace is gone. The section re-reads its roster; a row that survives the re-read is a disagreement between the list and the daemon.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.provisioning_failed": {
    nextMove:
      "The execution root was not provisioned. The workspace keeps the mode it had; selecting the mode again is what retries, and nothing is substituted in the meantime.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.mode_unsupported": {
    // Replaced wholesale by `mountRefusalRecovery` when a reason is in hand. This is
    // the arm for a refusal whose mode the capabilities read gave no reason for, and
    // it says that rather than implying one exists somewhere on screen.
    nextMove:
      "This workspace cannot take that mode. The mount reported no reason for it, so the modes it can take are the ones the picker lists as available.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.stale": {
    nextMove:
      "The execution root is unavailable and writable runs are blocked until it is repaired. The row's own error line carries what the daemon captured about the failure.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.branch_mismatch": {
    // The expected branch is the daemon's own string and is copyable text with no
    // action attached: `Spec-010 §Resolved Questions and V1 Scope Decisions` states
    // the daemon never checks out, creates, or switches a branch in the bound
    // checkout, so a control that offered to do it would offer what nothing performs.
    nextMove:
      "The bound checkout is on a different branch than the run needs, and nothing here switches it — that checkout's branch is yours. The daemon's message names the branch it expected.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.busy": {
    nextMove:
      "An active run holds this execution root; one holding run at a time. The daemon's message names it, and the root frees when that run ends.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.execution_root_unresolved": {
    nextMove:
      "A run reached its setup gate with no execution root for the mode this workspace is bound as, and is parked in starting. Preparing a root for it, or cancelling the run, are the two ways out.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.branch_name_required": {
    nextMove:
      "A prepare made from here is ahead of any run, so the daemon has nothing to derive a branch name from. Name the branch on the form and send it again.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.not_found": {
    nextMove:
      "This worktree is gone from the daemon's records. Re-reading the roots is what reconciles the list.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.create_failed": {
    nextMove:
      "No worktree was created and the owning workspace has gone stale. The failure detail rides that workspace row rather than this control.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.branch_collision": {
    // Never auto-suffixed here. A daemon-DERIVED name may take an ordinal suffix and
    // is displayed with it; a name a participant typed is never silently adapted.
    nextMove:
      "That branch already has a live checkout on this mount. Choosing a different branch name, or reusing the existing checkout, are the two moves — the name you typed is never adapted for you.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.reuse_conflict": {
    // THREE SITUATIONS, THREE MOVES, and the console cannot tell them apart from the
    // code: `Spec-010 §Fallback Behavior` puts all three behind this one code and the
    // daemon's message says which. Enumerated rather than collapsed, because a single
    // sentence would be wrong in two cases out of three — and because the middle case
    // has no override at all, which a generic "acknowledge and retry" would deny.
    nextMove:
      "The named reuse candidate was not bound. The daemon's message says which of three situations this is:",
    distinctions: [
      "It is dirty and the request carried no acknowledgement — the dirty-candidate consent is a separate, explicit act, and it is never on by default.",
      "It is incompatible with the requested branch strategy — there is no override for this one, and it never becomes bindable.",
      "It is no longer live — the candidate went away between the check and the prepare, so re-checking is what finds out what is there now.",
    ],
  },
  "worktree.retire_conflict": {
    nextMove:
      "This worktree is the execution root an active run holds, so it was not retired. It becomes retirable when that run ends; there is no force-retire.",
    distinctions: NO_DISTINCTIONS,
  },
  "clone.not_found": {
    nextMove:
      "This clone is gone from the daemon's records — a disposal or a deadline sweep may already have taken it. Re-reading the roots reconciles the list.",
    distinctions: NO_DISTINCTIONS,
  },
  "clone.prepare_failed": {
    nextMove:
      "No clone was prepared and the owning workspace has gone stale. A run waiting on this root stays blocked in setup until the workspace is repaired.",
    distinctions: NO_DISTINCTIONS,
  },
};

/**
 * The next move for one refusal code, or `undefined` where this family has none.
 *
 * ONE CODE IS ANSWERED FROM THE CONTEXT AND NOT FROM THE TABLE. A
 * `workspace.mode_unsupported` refusal is paired with the mount's own reason for the
 * mode that was refused (`Spec-009 §Fallback Behavior` requires the capability gap to
 * be explicit rather than silently substituted), and that reason is a wire string this
 * module must not compose. When the caller has it, it IS the recovery, quoted; when the
 * capabilities read gave none for that mode, the table's own arm says so.
 */
export function mountRefusalRecovery(
  code: string,
  context?: MountRefusalContext,
): MountRefusalRecovery | undefined {
  if (code === "workspace.mode_unsupported") {
    const reason = context?.restrictionReason;
    if (reason !== undefined) {
      return { nextMove: reason, distinctions: NO_DISTINCTIONS };
    }
  }
  return Object.hasOwn(MOUNT_REFUSAL_RECOVERIES, code)
    ? MOUNT_REFUSAL_RECOVERIES[code as MountRefusalCode]
    : undefined;
}

/**
 * The mount's own reason for one mode, off the capabilities reply.
 *
 * A READER AND NOT A DERIVATION: `restrictions` is sparse and per mode, and a mode with
 * no entry has no reason on file rather than an empty one. Declared here beside the
 * table that consumes it so the one code whose recovery is a wire string has its reader
 * and its copy in one place.
 */
export function modeRestrictionReason(
  restrictions: Readonly<Partial<Record<ExecutionMode, string>>> | undefined,
  mode: ExecutionMode | undefined,
): string | undefined {
  if (restrictions === undefined || mode === undefined) {
    return undefined;
  }
  return restrictions[mode];
}
