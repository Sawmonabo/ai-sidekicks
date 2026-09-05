// The flagship scenario's cast and its clock — every identifier one place.
//
// Split from the scenario for the reason `apps/desktop/AGENTS.md` gives: one file per
// responsibility, and none over about four hundred lines. The scenario was 584 and held
// three jobs — who is in the room, what they do, and what the session reads answer —
// which is why a reader looking for one agent's model id had to scroll past three
// hundred lines of script to find it.
//
// THE IDENTIFIERS ARE UUIDs, spelled as the wire spells them. `SessionId`,
// `ParticipantId`, `MembershipId`, `AgentId`, and `RunId` are branded UUIDs
// (`§Branded ID Types` in `docs/architecture/contracts/api-payload-contracts.md`), and
// the strict layer refuses anything else. A readable `"agent-scout"` would also have
// rendered at a third of the width a real one does, which is a design lie in a fixture
// whose whole job is to be measured.

/** One lane of the cast, as both the attach beat and the `agent.list` row carry it. */
export interface FlagshipAgent {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  /** Milliseconds after the scenario's own start instant. */
  readonly attachedAtMs: number;
}

// Wire identifiers, spelled as the wire spells them. UUID v7 values, whose leading
// bytes are the scenario's own start instant, so a reader scanning a rendered id
// can still tell one fixture apart from another.
export const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's.
 *
 * `scriptLedgerBeats` completes it with the beat's position. Distinct from
 * `SESSION_ID` on purpose: an event id a caller could rebuild out of the session and
 * the sequence would let a projection that stopped carrying the real one keep
 * answering.
 */
export const EVENT_ID_STEM = "019b79ee-0280-7ea1-8110-e5e0d115";
export const PARTICIPANT_YOU = "019b79ee-0280-79a4-8110-cca0117a0110";
export const PARTICIPANT_PRIYA = "019b79ee-0280-79a4-8120-cca0117a0120";
export const MEMBERSHIP_PRIYA = "019b79ee-0280-7e3b-8110-cca0117a0130";
export const AGENT_ARCHITECT = "019b79ee-0280-7a6e-8110-d1a4c1150001";
export const AGENT_IMPLEMENTER = "019b79ee-0280-7a6e-8120-d1a4c1150002";
export const AGENT_REVIEWER = "019b79ee-0280-7a6e-8130-d1a4c1150003";
export const AGENT_SCOUT = "019b79ee-0280-7a6e-8140-d1a4c1150004";
export const RUN_IMPLEMENTER = "019b79ee-0280-740e-8110-d1a4c1150011";
export const RUN_REVIEWER = "019b79ee-0280-740e-8120-d1a4c1150012";
export const RUN_SCOUT = "019b79ee-0280-740e-8130-d1a4c1150013";
export const RUN_ARCHITECT = "019b79ee-0280-740e-8140-d1a4c1150014";
export const RUN_ARCHITECT_HELPER = "019b79ee-0280-740e-8150-d1a4c1150015";

/**
 * The base instant, minted from its fields rather than read back out of a string.
 *
 * `Date.parse` is not a validator — it reads a timezone-less stamp in the host's
 * zone and normalizes a day that does not exist — so a fixture that derived its
 * milliseconds by parsing its own literal was asking a reader to trust the one
 * function the console bans. `Date.UTC` states the instant, and the ISO spelling
 * every reply carries is derived from it, so the two can never disagree. The name
 * ends `Ms` because that is what it holds — a number, not a stamp behind a name.
 */
export const startedAtMs: number = Date.UTC(2026, 0, 1, 14, 20);

export const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/**
 * The four lanes, as the `agents` projection carries them.
 *
 * One table rather than a literal per beat and a second literal per reply: the
 * `agent.attached` payload and the `agent.list` row are two views of one record
 * (`Spec-006 §Channel and Agent Lifecycle (session_lifecycle)` makes the event replay-complete
 * precisely so the projection can be rebuilt from it), and two hand-written copies
 * of one agent would drift in exactly the direction nothing catches.
 *
 * The drivers and models are deliberately mixed. A fixture whose whole cast runs
 * one provider cannot show a surface what a two-provider session looks like, and
 * that is the session this console is for.
 */
export const FLAGSHIP_AGENTS: readonly FlagshipAgent[] = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 150,
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 200,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 250,
  },
  {
    agentId: AGENT_SCOUT,
    name: "Scout",
    driverName: "codex",
    modelId: "gpt-5.4-mini",
    attachedAtMs: 300,
  },
];

/** The instant one agent was attached, as the `agent.list` reply reports it. */
export function attachedAtIso(attachedAtMs: number): string {
  return new Date(startedAtMs + attachedAtMs).toISOString();
}
