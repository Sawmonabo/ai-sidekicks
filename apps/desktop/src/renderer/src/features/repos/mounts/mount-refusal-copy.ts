// The next move per daemon refusal code, for every call the repo mounts make. The daemon's code
// and message reach the screen verbatim; this table says what a person does next, once per code.
// The lookup takes a `string` because refusals arrive off the wire: an unlisted code answers
// `undefined` and renders with no next move.

import { readFrozenRecord } from "@renderer/lib/frozen-record.js";
import type { CasedRefusalRemedy } from "@renderer/lib/refusal-remedies.js";

/**
 * Every daemon refusal code the repo mount views can receive. `repo.detach_conflict` is
 * omitted because no view here sends `repo.detach`.
 */
export const MOUNT_REFUSAL_CODES = [
  "repo.not_found",
  "repo.root_resolution_failed",
  "repo.outside_trust_envelope",
  "repo.already_attached",
  "workspace.not_found",
  "workspace.preparation_failed",
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
] as const;

/** One code the repo mounts have a next move for. Derived, so the vocabulary has one home. */
export type MountRefusalCode = (typeof MOUNT_REFUSAL_CODES)[number];

/**
 * What the caller knows that the code alone does not. `restrictionReason` is the mount's own
 * reason for a refused mode (sparse in
 * `WorkspaceExecutionModeCapabilitiesReadResponse.restrictions`); absent means none on file.
 * `resolutionReason` is the `reason` a `repo.root_resolution_failed` refusal carries.
 */
export interface MountRefusalContext {
  readonly restrictionReason?: string | undefined;
  readonly resolutionReason?: string | undefined;
}

const NO_DISTINCTIONS: readonly string[] = [];

/** What an attach of a folder with no git repository in it reads as. */
const NOT_A_GIT_REPOSITORY_REMEDY: CasedRefusalRemedy = {
  nextMove: "Could not attach: not a git repository",
  distinctions: NO_DISTINCTIONS,
};

