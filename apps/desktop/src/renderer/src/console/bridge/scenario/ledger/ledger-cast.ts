// The ledger scenario's cast and its clock — every identifier one place.
//
// Split from the scenario for the reason `apps/desktop/AGENTS.md` gives: one file per
// responsibility, and none over about four hundred lines. The scenario was 463 and held
// three jobs — who is in the room, what they do, and what the session reads answer.

/** One lane of the cast, as both the attach beat and the `agent.list` row carry it. */
export interface LedgerCastAgent {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  /** Milliseconds after the scenario's own start instant. */
  readonly attachedAtMs: number;
}

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// rendered identifier tells one fixture apart from another at a glance — and so an
// id is as wide on screen as a real one, which a readable name never is.
export const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/**
 * The named channel the implementer's lane speaks in.
 *
 * WHY ANY BEAT NAMES A CHANNEL AT ALL. A timeline pane addressed to a channel is a
 * log of that channel, and no beat of any shipped scenario named one — so every
 * channel-addressed pane in the fixture bridge rendered its empty state and the
 * composition could not be seen. One lane speaks in it and the other two do not,
 * which is what makes the scope visible: the channel pane is this run and the
 * channel's own creation, and the session pane is still everything.
 */
export const CHANNEL_IMPLEMENTATION = "019b793b-7b60-7c11-8110-c4a11e10001a";

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's.
 *
 * `scriptLedgerBeats` completes it with the beat's position. Distinct from
 * `SESSION_ID` on purpose: an event id a caller could rebuild out of the session and
 * the sequence would let a projection that stopped carrying the real one keep
 * answering.
 */
export const EVENT_ID_STEM = "019b793b-7b60-7ea1-8110-e5e0d115";
export const PARTICIPANT_YOU = "019b793b-7b60-79a4-8110-cca0117a0410";
export const PARTICIPANT_PRIYA = "019b793b-7b60-79a4-8120-cca0117a0420";
export const MEMBERSHIP_PRIYA = "019b793b-7b60-7e3b-8110-cca0117a0430";
export const AGENT_ARCHITECT = "019b793b-7b60-7a6e-8110-d1a4c1150101";
export const AGENT_IMPLEMENTER = "019b793b-7b60-7a6e-8120-d1a4c1150102";
export const AGENT_REVIEWER = "019b793b-7b60-7a6e-8130-d1a4c1150103";
export const RUN_IMPLEMENTER = "019b793b-7b60-740e-8110-d1a4c1150111";
export const RUN_REVIEWER = "019b793b-7b60-740e-8120-d1a4c1150112";
export const RUN_ARCHITECT = "019b793b-7b60-740e-8130-d1a4c1150113";

/**
 * The child run the architect's turn opens, and the only run here with a parent.
 *
 * A CHILD RUN IS NOT A FOURTH LANE. The ledger summarizes it onto the one row that
 * names both it and its parent rather than drawing a lane of its own, which is why
 * this id is stated beside the three above and is deliberately not one of them: the
 * three are the compositions a reader has to tell apart in one frame, and this is
 * the background work folded into one of them.
 */
export const RUN_ARCHITECT_CHILD = "019b793b-7b60-740e-8140-d1a4c1150114";

/**
 * The runtime node the child run was produced on.
 *
 * A daemon-assigned opaque identifier rather than a hostname, which is what that
 * brand is: the timeline requires a child run's provenance to name its producing
 * node, and a summary that could not state one renders the absence instead. This
 * scenario states one so the present arm is reachable.
 */
export const RUNTIME_NODE = "019b793b-7b60-7d0c-8110-c0de11a0d0e1";

/**
 * The provider-native subagent the reviewer's run opens, as its provider names it.
 *
 * NOT A UUID, and that is the fact it carries: the identifier is minted by the
 * provider and is unique only inside that provider's run scope, which is why the
 * console keys a subagent by the whole `(runId, provider, subagentId)` triple and
 * never by this string alone. Written in the provider's own shape so a fixture
 * cannot teach a surface to expect a session-wide identifier here.
 */
export const SUBAGENT_REVIEWER = "sub_01k9wq4m2h";

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
export const startedAtMs: number = Date.UTC(2026, 0, 1, 11, 5);

export const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/**
 * The three lanes, as the `agents` projection carries them.
 *
 * One table rather than a literal per beat and a second per reply: the
 * `agent.attached` payload and the `agent.list` row are two views of one record,
 * and two hand-written copies of one agent drift in the direction nothing catches.
 * The drivers are mixed on purpose — a fixture whose whole cast runs one provider
 * cannot show a surface what a two-provider session looks like.
 */
export const LEDGER_AGENTS: readonly LedgerCastAgent[] = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 120,
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 160,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 200,
  },
];

/** The instant one agent was attached, as the `agent.list` reply reports it. */
export function attachedAtIso(attachedAtMs: number): string {
  return new Date(startedAtMs + attachedAtMs).toISOString();
}
