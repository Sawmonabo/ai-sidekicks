// The line a refused worktree move draws on the row that was pressed. The two refusals that name
// what stands in the way take words of their own, filled with the tree's name or the path sent;
// any other refusal reads `Couldn't move` with the service's own words as its cause.

import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";
import type { RepoMountOutsideTrustEnvelopeReason } from "@ai-sidekicks/contracts/repo/folders";

import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";

/** The tree a move sent the session to: its folder, and the name its row reads. */
export interface MovedTree {
  readonly path: string;
  readonly name: string;
}

/** The words a refused move to `tree` is said in, in place on the pressed row. */
export function moveRefusalWords(refusal: ExtendedRefusal, tree: MovedTree): string {
  if (refusal.code === ("repoMount.outsideTrustEnvelope" satisfies RefusalCode)) {
    if (refusal.reason === ("worktreeRemoved" satisfies RepoMountOutsideTrustEnvelopeReason)) {
      return `Couldn't move · ${tree.name} was removed`;
    }
    if (refusal.reason === ("outsideProject" satisfies RepoMountOutsideTrustEnvelopeReason)) {
      return `Couldn't move · ${tree.path} is not a worktree of this project`;
    }
  }
  return `Couldn't move · ${refusal.detail}`;
}