/** The table, total over the codes above, so a code missing here fails to compile. */
const MOUNT_REFUSAL_REMEDIES: Readonly<Record<MountRefusalCode, CasedRefusalRemedy>> = {
  "repo.not_found": {
    nextMove:
      "This mount is gone from the session. The list re-reads itself; " +
      "if the row is still here after that, the read and the " +
      "background service disagree.",
    distinctions: NO_DISTINCTIONS,
  },
  "repo.root_resolution_failed": {
    // The arm for every reason but a folder with no repository, which `mountRefusalRemedy`
    // answers from the context.
    nextMove:
      "Nothing was attached. The background service's message above " +
      "says what it could not resolve; one named case is a linked " +
      "worktree, which attaches from the main checkout instead.",
    distinctions: NO_DISTINCTIONS,
  },
  "repo.outside_trust_envelope": {
    // The path is not named: the daemon's message does not echo it and the console compares no
    // path of its own.
    nextMove:
      "The resolved path is outside the roots this session admits. " +
      "Attaching a root the session already admits is what brings a " +
      "path inside the envelope; the console cannot widen it.",
    distinctions: NO_DISTINCTIONS,
  },
  "repo.already_attached": {
    // Routing, not correction. The reply carries no mount id, and matching the entered path
    // against a rendered `canonicalRoot` would be the renderer comparing paths, which the daemon
    // owns.
    nextMove:
      "This repository is already attached to the session on this node " +
      "— a second working tree of one repository is a re-attach by " +
      "design. Close this and use the mount that already holds it; " +
      "nothing needs attaching twice.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.not_found": {
    nextMove:
      "This workspace is gone. The section re-reads its workspace " +
      "list; a row that survives the re-read is a disagreement between " +
      "the list and the background service.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.preparation_failed": {
    nextMove:
      "The execution root was not prepared. The workspace keeps the " +
      "mode it had; selecting the mode again is what retries, and " +
      "nothing is substituted in the meantime.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.mode_unsupported": {
    // Replaced by `mountRefusalRemedy` when a reason is in hand; this is the arm for a mode the
    // capabilities read gave no reason for.
    nextMove:
      "This workspace cannot take that mode. The mount reported no " +
      "reason for it, so the modes it can take are the ones the picker " +
      "lists as available.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.stale": {
    nextMove:
      "The execution root is unavailable and writable runs are blocked " +
      "until it is repaired. The row's own error line carries what the " +
      "background service captured about the failure.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.branch_mismatch": {
    // The expected branch is copyable text with no action: the daemon never checks out or
    // switches a branch in the bound checkout, so a control offering to would offer what nothing
    // performs.
    nextMove:
      "The bound checkout is on a different branch than the run needs, " +
      "and nothing here switches it — that checkout's branch is yours. " +
      "The background service's message names the branch it expected.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.busy": {
    nextMove:
      "An active run holds this execution root; one holding run at a " +
      "time. The background service's message names it, and the root " +
      "frees when that run ends.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.execution_root_unresolved": {
    nextMove:
      "A run reached its setup gate with no execution root for the " +
      "mode this workspace is bound as, and is parked in starting. " +
      "Preparing a root for it, or canceling the run, are the two ways " +
      "out.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.branch_name_required": {
    nextMove:
      "A prepare made from here is ahead of any run, so the background " +
      "service has nothing to derive a branch name from. Name the " +
      "branch on the form and send it again.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.not_found": {
    nextMove:
      "This worktree is gone from the background service's records. " +
      "Re-reading the roots is what reconciles the list.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.create_failed": {
    nextMove:
      "No worktree was created and the owning workspace has gone " +
      "stale. The failure detail rides that workspace row rather than " +
      "this control.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.branch_collision": {
    // Never auto-suffixed here: a daemon-derived name may take an ordinal suffix, a name the
    // user typed is never silently adapted.
    nextMove:
      "That branch already has a live checkout on this mount. Choosing " +
      "a different branch name, or reusing the existing checkout, are " +
      "the two moves — the name you typed is never adapted for you.",
    distinctions: NO_DISTINCTIONS,
  },
  "worktree.reuse_conflict": {
    // Three situations sit behind this one code and the daemon's message says which. The
    // middle one has no override, which a generic "acknowledge and retry" would deny.
    nextMove:
      "The named reuse candidate was not bound. The background " +
      "service's message says which of three situations this is:",
    distinctions: [
      "It is dirty and the request carried no acknowledgement — the " +
        "dirty-candidate consent is a separate, explicit act, and it is " +
        "never on by default.",
      "It is incompatible with the requested branch strategy — there " +
        "is no override for this one, and it never becomes bindable.",
      "It is no longer live — the candidate went away between the " +
        "check and the prepare, so re-checking is what finds out what is " +
        "there now.",
    ],
  },
  "worktree.retire_conflict": {
    nextMove:
      "This worktree is the execution root an active run holds, so it " +
      "was not retired. It becomes retirable when that run ends; there " +
      "is no force-retire.",
    distinctions: NO_DISTINCTIONS,
  },
};

/**
 * The next move for one refusal code, or `undefined` where the repo mounts have none. Two codes
 * read the context: `workspace.mode_unsupported` quotes the mount's own reason when given, and
 * `repo.root_resolution_failed` with reason `not_a_git_repository` has a sentence of its own.
 */
export function mountRefusalRemedy(
  code: string,
  context?: MountRefusalContext,
): CasedRefusalRemedy | undefined {
  if (code === "workspace.mode_unsupported") {
    const reason = context?.restrictionReason;
    if (reason !== undefined) {
      return { nextMove: reason, distinctions: NO_DISTINCTIONS };
    }
  }
  if (
    code === "repo.root_resolution_failed" &&
    context?.resolutionReason === "not_a_git_repository"
  ) {
    return NOT_A_GIT_REPOSITORY_REMEDY;
  }
  return readFrozenRecord(MOUNT_REFUSAL_REMEDIES, code);
}
