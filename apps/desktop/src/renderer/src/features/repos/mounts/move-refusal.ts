// The refusals of a worktree move that name what stands in the way, in words of their own filled
// with what the caller holds: the row's worktree or the path sent. Every other refusal reaches the
// screen in the daemon's own words.

import type { RepoMountOutsideTrustEnvelopeReason } from "@ai-sidekicks/contracts/repo/folders";

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
 * The words a move or bind refusal is drawn in, in place on the pressed row.
 *
 * @consumedBy the worktree switcher's refused move
 */
export function moveRefusalWords(refusal: MoveRefusal): string {
  switch (refusal.reason) {
    case "worktreeRemoved":
      return `Couldn't move · ${refusal.worktreeName} was removed`;
    case "outsideProject":
      return `Couldn't move · ${refusal.path} is not a worktree of this project`;
  }
}
