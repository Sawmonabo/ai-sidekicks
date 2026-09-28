// The identifiers the approvals scenario's beats name.

import {
  UserIdSchema,
  RunIdSchema,
  SessionIdSchema,
  type UserId,
  type RunId,
  type SessionId,
} from "@ai-sidekicks/contracts";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
//
// MINTED THROUGH THE REGISTERED SCHEMAS RATHER THAN `as`-CAST. A scenario constant is
// where a fixture chooses the bytes, and a cast asserts a brand without checking it —
// so a malformed id surfaced at the first `.strict()` reply that carried it, which
// takes the whole reply down and names the reply rather than the value. Parsing at
// declaration fails the module instead, naming the constant. `AGENT_*` stays
// unbranded: the corpus registers no `AgentId` brand to mint one through.
export const SESSION_ID: SessionId = SessionIdSchema.parse("019b7a33-3300-75e5-8510-ada11a5a55a5");
export const USER_YOU: UserId = UserIdSchema.parse("019b7a33-3300-79a4-8110-cca0117a0510");
export const AGENT_IMPLEMENTER = "019b7a33-3300-7a6e-8110-d1a4c1150501";
export const AGENT_REVIEWER = "019b7a33-3300-7a6e-8120-d1a4c1150502";
export const RUN_ID: RunId = RunIdSchema.parse("019b7a33-3300-740e-8110-d1a4c1150511");

export const APPROVAL_RESOLVED = "019b7a33-3300-7f01-8110-d1a4c1150521";
export const APPROVAL_PENDING_GIT_RESET = "019b7a33-3300-7f01-8120-d1a4c1150522";
export const APPROVAL_PENDING_WRITE = "019b7a33-3300-7f01-8130-d1a4c1150523";
export const APPROVAL_PENDING_ASK = "019b7a33-3300-7f01-8140-d1a4c1150524";

/**
 * The originating driver ask, carried on the `approval.requested` EVENT payload.
 *
 * Registered there and persisted on the request row.
 */
export const DRIVER_ASK_ID = "ask-permission-force-push";
