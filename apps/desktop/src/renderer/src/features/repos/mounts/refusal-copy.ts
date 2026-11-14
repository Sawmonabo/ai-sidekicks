// The refusals of the repo mounts' calls that name what stands in the way, in words of their own
// filled with what the caller holds: an attach with the folder picked, and a move with the row's
// worktree or the path sent. Every other refusal reaches the screen in the daemon's own words.

import type { RepoMountOutsideTrustEnvelopeReason } from "@ai-sidekicks/contracts/repo/folders";

/**
 * An attach refused because the folder's repository is a chat's own workspace; an attach of
 * another project's repository switches to that project instead.
 *
 * @consumedBy the new-session picker's attach
 */
export interface AttachRefusal {
  readonly code: "repoMount.alreadyAttached";
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
      readonly code: "repoMount.outsideTrustEnvelope";
      readonly reason: Extract<RepoMountOutsideTrustEnvelopeReason, "worktreeRemoved">;
      readonly worktreeName: string;
    }
  | {
      readonly code: "repoMount.outsideTrustEnvelope";
      readonly reason: Extract<RepoMountOutsideTrustEnvelopeReason, "outsideProject">;
      readonly path: string;
    };

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
    case "worktreeRemoved":
      return `Could not move: ${refusal.worktreeName} was removed`;
    case "outsideProject":
      return `Could not move: ${refusal.path} is not a worktree of this project`;
  }
}
