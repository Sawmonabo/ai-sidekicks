// The terminal-lease scenario: one of a session's shells changing hands, and ending held.
//
// `pty.control_changed` is a registered event type with a closed reason vocabulary, so the
// lease transitions are wire-true. Terminal output (bytes, scrollback, resize) has no
// registered type and is absent rather than invented.
//
// A hold ends four ways and the script reaches each: another device takes the shell (a shell
// has no release control), the holder's connection ends, the command a run holds the shell for
// ends, or the holding run leaves `running`. Each is reached as the daemon reaches it: after the
// run's queued, starting and `running` beats, an agent-path take bound to the run and its first
// command, that command's stored ending and the release that follows it, a take for the run's
// next command, and the run leaving `running`. That last release is the holding run's first
// transition out of `running` and leaves a device's hold alone.
//
// The lease is per shell and the holder is a device: every transition names its shell, and a
// run's hold names the machine's own device and the run.
//
// The script ends held, on the owner taking the shell, because the scenario plays to the
// last beat and a named holder is the frame that carries the most.

import { composeSessionCreatedPayload } from "../data/opening-entries.js";
import {
  composeScenarioInstant,
  composeScriptBeats,
  createRunEntryBuilders,
  type ScriptEntry,
} from "../data/script-entries.js";
import type { Scenario } from "../scenario.js";

// Who and what the scenario is about: the session, the owner, a second device and the agent's
// run. Ids are UUIDs because the contract check presents each beat to the strict layer as a
// whole envelope.
const OWNER_ID = "019b7b30-0280-79a4-8110-cca0117a0130";
const OTHER_DEVICE_ID = "019b7b30-0280-79a4-8110-cca0117a0132";
const AGENT_ID = "019b7b30-0280-7a6e-8100-d1a4c1150034";

/** The session whose shell this scenario is about. */
const TERMINAL_SCENARIO_SESSION_ID = "019b7b30-0280-75e5-8510-ada11a5a5555";

/**
 * The shell the lease moves on. The terminal pane names its shell by the session's id until
 * it reads the shell list, so the scenario's shell carries that id.
 */
const TERMINAL_SCENARIO_SHELL_ID = TERMINAL_SCENARIO_SESSION_ID;

/** The agent's run; `auto_released_run_idle` needs a holding run to bind to. */
const TERMINAL_AGENT_RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0134";

/** The run's first command, whose ending gives the shell back. */
const TERMINAL_AGENT_COMMAND_ID = "command-pnpm-test";

/** The run's next command, which holds the shell when the run leaves `running`. */
const TERMINAL_AGENT_NEXT_COMMAND_ID = "command-pnpm-lint";

/**
 * The scenario's cast by role, so tests get each id with the role it plays.
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
   * The session's lead, whose run's command ending and idling are two of the ways a hold ends.
   * The run binds to
   * the lease, never this id: a run's take names the machine's own device and the run.
   */
  readonly agent: string;
}

/** The scenario's owner, other device and agent, by role. */
export const TERMINAL_SCENARIO_ROLES: TerminalScenarioRoles = {
  owner: OWNER_ID,
  otherDevice: OTHER_DEVICE_ID,
  agent: AGENT_ID,
};

// Wall-clock instant the frozen clock reports as "now" at tick zero. `Date.UTC` names the
// fields, so the instant never depends on the host's zone the way a zone-less parsed stamp does.
const TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS: number = Date.UTC(2026, 0, 1, 16, 40, 0, 0);

const TERMINAL_SCENARIO_STARTED_AT_ISO: string = composeScenarioInstant(
  TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS,
  0,
);

// The stem row ids are minted from; `composeScriptBeats` completes it with the beat's position.
const TERMINAL_EVENT_ID_STEM = "019b7b30-0280-7ea1-8110-e5e0d115";

