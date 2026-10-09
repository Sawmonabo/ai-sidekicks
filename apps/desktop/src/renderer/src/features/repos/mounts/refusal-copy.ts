// The next move per daemon refusal code, for every call the repo mounts make. The daemon's code
// and message reach the screen verbatim; this table says what a person does next, once per code.
// The lookup takes a `string` because refusals arrive off the wire: an unlisted code answers
// `undefined` and renders with no next move. The refusals that name what stands in the way are
// words of their own, filled with what the caller holds: the re-attach refusals with the names the
// banner reads for the refusal's ids, an attach with the folder picked, and a move with the row's
// worktree or the path sent.

import type { RepoOutsideTrustEnvelopeReason } from "@ai-sidekicks/contracts/repo/folders";

import { readFrozenRecord } from "#renderer/lib/frozen-record.js";
import type { CasedRefusalRemedy } from "#renderer/lib/refusal/remedies.js";

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
  "workspace.execution_root_unresolved",
  "workspace.branch_name_required",
  "worktree.not_found",
  "worktree.create_failed",
  "worktree.branch_collision",
  "worktree.retire_conflict",
] as const;

/** One code the repo mounts have a next move for. Derived, so the vocabulary has one home. */
export type MountRefusalCode = (typeof MOUNT_REFUSAL_CODES)[number];

/**
 * A re-attach refusal that names what stands in the way: the folder and the project its
 * repository is already attached to, or the name of the agent running in the project.
 * `projectName` is null when a chat's own workspace holds the repository, which has no project.
 *
 * @consumedBy the lost-folder banner's Re-attach
 */
export type ReattachRefusal =
  | {
      readonly code: "repo.already_attached";
      readonly folder: string;
      readonly projectName: string | null;
    }
  | { readonly code: "repo.reattach_conflict"; readonly agentName: string };

/**
 * An attach refused because the folder's repository is a chat's own workspace; an attach of
 * another project's repository switches to that project instead.
 *
 * @consumedBy the new-session picker's attach
 */
export interface AttachRefusal {
  readonly code: "repo.already_attached";
  readonly folder: string;
}

/**
 * A move or a bind refused because the folder is no tree of the project: a tree removed meanwhile,
 * named by its row's worktree, or any other folder, named by the path sent.
 *
 * @consumedBy the worktree switcher's refused move
 */
export type MoveRefusal =
  | {
      readonly code: "repo.outside_trust_envelope";
      readonly reason: Extract<RepoOutsideTrustEnvelopeReason, "worktree_removed">;
      readonly worktreeName: string;
    }
  | {
      readonly code: "repo.outside_trust_envelope";
      readonly reason: Extract<RepoOutsideTrustEnvelopeReason, "outside_project">;
      readonly path: string;
    };

/**
 * What the caller knows that the code alone does not: `resolutionReason` is the `reason` a
 * `repo.root_resolution_failed` refusal carries.
 */
export interface MountRefusalContext {
  readonly resolutionReason?: string | undefined;
}

// The codes drawn by their own words, which a value fills, rather than by the table.
type WordedRefusalCode = AttachRefusal["code"] | MoveRefusal["code"];

const NO_DISTINCTIONS: readonly string[] = [];

/** What an attach of a folder with no git repository in it reads as. */
const NOT_A_REPOSITORY_REMEDY: CasedRefusalRemedy = {
  nextMove: "Could not attach: not a git repository",
  distinctions: NO_DISTINCTIONS,
};

/**
 * The table, total over the codes above but those drawn by their own words, so a code missing
 * here fails to compile.
 */
const MOUNT_REFUSAL_REMEDIES: Readonly<
  Record<Exclude<MountRefusalCode, WordedRefusalCode>, CasedRefusalRemedy>
> = {
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
      "says what it could not resolve. A linked worktree is never the " +
      "cause: its folder attaches as its main checkout.",
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
      "mode it had; preparing again is what retries, and " +
      "nothing is substituted in the meantime.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.mode_unsupported": {
    nextMove: "This mount does not offer that mode. The background service's message says why.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.stale": {
    nextMove:
      "The execution root is unavailable and writable runs are blocked " +
      "until it is repaired. The row's own error line carries what the " +
      "background service captured about the failure.",
    distinctions: NO_DISTINCTIONS,
  },
  "workspace.execution_root_unresolved": {
    nextMove:
      "A run reached its setup gate with no execution root for the " +
      "mode this workspace is bound as, so the run ended failed. " +
      "Prepare a root for this workspace, then send again.",
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
      "a different branch name is the move — the name you typed is " +
      "never adapted for you.",
    distinctions: NO_DISTINCTIONS,
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
 * The next move for one refusal code, or `undefined` where the repo mounts have none. One case
 * reads the context: `repo.root_resolution_failed` with reason `not_a_repository` has a sentence
 * of its own.
 */
export function mountRefusalRemedy(
  code: string,
  context?: MountRefusalContext,
): CasedRefusalRemedy | undefined {
  if (code === "repo.root_resolution_failed" && context?.resolutionReason === "not_a_repository") {
    return NOT_A_REPOSITORY_REMEDY;
  }
  return readFrozenRecord(MOUNT_REFUSAL_REMEDIES, code);
}

/**
 * The words an attach refusal is drawn in, in place in the picker that asked.
 *
 * @consumedBy the new-session picker's attach
 */
export function attachRefusalWords(refusal: AttachRefusal): string {
  return `Could not attach: ${refusal.folder} is already attached to a chat`;
}

/**
 * The words a move or bind refusal is drawn in, in place on the pressed row.
 *
 * @consumedBy the worktree switcher's refused move
 */
export function moveRefusalWords(refusal: MoveRefusal): string {
  switch (refusal.reason) {
    case "worktree_removed":
      return `Could not move: ${refusal.worktreeName} was removed`;
    case "outside_project":
      return `Could not move: ${refusal.path} is not a worktree of this project`;
  }
}

/**
 * The words a re-attach refusal is drawn in, inline at the `Re-attach` that was pressed.
 *
 * @consumedBy the lost-folder banner's Re-attach
 */
export function reattachRefusalWords(refusal: ReattachRefusal): string {
  switch (refusal.code) {
    case "repo.already_attached":
      return `Could not re-attach: ${refusal.folder} is already attached to ${
        refusal.projectName ?? "a chat"
      }`;
    case "repo.reattach_conflict":
      return `Could not re-attach while ${refusal.agentName} is running. Stop the run first.`;
  }
}
