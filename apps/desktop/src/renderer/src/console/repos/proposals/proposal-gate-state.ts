// What the change-proposal gate can have to say — its arms, and the two sentences the
// arms that carry one say.
//
// The arms are their own module because they are what every other half of this family
// is read THROUGH: `proposal-gate-reader.ts` publishes one of them, `ProposalGate.tsx`
// renders one of them, and `proposal-actions.ts` decides what may be offered on one of
// them. The values they carry are `prepared-proposal.ts`'s, `hosting-status.ts`'s, and
// `branch-context-model.ts`'s; nothing here re-declares any of them.

import type { BranchContextReading } from "../mounts/branch-context-model.js";
import type { ProposalStatusReading } from "../mounts/hosting-status.js";
import type { PreparedProposal } from "./prepared-proposal.js";

/**
 * The gate's arms. Five, and none stands in for another — rule 8's whole claim, applied
 * to a surface whose absences are unusually easy to conflate.
 *
 *   • `not-checked`  — the question could not be put. The branch-context read is a
 *                      growth-port operation whose wire is unregistered, so under the
 *                      live bridge this is V1's ordinary arm — and it must never read
 *                      as "this workspace has no context". The port's own refusal
 *                      sentence travels beside it, because this arm carries no
 *                      message of its own.
 *   • `preparing`    — a read is in flight.
 *   • `prepared`     — a context, optionally a proposal, optionally its host status.
 *   • `hosting-unavailable` — the DEGRADED arm, which is a required feature rather
 *                      than an error page: a proposal-ready summary plus the bundle a
 *                      participant acts on by hand. NO READ REACHES IT, and that is a
 *                      fact about the wire rather than a gap in the reader: the
 *                      preparation reply's state vocabulary is `draft | ready` and
 *                      nothing on it names a bundle, so `proposal-gate-reader.ts`
 *                      never publishes this arm and records why. It stays here
 *                      because `Spec-011 §Fallback Behavior` makes the degraded
 *                      summary required behaviour, and the gate draws it for any
 *                      caller that can state it.
 *   • `refused`      — a first-class failure carrying the daemon's own message. This
 *                      is where "this workspace has no branch context" lands, and it
 *                      is not a console reading of an empty reply: the registered
 *                      response is flat and carries no absence, so a `(workspace,
 *                      worktree)` pair that resolves no row refuses — and the sentence
 *                      a participant reads is the daemon's own rather than a
 *                      paraphrase. A `no-context` arm was removed for exactly that
 *                      reason: nothing could produce it, and an arm with no producer
 *                      is a state minted ahead of its reader.
 */
export type ProposalGateState =
  | { readonly kind: "not-checked" }
  | { readonly kind: "preparing" }
  | {
      readonly kind: "prepared";
      readonly context: BranchContextReading;
      /**
       * The host the remote was detected as, where something said so.
       *
       * OPTIONAL, for the reason the four proposal members are: this family has the
       * provider auto-detected from the git remote URL, and no registered reply carries the
       * result — the branch-context read answers with the four branch values and the
       * worktree association and names no host. So the gate reports a host where one
       * was supplied and reports nothing where none was, rather than defaulting to a
       * provider name nothing established, and this module never picks one.
       */
      readonly detectedHost?: string | undefined;
      readonly proposal?: PreparedProposal | undefined;
      readonly status?: ProposalStatusReading | undefined;
    }
  | {
      readonly kind: "hosting-unavailable";
      readonly context: BranchContextReading;
      readonly proposal: PreparedProposal;
      /** Where the diff artifact bundle landed, so the summary is actionable by hand. */
      readonly bundlePath: string;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * What the degraded arm says.
 *
 * It names the capability rather than the outage, because `Spec-011 §Fallback
 * Behavior` makes producing a summary and a bundle the REQUIRED behaviour when hosting
 * is unavailable — so this state is the system working, and copy that apologised for
 * it would misreport a feature as a fault.
 */
export const HOSTING_UNAVAILABLE_COPY =
  "The git host is not reachable, so nothing was sent. The proposal summary and its diff bundle are below and are complete enough to act on by hand.";

/** What a failed git action says above the daemon's own message text. */
export const ACTION_FAILURE_COPY = "The daemon refused this action.";
