// The identifiers the approvals scenario's two halves both name.
//
// Its own module because the beats and the scripted replies describe the SAME six
// requests and the same three rules, and they now live in two files: an id declared
// in either one would be a value the other half could only match by copying it,
// which is how a fixture comes to answer a read about a request no beat ever raised.

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
export const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
export const PARTICIPANT_YOU = "019b7a33-3300-79a4-8110-cca0117a0510";
export const PARTICIPANT_AWAY = "019b7a33-3300-79a4-8120-cca0117a0520";
export const AGENT_IMPLEMENTER = "019b7a33-3300-7a6e-8110-d1a4c1150501";
export const AGENT_REVIEWER = "019b7a33-3300-7a6e-8120-d1a4c1150502";
export const RUN_ID = "019b7a33-3300-740e-8110-d1a4c1150511";

export const APPROVAL_RESOLVED = "019b7a33-3300-7f01-8110-d1a4c1150521";
export const APPROVAL_EXPIRED = "019b7a33-3300-7f01-8120-d1a4c1150522";
export const APPROVAL_PENDING_WRITE = "019b7a33-3300-7f01-8130-d1a4c1150523";
export const APPROVAL_PENDING_ASK = "019b7a33-3300-7f01-8140-d1a4c1150524";
export const APPROVAL_REJECTED = "019b7a33-3300-7f01-8150-d1a4c1150525";
export const APPROVAL_CANCELED = "019b7a33-3300-7f01-8160-d1a4c1150526";

export const RULE_SESSION_WIDE = "019b7a33-3300-7b01-8110-d1a4c1150531";
export const RULE_RUN_SCOPED = "019b7a33-3300-7b01-8120-d1a4c1150532";
export const RULE_REVOKED = "019b7a33-3300-7b01-8130-d1a4c1150533";

/**
 * The originating driver ask, carried on the `approval.requested` EVENT payload.
 *
 * Registered there and persisted on the request row, and on no member of the
 * projection reply — so the beat below carries it and the reply below does not.
 */
export const DRIVER_ASK_ID = "ask-permission-force-push";

/** The node the remembered rules are bound to. `NodeId` is a bounded string. */
export const NODE_ID = "workstation-local";
