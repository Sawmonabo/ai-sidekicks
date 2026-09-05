// The identifiers the composer scenario's two halves both name.
//
// Its own module because the beats and the scripted replies describe the SAME two
// agents, the same run, and the same session, and they now live in two files: an id
// declared in either one would be a value the other half could only match by copying
// it, which is how a fixture comes to answer a read about an agent no beat attached.

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
export const SESSION_ID = "019b7a11-1100-75e5-8510-ada11a5a33a5";
export const PARTICIPANT_YOU = "019b7a11-1100-79a4-8110-cca0117a0310";
export const PARTICIPANT_PRIYA = "019b7a11-1100-79a4-8120-cca0117a0320";
export const MEMBERSHIP_PRIYA = "019b7a11-1100-7e3b-8110-cca0117a0330";
export const AGENT_IMPLEMENTER = "019b7a11-1100-7a6e-8110-d1a4c1150301";
export const AGENT_REVIEWER = "019b7a11-1100-7a6e-8120-d1a4c1150302";
export const RUN_ID = "019b7a11-1100-740e-8110-d1a4c1150311";

/**
 * The two agents, as one table feeding both the beats and the `agent.list` reply.
 *
 * The flagship scenario's rule, applied here: the `agent.attached` payload and the
 * `agent.list` row are two views of one record, and two hand-written copies of one
 * agent drift in exactly the direction nothing catches. The drivers are mixed on
 * purpose — a composer whose whole cast runs one provider cannot show what a
 * two-provider target chip looks like, and that is the chip this scenario is for.
 *
 * `eventId` is the daemon's opaque row id for the attach event the entry produces —
 * carried here rather than composed at the beat, so the two beats the map emits are
 * distinct rows rather than one id repeated.
 */
export interface ComposerAgentFixture {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  /** When the attach beat plays, on the frozen clock. */
  readonly attachedAtMs: number;
  readonly attachedAtIso: string;
  /** The daemon's opaque row id for the attach event this entry produces. */
  readonly eventId: string;
}

export const COMPOSER_AGENTS: readonly ComposerAgentFixture[] = [
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 120,
    attachedAtIso: "2026-01-01T11:05:00.120Z",
    eventId: "019b7a11-1100-7e00-8110-e5e0c1150003",
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 180,
    attachedAtIso: "2026-01-01T11:05:00.180Z",
    eventId: "019b7a11-1100-7e00-8120-e5e0c1150004",
  },
];

/** The sequence the first `agent.attached` beat takes. Two beats precede it. */
export const FIRST_AGENT_SEQUENCE: number = 3;
