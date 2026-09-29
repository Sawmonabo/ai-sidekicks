// The terminal-lease scenario: one shared shell changing hands, and ending held.
//
// The script is read in order to be understood: which beat follows which, and why. The
// cast and the beat envelope sit above it.
//
// WHAT IT CAN SCRIPT. The terminal output has no registered type, but the lease does:
// `pty.control_changed` is a registered event type with a closed reason vocabulary, and
// the holder is a field on it. So the transitions this scenario scripts are wire-true,
// and it is the terminal output — the bytes, the scrollback, the resize — that has no
// type to carry it and is absent here rather than invented.
//
// A HOLD ENDS THREE WAYS, AND THE SCRIPT REACHES EACH. There is no release control on a
// shell: a device hands it back only by another device taking it, or by the hold ending
// on its own. The automatic endings are the holder's connection ending and the
// acquiring agent run leaving its running state. All three appear below, in the order
// a session reaches them.
//
// AND EACH ONE IS REACHED THE WAY THE DAEMON REACHES IT. A reason scripted onto a
// sequence no daemon produces is a fixture that looks exercised and is not, so the
// run-idle release below is preceded by the acquisition it releases: the agent's run
// queued, started, and reached `running`; an AGENT-PATH take bound to that run; the
// run leaving `running`; and only then `auto_released_run_idle` for that holder.
// The lease design makes this release the acquiring run's first lifecycle transition
// out of `running` after an agent-path take, and it leaves a client-acquired human
// hold alone.
//
// IT ENDS HELD. `runToCompletion()` is the screenshot tier's entry point, so the last
// beat is the frame a screenshot pins — and the last beat is the owner taking the
// shell, which is the frame that carries the most: a named holder and a script behind
// it that reached every ending. A script that ended on a plain free lease would pin
// the emptiest frame the terminal pane has.
import type { Scenario, ScenarioBeat } from "../scenario.js";

// Who and what the scenario is about: the session, the people, and the agent's run.
// Consumers read the owner and the other device off `TERMINAL_SCENARIO_ROLES` rather
// than indexing the join log.
//
// WIRE-DECLARED UUIDs RATHER THAN READABLE PLACEHOLDERS. The contract check presents
// each beat to the strict contract layer as the whole envelope it claims to be, and
// an envelope whose session or actor is not the UUID the contract declares is a beat
// no daemon could emit.

const HUMAN_USER_ID = "019b7b30-0280-79a4-8110-cca0117a0130";
const SECOND_DEVICE_USER_ID = "019b7b30-0280-79a4-8110-cca0117a0132";
const AGENT_USER_ID = "019b7b30-0280-7a6e-8100-d1a4c1150034";

/** The session whose one shared shell this scenario is about. */
const TERMINAL_SCENARIO_SESSION_ID = "019b7b30-0280-75e5-8510-ada11a5a5555";

/**
 * The agent's run, here rather than implied: `auto_released_run_idle` releases the
 * lease when THE ACQUIRING RUN leaves its running state, so the reason cannot be
 * scripted without a run to bind it to.
 */
const TERMINAL_AGENT_RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0134";

/**
 * The scenario's cast, by role, for the views that render one of them.
 *
 * `userIdsInJoinOrder` carries the same three ids, and a caller indexing it
 * gets `string | undefined` — so every consumer would either widen its own types or
 * write a presence check for a fact this module already knows. Naming them here
 * gives the terminal feature's tests the wire-declared id AND the role it plays, which an
 * index does not, and keeps the ids declared exactly once.
 */
interface TerminalScenarioRoles {
  /** The session's owner. Holds the lease first, and holds it at the end. */
  readonly owner: string;
  /** The other device the lease changes hands to. */
  readonly otherDevice: string;
  /**
   * The attached agent, whose run's idling is one of the ways a hold ends. The
   * RUN binds to the lease, never this id: an agent-path take holds as the
   * node-owner user, so `owner` above is the holder that take names.
   */
  readonly agent: string;
}

export const TERMINAL_SCENARIO_ROLES: TerminalScenarioRoles = {
  owner: HUMAN_USER_ID,
  otherDevice: SECOND_DEVICE_USER_ID,
  agent: AGENT_USER_ID,
};

// The scenario's clock, and the two beat shapes its script writes many of.
//
// THE INSTANT IS DERIVED FROM THE TICK. The fixture's frozen clock advances on `atMs`,
// so an `occurredAt` spelled by hand beside it could put a timestamp on screen that no
// tick of this scenario corresponds to; computing one from the other means they cannot
// disagree. Tick zero is derived the same way.
//
// THE ROW ID IS STAMPED HERE TOO, and it is a different kind of claim. `id` is the
// daemon's own opaque identifier for the event — the member the hydrated-event read
// is keyed by, and the one canonical member that names THIS event rather than its
// position — so it is a fact of its own and not a second spelling of the sequence.
// What the stamp below asserts is only that this script's beats each carry a
// distinct, stable, UUID-shaped id under the scenario's own prefix. The beats state
// their `sequence` already, so the tail is read from there rather than written again.

