// The identity the bridge's two scripted-reply probes run under.
//
// `read-settlement.test.ts` and `fixture-scripted-answer.test.ts` each stand a
// scenario up that scripts replies and plays no beats, and each was declaring the
// same session and participant pair to do it. Two literals of the same value is how
// one suite's scenario ends up addressed at a session the other's is not, with
// nothing reporting that the two probes stopped probing the same thing.
//
// NOT THE WORKFLOWS FAMILY'S PROBE, though it carries the same value today. A view
// family's support module sits above this one in the console's dependency order, so
// reaching up for the literal would invert the graph to save a line — and the two
// facts are independent anyway: this one is the session a bridge probe scripts, and
// that one is the session a browser suite mounts at.
//
// IDENTITIES ONLY. The scenario builders stay beside their one reader: they script
// different calls and neither suite asserts on the other's replies.

/** The session every scripted-reply probe in this family addresses. */
export const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** The one participant those probes' scenarios join with. */
export const PROBE_PARTICIPANT_ID = "019b7a12-0280-79a4-8110-cca0117a0401";
