// The terminal-lease scenario: one of a session's shells changing hands, and ending held.
//
// `pty.control_changed` is a registered event type with a closed reason vocabulary, so the
// lease transitions are wire-true. Terminal output (bytes, scrollback, resize) has no
// registered type and is absent rather than invented.
//
// A hold ends three ways and the script reaches each: another device takes the shell (a shell
// has no release control), the holder's connection ends, or the holding run leaves `running`.
// Each is reached as the daemon reaches it, so the run-idle release follows the run's queued,
// starting and `running` beats, an agent-path take bound to the run, and the run leaving
// `running`. That release is the holding run's first transition out of `running` and leaves
// a device's hold alone.
//
// The lease is per shell and the holder is a device: every transition names its shell, and a
// run's hold names the machine's own device and the run.
//
// The script ends held, on the owner taking the shell, because `runToCompletion()` plays to
// the last beat and a named holder is the frame that carries the most.

import { composeSessionCreatedPayload } from "../data/opening-entries.js";
import type { Scenario, ScenarioBeat } from "../scenario.js";

// Who and what the scenario is about: the session, the people and the agent's run. Ids are
// UUIDs because the contract check presents each beat to the strict layer as a whole envelope.
const HUMAN_USER_ID = "019b7b30-0280-79a4-8110-cca0117a0130";
const SECOND_DEVICE_USER_ID = "019b7b30-0280-79a4-8110-cca0117a0132";
const AGENT_USER_ID = "019b7b30-0280-7a6e-8100-d1a4c1150034";

/** The session whose shell this scenario is about. */
const TERMINAL_SCENARIO_SESSION_ID = "019b7b30-0280-75e5-8510-ada11a5a5555";

/**
 * The shell the lease moves on. The terminal pane names its shell by the session's id until
 * it reads the shell list, so the scenario's shell carries that id.
 */
const TERMINAL_SCENARIO_SHELL_ID = TERMINAL_SCENARIO_SESSION_ID;

/** The agent's run; `auto_released_run_idle` needs a holding run to bind to. */
const TERMINAL_AGENT_RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0134";

/** The run's command that holds the shell. */
const TERMINAL_AGENT_COMMAND_ID = "command-pnpm-test";

/**
 * The scenario's cast by role, so tests get each id with the role it plays instead of
 * indexing `userIdsInJoinOrder`, which yields `string | undefined`.
 */
interface TerminalScenarioRoles {
  /**
   * The session's owner, at the device this window runs on, which is also the machine
   * the agent's run holds the shell from. Holds the lease at the end.
   */
  readonly owner: string;
  /** The other device the lease changes hands to. */
  readonly otherDevice: string;
  /**
   * The session's lead, whose run's idling is one of the ways a hold ends. The run binds to
   * the lease, never this id: a run's take names the machine's own device and the run.
   */
  readonly agent: string;
}

/** The scenario's owner, other device and agent, by role. */
export const TERMINAL_SCENARIO_ROLES: TerminalScenarioRoles = {
  owner: HUMAN_USER_ID,
  otherDevice: SECOND_DEVICE_USER_ID,
  agent: AGENT_USER_ID,
};

// The scenario's clock and the two beat shapes its script writes many of.
//
// `occurredAt` is derived from `atMs`, so no timestamp can disagree with its tick. The row
// id is the scenario's prefix plus the beat's `sequence`, so each beat carries a distinct,
// stable, UUID-shaped id.

// Wall-clock instant the frozen clock reports as "now" at tick zero. `Date.UTC` names the
// fields, so the instant never depends on the host's zone the way a zone-less parsed stamp does.
const TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS: number = Date.UTC(2026, 0, 1, 16, 40, 0, 0);

// The same instant as the text the wire carries, so the two spellings cannot disagree.
const TERMINAL_SCENARIO_STARTED_AT_ISO: string = terminalScenarioInstantAt(0);

// The event-id prefix shared by every beat's opaque row id.
const TERMINAL_EVENT_ID_PREFIX = "019b7b30-0280-7ea1-8110-e5e0d115";

// The registered event kind every lease transition arrives on.
const LEASE_TRANSITION_KIND = "pty.control_changed";

