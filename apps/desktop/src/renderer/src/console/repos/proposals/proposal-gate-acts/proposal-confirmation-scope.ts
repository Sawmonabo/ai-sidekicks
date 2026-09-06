// What a pending confirmation was opened against, as one comparable value.
//
// A CONFIRMATION IS AN APPROVAL OF ONE PARTICULAR THING, and the gate's own arm is
// what says which thing. The confirm pair states a consequence and then sends, so it
// is only meaningful while what it would send is still what was on screen when it was
// opened: a refresh that moves the prepared proposal from `ready` to `draft` withdraws
// the send, and a later proposal that becomes `ready` is a DIFFERENT payload — one the
// participant has not read the consequence for. Left unstamped, the open confirmation
// simply reappeared over it.
//
// A VALUE RATHER THAN A REFERENCE, because every read publishes a fresh proposal
// object: comparing identities would close the confirmation on every refresh, including
// the ones that changed nothing, and a confirm that closes while a person is reading it
// is its own defect. So the scope is composed from what the arm SAYS — which acts are
// offered, and what the proposal on screen holds, including the untyped blob's rows,
// which is the one part of it that a re-preparation moves while the branches stay put.
//
// IT IS NEVER RENDERED AND NEVER SENT. It exists to be compared with itself; the blob
// reaches it through `proposalBlobRows`, which is this family's one reader of that
// value and turns every entry into text — so nothing here can branch on a blob's shape
// either.

import { proposalBlobRows, type PreparedProposal } from "../prepared-proposal.js";
import type { ProposalAction } from "../proposal-actions.js";

/**
 * Compose the scope one confirmation belongs to.
 *
 * Serialized rather than joined, so a trailer carrying the separator cannot compose the
 * same scope as two trailers — the aliasing a hand-rolled delimiter always eventually
 * has. Every part is already a string, a string list, or `null`, so this cannot throw.
 */
export function proposalConfirmationScope(
  offeredActions: readonly ProposalAction[],
  proposal: PreparedProposal | undefined,
): string {
  return JSON.stringify([
    offeredActions,
    proposal === undefined
      ? null
      : [
          proposal.state,
          proposal.baseBranch,
          proposal.headBranch,
          proposal.title ?? null,
          proposal.body ?? null,
          proposal.trailers ?? null,
          proposal.changedPaths ?? null,
          proposalBlobRows(proposal.blob),
        ],
  ]);
}
