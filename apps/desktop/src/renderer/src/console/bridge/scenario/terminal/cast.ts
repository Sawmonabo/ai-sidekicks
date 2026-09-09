// Who and what the terminal scenario is about: the session, the people, the agent's
// run, and the node hosting the shell.
//
// Split out of `terminal.ts` so that file is the SCRIPT and this one is the cast
// list. The identities are the part every consumer reaches for by name — the
// family's own tests read the owner and the collaborator off `TERMINAL_SCENARIO_CAST`
// rather than indexing the join log — while the beats are read as a whole, in
// order, by the engine. Two audiences, two files.
//
// WIRE-DECLARED UUIDs RATHER THAN READABLE PLACEHOLDERS. `wire-truth.ts` presents
// each beat to the strict contract layer as the whole envelope it claims to be, and
// an envelope whose session or actor is not the UUID the contract declares is a beat
// no daemon could emit. The one exception below is the node id, which the corpus does
// not declare as a UUID.

const HUMAN_PARTICIPANT_ID = "019b7b30-0280-79a4-8110-cca0117a0130";
const SECOND_HUMAN_PARTICIPANT_ID = "019b7b30-0280-79a4-8110-cca0117a0132";
const AGENT_PARTICIPANT_ID = "019b7b30-0280-7a6e-8100-d1a4c1150034";

/** The session whose one shared shell this scenario is about. */
export const TERMINAL_SCENARIO_SESSION_ID = "019b7b30-0280-75e5-8510-ada11a5a5555";

/** The owner's membership row, named by the `membership.created` beat that admits them. */
export const TERMINAL_OWNER_MEMBERSHIP_ID = "019b7b30-0280-7e3b-8110-cca0117a0131";

/** The collaborator's membership row. Collaborator and never viewer — see the cast below. */
export const TERMINAL_COLLABORATOR_MEMBERSHIP_ID = "019b7b30-0280-7e3b-8110-cca0117a0133";

/**
 * The agent's run, here rather than implied: `auto_released_run_idle` releases the
 * lease when THE ACQUIRING RUN leaves its running state, so the reason cannot be
 * scripted without a run to bind it to.
 */
export const TERMINAL_AGENT_RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0134";

/**
 * The node hosting the session's one terminal. Bound because three surfaces name it
 * and they must agree: the presence beats, the roster reply's node row, and the
 * degraded state's one line naming the node. A pane naming a different node than the
 * one whose presence dropped sends a person to the wrong machine.
 */
export const TERMINAL_HOST_NODE_ID = "node-workstation";

/**
 * The scenario's cast, by role, for the surfaces that render one of them.
 *
 * `participantIdsInJoinOrder` carries the same three ids, and a caller indexing it
 * gets `string | undefined` — so every consumer would either widen its own types or
 * write a presence check for a fact this module already knows. Naming them here
 * gives the family's tests the wire-declared id AND the role it plays, which an
 * index does not, and keeps the ids declared exactly once.
 */
export interface TerminalScenarioCast {
  /** The session's owner. Holds the lease first, and holds it at the end. */
  readonly owner: string;
  /** The collaborator the lease changes hands to. Never a viewer — see above. */
  readonly collaborator: string;
  /**
   * The attached agent, whose run's idling is one of the five release reasons. The
   * RUN binds to the lease, never this id: an agent-path take holds as the
   * node-owner participant, so `owner` above is the holder that take names.
   */
  readonly agent: string;
}

export const TERMINAL_SCENARIO_CAST: TerminalScenarioCast = {
  owner: HUMAN_PARTICIPANT_ID,
  collaborator: SECOND_HUMAN_PARTICIPANT_ID,
  agent: AGENT_PARTICIPANT_ID,
};