/** What one beat says beyond the envelope this module stamps. */
interface TerminalScenarioBeatInput {
  /** The tick this beat is due at, measured from scenario start. */
  readonly atMs: number;
  readonly sequence: number;
  /** Wire-verbatim event type, held to the registered census by the contract check. */
  readonly kind: string;
  /** Who the log attributes the event to. Omitted where the daemon acted alone. */
  readonly actorId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What one lease transition says. The payload members are the wire's own. */
interface TerminalLeaseTransitionBeatInput {
  readonly atMs: number;
  readonly sequence: number;
  /** The device holding the shell after this transition; an explicit `null` is the free lease. */
  readonly holderDeviceId: string | null;
  /** The run holding the shell after this transition, on a run's take only. */
  readonly holderRunId?: string;
  /** The run's command holding the shell, named whenever the run is. */
  readonly holderCommandId?: string;
  readonly previousHolderDeviceId: string | null;
  /** One of the reasons the wire closes the set at. */
  readonly reason: string;
  /** Omitted for a take the daemon's own lease authority performed. */
  readonly actorId?: string;
}

// The instant a tick lands on, in the frozen clock's wall time. A function declaration so the
// tick-zero constant above can call it.
function terminalScenarioInstantAt(atMs: number): string {
  return new Date(TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS + atMs).toISOString();
}

// The opaque row id for the beat at this position.
function terminalScenarioEventId(sequence: number): string {
  return `${TERMINAL_EVENT_ID_PREFIX}${String(sequence).padStart(4, "0")}`;
}

// One scripted beat with its id, session id and instant stamped, so none is written per beat.
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

// One `pty.control_changed` beat, so the hand-off sequence reads as a table.
function terminalLeaseTransitionBeat(transition: TerminalLeaseTransitionBeatInput): ScenarioBeat {
  return terminalScenarioBeat({
    atMs: transition.atMs,
    sequence: transition.sequence,
    kind: LEASE_TRANSITION_KIND,
    ...(transition.actorId === undefined ? {} : { actorId: transition.actorId }),
    payload: {
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      terminalId: TERMINAL_SCENARIO_SHELL_ID,
      holderDeviceId: transition.holderDeviceId,
      ...(transition.holderRunId === undefined ? {} : { holderRunId: transition.holderRunId }),
      ...(transition.holderCommandId === undefined
        ? {}
        : { holderCommandId: transition.holderCommandId }),
      previousHolderDeviceId: transition.previousHolderDeviceId,
      reason: transition.reason,
    },
  });
}

/** The id of the terminal-lease scenario. */
export const TERMINAL_LEASE_SCENARIO_ID = "terminal-lease";

const OWNER = TERMINAL_SCENARIO_ROLES.owner;
const OTHER_DEVICE = TERMINAL_SCENARIO_ROLES.otherDevice;
const AGENT = TERMINAL_SCENARIO_ROLES.agent;

/** A shell changing hands between two devices and an agent run, ending held by the owner. */
export const TERMINAL_LEASE_SCENARIO: Scenario = {
  id: TERMINAL_LEASE_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "One of the session's shells moving between two of the user's devices and an agent " +
    "run — the run queued, started, taken on the agent path, and completed, so the run-idle " +
    "release follows the acquisition it releases — reaching each automatic ending of a hold " +
    "and ending held. The output stream is absent until the terminal pane's " +
    "renderer is registered.",
  sessionId: TERMINAL_SCENARIO_SESSION_ID,
  userIdsInJoinOrder: [OWNER, OTHER_DEVICE, AGENT],
  // The owner is the device at this window. The lease line's `held-by-me` arm needs a caller
  // that names the holder, and this scenario ends with the owner holding the lease.
  callerUserId: OWNER,
  startedAtIso: TERMINAL_SCENARIO_STARTED_AT_ISO,
  beats: [
    terminalScenarioBeat({
      atMs: 0,
      sequence: 1,
      kind: "session.created",
      actorId: OWNER,
      // The lead born with the session is the agent that later takes the shell. The payload
      // carries no state transition; `session.activated` below reaches `active`.
      payload: composeSessionCreatedPayload({
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        shape: "project",
        openedBy: OWNER,
        lead: {
          agentId: AGENT,
          name: "Builder",
          driverName: "codex",
          modelId: "gpt-5.6-luna",
        },
        createdAt: TERMINAL_SCENARIO_STARTED_AT_ISO,
      }),
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
    terminalLeaseTransitionBeat({
      atMs: 1200,
      sequence: 3,
      holderDeviceId: OTHER_DEVICE,
      previousHolderDeviceId: null,
      reason: "taken",
      actorId: OTHER_DEVICE,
    }),
    terminalLeaseTransitionBeat({
      atMs: 1800,
      sequence: 4,
      holderDeviceId: null,
      previousHolderDeviceId: OTHER_DEVICE,
      reason: "auto_released_disconnect",
      actorId: OTHER_DEVICE,
    }),
    terminalScenarioBeat({
      atMs: 3000,
      sequence: 5,
      kind: "run.queued",
      // The person who started the run, not the agent. `previousState` is absent because a
      // queued run is being born.
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
      sequence: 6,
      kind: "run.starting",
      // No actor: the daemon moves a run through its own states.
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
      sequence: 7,
      kind: "run.running",
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        runId: TERMINAL_AGENT_RUN_ID,
        runVersion: 3,
        previousState: "starting",
        newState: "running",
      },
    }),
    // The run's take has no actor on purpose: it goes through the daemon's own lease authority.
    // The holder is the machine's own device, with the run and its command named beside it.
    terminalLeaseTransitionBeat({
      atMs: 3300,
      sequence: 8,
      holderDeviceId: OWNER,
      holderRunId: TERMINAL_AGENT_RUN_ID,
      holderCommandId: TERMINAL_AGENT_COMMAND_ID,
      previousHolderDeviceId: null,
      reason: "taken",
    }),
    terminalScenarioBeat({
      atMs: 3600,
      sequence: 9,
      kind: "run.completed",
      // The holding run's first transition out of `running`, which the release below follows.
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
      sequence: 10,
      holderDeviceId: null,
      previousHolderDeviceId: OWNER,
      reason: "auto_released_run_idle",
    }),
    // The held steady state: the holder the pane's header names.
    terminalLeaseTransitionBeat({
      atMs: 4100,
      sequence: 11,
      holderDeviceId: OWNER,
      previousHolderDeviceId: null,
      reason: "taken",
      actorId: OWNER,
    }),
  ],
  replies: [],
};
