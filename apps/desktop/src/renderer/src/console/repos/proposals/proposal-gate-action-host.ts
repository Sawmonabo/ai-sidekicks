// What an act needs from the half of the gate that reads.
//
// A MODULE OF ITS OWN BECAUSE THREE MODULES IMPLEMENT OR CONSUME IT.
// `proposal-gate-reader.ts` supplies the adapter, `proposal-gate-actions.ts` holds one,
// and `proposal-gate-refusals.ts` writes through one. Declared in the acts, the refusals
// would import a contract from a peer that imports them back and close a cycle;
// declared here, the seam has a name and a home. `artifact-action-host.ts` is the same
// shape one directory over.

import type { BranchContextReading } from "../mounts/branch-context-model.js";
import type { PreparedProposal } from "./prepared-proposal.js";
import type { ProposalGateReading } from "./proposal-gate-model.js";

/**
 * What an act needs from the half of the gate that reads.
 *
 * DECLARED ONCE AND IMPLEMENTED BY THE READER, so the two halves share a contract
 * rather than a field. Every member here writes or reads state the reader owns, which
 * is why they are named as the operations they are rather than exposed as the fields
 * they touch: `holdPreparedProposal` takes the context a proposal was prepared
 * AGAINST and the reader derives the pairing key from it, so an act cannot mint a key
 * of its own and cannot hold a proposal without saying what it was built for.
 */
export interface ProposalGateActionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): ProposalGateReading;
  /**
   * The context a served read is holding, or `undefined` where none has been served.
   *
   * Read through the host rather than off the arm, because only the `prepared` arm
   * carries one and an act must not have to narrow an arm to find the id it was given.
   */
  servedContext(): BranchContextReading | undefined;
  /**
   * Which participant this window is, or `undefined` where the read did not answer.
   *
   * A PROMISE RATHER THAN A SETTLED VALUE, because the identity read and the
   * branch-context read are issued together and neither waits on the other: an act
   * pressed the instant a context lands would otherwise send no causation for the
   * ordinary reason that one read finished first. The reading half performs it once and
   * every act awaits that same answer.
   */
  callerParticipantId(): Promise<string | undefined>;
  publish(reading: ProposalGateReading): void;
  /** Hold a prepared proposal, keyed by the context it was prepared against. */
  holdPreparedProposal(proposal: PreparedProposal, preparedFor: BranchContextReading): void;
  /** Drop the held proposal and the context it was prepared for, which are one fact. */
  discardProposal(): void;
  /** Ask for the read that follows an act the daemon accepted. */
  requestRefreshAfterAct(): void;
}