/**
 * Wall-clock instant the frozen clock reports as "now" at tick zero.
 *
 * `Date.UTC` names the fields rather than parsing a text, so a fixture instant is
 * declared and never interpreted: a stamp read the other way round is read in the
 * HOST's zone the moment its spelling loses its `Z`, which makes this a different
 * scenario on a machine east of London.
 */
const TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS: number = Date.UTC(2026, 0, 1, 16, 40, 0, 0);

/**
 * The same instant as the text the wire carries, derived from tick zero through the
 * permitted `new Date(<sum>)` form, so the two spellings cannot disagree.
 */
const TERMINAL_SCENARIO_STARTED_AT_ISO: string = terminalScenarioInstantAt(0);

/** The scenario's own event-id prefix, shared by every beat's opaque row id. */
const TERMINAL_EVENT_ID_PREFIX = "019b7b30-0280-7ea1-8110-e5e0d115";

/** The event kind every lease transition arrives on. A registered wire type. */
const LEASE_TRANSITION_KIND = "pty.control_changed";

/** What one beat says beyond the envelope this module stamps. */
interface TerminalScenarioBeatInput {
  /** The tick this beat is due at, measured from scenario start. */
  readonly atMs: number;
  readonly sequence: number;
  /** Wire-verbatim event type. Held to the registered taxonomy by the wire-truth checks. */
  readonly kind: string;
  /** Who the log attributes the event to. Omitted where the daemon acted alone. */
  readonly actorId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What one lease transition says. The payload members are the wire's own. */
interface TerminalLeaseTransitionBeatInput {
  readonly atMs: number;
  readonly sequence: number;
  /**
   * Who holds it after this transition.
   *
   * `null` is the free lease, and it is written as an explicit null rather than an
   * omitted member because an unheld lease is an explicit state that reads
   * differently from a suppressed one.
   */
  readonly holderUserId: string | null;
  readonly previousHolderUserId: string | null;
  /** One of the reasons the wire closes the set at. */
  readonly reason: string;
  /** Omitted for a take the daemon's own lease authority performed. */
  readonly actorId?: string;
}

/**
 * The instant a tick lands on, in the frozen clock's own wall time.
 *
 * A function declaration, so the base instant above may be derived from it at tick
 * zero: hoisting is what lets the one derivation sit beside the number it derives
 * from rather than below the table that reads it.
 */
function terminalScenarioInstantAt(atMs: number): string {
  return new Date(TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS + atMs).toISOString();
}

/**
 * The opaque row id the daemon would have minted for the beat at this position.
 */
function terminalScenarioEventId(sequence: number): string {
  return `${TERMINAL_EVENT_ID_PREFIX}${String(sequence).padStart(4, "0")}`;
}

/**
 * One scripted beat of this session, with its id, its session id, and its instant
 * stamped.
 *
 * All three stamped rather than written per beat: the session id is the same string
 * on every beat, the instant is `atMs` in the other spelling, and the row id is
 * the scenario's prefix with this beat's own position on the end.
 */
function terminalScenarioBeat(beat: TerminalScenarioBeatInput): ScenarioBeat {
  return {
    atMs: beat.atMs,
    event: {
      id: terminalScenarioEventId(beat.sequence),
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      sequence: beat.sequence,
      kind: beat.kind,
      occurredAt: terminalScenarioInstantAt(beat.atMs),
      ...(beat.actorId === undefined ? {} : { actorId: beat.actorId }),
      payload: beat.payload,
    },
  };
}

/**
 * One `pty.control_changed` beat.
 *
 * Its own builder rather than a `terminalScenarioBeat` call with a payload literal,
 * because many of this script's beats are this shape and the transitions are
 * what a reader comes to the script for. Written as a table, the hand-off sequence
 * reads off the page; written as payload literals, it did not.
 */
function terminalLeaseTransitionBeat(transition: TerminalLeaseTransitionBeatInput): ScenarioBeat {
  return terminalScenarioBeat({
    atMs: transition.atMs,
    sequence: transition.sequence,
    kind: LEASE_TRANSITION_KIND,
    ...(transition.actorId === undefined ? {} : { actorId: transition.actorId }),
    payload: {
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      holderUserId: transition.holderUserId,
      previousHolderUserId: transition.previousHolderUserId,
      reason: transition.reason,
    },
  });
}

export const TERMINAL_LEASE_SCENARIO_ID = "terminal-lease";

const OWNER = TERMINAL_SCENARIO_ROLES.owner;
const OTHER_DEVICE = TERMINAL_SCENARIO_ROLES.otherDevice;
const AGENT = TERMINAL_SCENARIO_ROLES.agent;

export const TERMINAL_LEASE_SCENARIO: Scenario = {
  id: TERMINAL_LEASE_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "The session's one shared shell moving between two of the user's devices and an agent " +
    "run — the run queued, started, taken on the agent path, and completed, so the run-idle " +
    "release follows the acquisition it releases — reaching each automatic ending of a hold " +
    "and ending held. The output stream is absent until the terminal pane's " +
    "renderer is registered.",
  sessionId: TERMINAL_SCENARIO_SESSION_ID,
  userIdsInJoinOrder: [OWNER, OTHER_DEVICE, AGENT],
  // The owner is the device at this window. The lease line's `held-by-me` arm is
  // reachable only when the caller read names the holder, and this scenario ends
  // with the owner holding the lease; without a caller the pane can only show that
  // the identity is being read, which is a true state of the console and not the
  // state this scenario exists to show.
  callerUserId: OWNER,
  startedAtIso: TERMINAL_SCENARIO_STARTED_AT_ISO,
  beats: [
    terminalScenarioBeat({
      atMs: 0,
      sequence: 1,
      kind: "session.created",
      actorId: OWNER,
      // The registered shape, verbatim: the new session's id plus the resolved
      // config and metadata, both open records the corpus names no key inside. A
      // session's name is read off `session.list`, and the lifecycle payload
      // carries no state transition — `session.activated` below is the separate
      // registered event that reaches `active`.
      payload: { sessionId: TERMINAL_SCENARIO_SESSION_ID, config: {}, metadata: {} },
    }),
    terminalScenarioBeat({
      atMs: 30,
      sequence: 2,
      kind: "session.activated",
      actorId: OWNER,
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        previousState: "provisioning",
        newState: "active",
        actor: OWNER,
      },
    }),
    terminalScenarioBeat({
      atMs: 220,
      sequence: 3,
      kind: "agent.attached",
      // The person who attached the agent, not the agent: an agent does not attach
      // itself, and the envelope actor is who acted.
      actorId: OWNER,
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        agentId: AGENT,
        name: "Builder",
        driverName: "codex",
        modelId: "gpt-5.6-luna",
        actor: OWNER,
      },
    }),
    terminalLeaseTransitionBeat({
      atMs: 1200,
      sequence: 4,
      holderUserId: OTHER_DEVICE,
      previousHolderUserId: null,
      reason: "taken",
      actorId: OTHER_DEVICE,
    }),
    terminalLeaseTransitionBeat({
      atMs: 1800,
      sequence: 5,
      holderUserId: null,
      previousHolderUserId: OTHER_DEVICE,
      reason: "auto_released_disconnect",
      actorId: OTHER_DEVICE,
    }),
    terminalScenarioBeat({
      atMs: 3000,
      sequence: 6,
      kind: "run.queued",
      // The person who started the run, not the agent. `previousState` is absent
      // here and only here: a queued run is being born, and no document names the
      // state it came from.
      actorId: OWNER,
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        runId: TERMINAL_AGENT_RUN_ID,
        runVersion: 1,
        newState: "queued",
        agentId: AGENT,
      },
    }),
    terminalScenarioBeat({
      atMs: 3100,
      sequence: 7,
      kind: "run.starting",
      // No actor: the daemon moves a run through its own states, and a user
      // id here would attribute a system transition to a person.
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        runId: TERMINAL_AGENT_RUN_ID,
        runVersion: 2,
        previousState: "queued",
        newState: "starting",
      },
    }),
    terminalScenarioBeat({
      atMs: 3200,
      sequence: 8,
      kind: "run.running",
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        runId: TERMINAL_AGENT_RUN_ID,
        runVersion: 3,
        previousState: "starting",
        newState: "running",
      },
    }),
    // THE AGENT-PATH TAKE, with no actor on purpose: the node's own agent runs take
    // through the daemon's in-process lease authority, so nobody pressed a control
    // and the transcript's actor column reads "The daemon". The holder is the
    // NODE-OWNER user, which is who an agent-path take holds as: agents are
    // `AgentId`-keyed domain actors and not `users` rows, so no
    // agent-user exists to hold and the holder fields stay user
    // ids, exactly as the terminal-control method registry declares.
    terminalLeaseTransitionBeat({
      atMs: 3300,
      sequence: 9,
      holderUserId: OWNER,
      previousHolderUserId: null,
      reason: "taken",
    }),
    terminalScenarioBeat({
      atMs: 3600,
      sequence: 10,
      kind: "run.completed",
      // The acquiring run's first lifecycle transition out of `running` — what the
      // auto-release below is a consequence of, rather than an asserted state.
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        runId: TERMINAL_AGENT_RUN_ID,
        runVersion: 4,
        previousState: "running",
        newState: "completed",
      },
    }),
    terminalLeaseTransitionBeat({
      atMs: 3700,
      sequence: 11,
      holderUserId: null,
      previousHolderUserId: OWNER,
      reason: "auto_released_run_idle",
    }),
    // The held-lease steady state: the holder the pane's header names.
    terminalLeaseTransitionBeat({
      atMs: 4100,
      sequence: 12,
      holderUserId: OWNER,
      previousHolderUserId: null,
      reason: "taken",
      actorId: OWNER,
    }),
  ],
  replies: [],
};
