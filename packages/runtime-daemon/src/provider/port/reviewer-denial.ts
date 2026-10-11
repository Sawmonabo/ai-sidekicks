// Where a driver hands a block the provider's own reviewer made at Reviewed, so the approval
// pipeline records it once and can later allow it once through `ProviderDriver.overrideDenial`.
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * One tool call the provider's reviewer blocked: the call, the reviewer's reason (absent where it
 * gave none), whether the provider lets it be allowed once, and the provider's own record of the
 * block, kept verbatim so `overrideDenial` hands it back unchanged.
 */
export interface ProviderReviewerDenial {
  sessionId: SessionId;
  runId: RunId;
  toolCallId: string;
  reason?: string | undefined;
  overridable: boolean;
  providerDenial: unknown;
}

/**
 * The approval pipeline's intake of reviewer blocks, registered through a `PortRegistration`. It
 * resolves once the block is recorded, which waits for the blocked call's row when the block
 * arrives first, and rejects when it could not be recorded. Until it is registered,
 * a block stays the provider's own: the agent is told why and nothing is recorded.
 */
export interface ReviewerDenialPort {
  takeDenial(denial: ProviderReviewerDenial): Promise<void>;
}