/** What one lease transition says. The payload members are the wire's own. */
interface TerminalLeaseTransitionInput {
  readonly atMs: number;
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

// One `pty.control_changed` entry, so the hand-off sequence reads as a table.
function leaseTransitionEntry(transition: TerminalLeaseTransitionInput): ScriptEntry {
  return {
    atMs: transition.atMs,
    kind: "pty.control_changed",
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
  };
}

const run = createRunEntryBuilders(TERMINAL_SCENARIO_SESSION_ID);

const TERMINAL_LEASE_SCRIPT: readonly ScriptEntry[] = [
  {
    atMs: 0,
    kind: "session.created",
    actorId: OWNER_ID,
    // The lead born with the session is the agent that later takes the shell. The payload
    // carries no state transition; `session.activated` below reaches `active`.
    payload: composeSessionCreatedPayload({
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      shape: "project",
      openedBy: OWNER_ID,
      lead: {
        agentId: AGENT_ID,
        name: "Builder",
        driverName: "codex",
        modelId: "gpt-5.6-luna",
      },
      createdAt: TERMINAL_SCENARIO_STARTED_AT_ISO,
    }),
  },
  {
    atMs: 30,
    kind: "session.activated",
    actorId: OWNER_ID,
    payload: {
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      previousState: "provisioning",
      newState: "active",
      actor: OWNER_ID,
    },
  },
  leaseTransitionEntry({
    atMs: 1200,
    holderDeviceId: OTHER_DEVICE_ID,
    previousHolderDeviceId: null,
    reason: "taken",
    actorId: OTHER_DEVICE_ID,
  }),
  leaseTransitionEntry({
    atMs: 1800,
    holderDeviceId: null,
    previousHolderDeviceId: OTHER_DEVICE_ID,
    reason: "auto_released_disconnect",
    actorId: OTHER_DEVICE_ID,
  }),
  // The person who started the run, not the agent. `previousState` is absent because a queued
  // run is being born.
  run.transition(TERMINAL_AGENT_RUN_ID, {
    atMs: 3000,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ID,
    actorId: OWNER_ID,
  }),
  // No actor: the daemon moves a run through its own states.
  run.transition(TERMINAL_AGENT_RUN_ID, {
    atMs: 3100,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  run.transition(TERMINAL_AGENT_RUN_ID, {
    atMs: 3200,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  // The run's take has no actor on purpose: it goes through the daemon's own lease authority.
  // The holder is the machine's own device, with the run and its command named beside it.
  leaseTransitionEntry({
    atMs: 3300,
    holderDeviceId: OWNER_ID,
    holderRunId: TERMINAL_AGENT_RUN_ID,
    holderCommandId: TERMINAL_AGENT_COMMAND_ID,
    previousHolderDeviceId: null,
    reason: "taken",
  }),
  // The command's stored ending, which the release below follows.
  {
    atMs: 3400,
    kind: "command.ended",
    payload: {
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      runId: TERMINAL_AGENT_RUN_ID,
      commandId: TERMINAL_AGENT_COMMAND_ID,
      ending: "finished",
      exitCode: 0,
      durationMs: 100,
    },
  },
  leaseTransitionEntry({
    atMs: 3450,
    holderDeviceId: null,
    previousHolderDeviceId: OWNER_ID,
    reason: "auto_released_command_ended",
  }),
  leaseTransitionEntry({
    atMs: 3500,
    holderDeviceId: OWNER_ID,
    holderRunId: TERMINAL_AGENT_RUN_ID,
    holderCommandId: TERMINAL_AGENT_NEXT_COMMAND_ID,
    previousHolderDeviceId: null,
    reason: "taken",
  }),
  // The holding run's first transition out of `running`, which the release below follows.
  run.transition(TERMINAL_AGENT_RUN_ID, {
    atMs: 3600,
    runVersion: 4,
    previousState: "running",
    newState: "completed",
  }),
  leaseTransitionEntry({
    atMs: 3700,
    holderDeviceId: null,
    previousHolderDeviceId: OWNER_ID,
    reason: "auto_released_run_idle",
  }),
  // The held steady state: the holder the pane's header names.
  leaseTransitionEntry({
    atMs: 4100,
    holderDeviceId: OWNER_ID,
    previousHolderDeviceId: null,
    reason: "taken",
    actorId: OWNER_ID,
  }),
];

/** The id of the terminal-lease scenario. */
export const TERMINAL_LEASE_SCENARIO_ID = "terminal-lease";

/** A shell changing hands between two devices and an agent run, ending held by the owner. */
export const TERMINAL_LEASE_SCENARIO: Scenario = {
  id: TERMINAL_LEASE_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "One of the session's shells moving between two of the user's devices and an agent " +
    "run — the run queued, started, taken on the agent path for one command, given back when " +
    "that command ends, taken again for its next, and completed, so each release follows the " +
    "acquisition it releases — reaching each automatic ending of a hold " +
    "and ending held. The output stream is absent until the terminal pane's " +
    "renderer is registered.",
  sessionId: TERMINAL_SCENARIO_SESSION_ID,
  startedAtIso: TERMINAL_SCENARIO_STARTED_AT_ISO,
  beats: composeScriptBeats({
    sessionId: TERMINAL_SCENARIO_SESSION_ID,
    eventIdStem: TERMINAL_EVENT_ID_STEM,
    startedAtMs: TERMINAL_SCENARIO_STARTED_AT_MILLISECONDS,
    entries: TERMINAL_LEASE_SCRIPT,
  }),
  replies: [],
};
