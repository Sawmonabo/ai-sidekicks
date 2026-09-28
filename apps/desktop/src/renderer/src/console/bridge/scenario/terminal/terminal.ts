// The terminal scenario — one shared shell changing hands, and ending held.
//
// THIS FILE IS THE SCRIPT. The cast is in `cast.ts`, and the beat envelope and its
// clock in `beats.ts`. What stays here is the one thing that has to be read in order
// to be understood: which beat follows which, and why.
//
// WHAT IT CAN SCRIPT, AND WHY IT IS MORE THAN THE BROWSER'S. The terminal output has
// no registered type, but the lease does: `pty.control_changed` is a registered event
// type with a closed reason vocabulary, and the holder is a field on it.
// So the transitions this scenario scripts are wire-true today, and it is the
// terminal output — the bytes, the scrollback, the resize — that has no type to carry
// it and is absent here rather than invented.
//
// A HOLD ENDS THREE WAYS, AND THE SCRIPT REACHES EACH. There is no release control on a
// shell: a device hands it back only by another device taking it, or by the hold ending
// on its own. The automatic endings are the holder's connection ending, the holder
// losing authorization, and the acquiring agent run leaving its running state. All
// three appear below, in the order a session reaches them, so a surface that folded
// them into one sentence would not look right against this script.
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
// beat is the frame a baseline pins — and the last beat is the owner taking the
// shell, which is the frame that carries the most: a named holder and a script behind
// it that reached every ending. A script that ended on a plain free lease would pin
// the emptiest frame the surface has.

import type { ConsoleScenario } from "../runtime/index.js";
import {
  TERMINAL_SCENARIO_STARTED_AT_ISO,
  terminalLeaseTransitionBeat,
  terminalScenarioBeat,
} from "./beats.js";
import {
  TERMINAL_AGENT_RUN_ID,
  TERMINAL_SCENARIO_CAST,
  TERMINAL_SCENARIO_SESSION_ID,
} from "./cast.js";

// The cast reaches this family's consumers through the script they already import.
// The VALUE only: `TerminalScenarioCast` stays exported from the module that
// declares it and is re-exported nowhere, because a type re-exported through a
// second module that never mentions it is an export with no reader, which the
// dead-code gate reports rather than tolerates.
export { TERMINAL_SCENARIO_CAST } from "./cast.js";

export const TERMINAL_SCENARIO_ID = "terminal";

const OWNER = TERMINAL_SCENARIO_CAST.owner;
const OTHER_DEVICE = TERMINAL_SCENARIO_CAST.otherDevice;
const AGENT = TERMINAL_SCENARIO_CAST.agent;

export const TERMINAL_SCENARIO: ConsoleScenario = {
  id: TERMINAL_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "The session's one shared shell moving between two of the user's devices and an agent " +
    "run — the run queued, started, taken on the agent path, and completed, so the run-idle " +
    "release follows the acquisition it releases — reaching each automatic ending of a hold " +
    "and ending held. The output stream is absent until the terminal pane's renderer surface is " +
    "registered.",
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
    terminalLeaseTransitionBeat({
      atMs: 2300,
      sequence: 6,
      holderUserId: OWNER,
      previousHolderUserId: null,
      reason: "taken",
      actorId: OWNER,
    }),
    terminalLeaseTransitionBeat({
      atMs: 2700,
      sequence: 7,
      holderUserId: null,
      previousHolderUserId: OWNER,
      reason: "auto_released_authorization_lost",
      actorId: OWNER,
    }),
    terminalScenarioBeat({
      atMs: 3000,
      sequence: 8,
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
      sequence: 9,
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
      sequence: 10,
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
    // and the ledger's actor column reads "The daemon". The holder is the
    // NODE-OWNER user, which is who an agent-path take holds as: agents are
    // `AgentId`-keyed domain actors and not `users` rows, so no
    // agent-user exists to hold and the holder surfaces stay user
    // ids, exactly as the terminal-control method registry declares.
    terminalLeaseTransitionBeat({
      atMs: 3300,
      sequence: 11,
      holderUserId: OWNER,
      previousHolderUserId: null,
      reason: "taken",
    }),
    terminalScenarioBeat({
      atMs: 3600,
      sequence: 12,
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
      sequence: 13,
      holderUserId: null,
      previousHolderUserId: OWNER,
      reason: "auto_released_run_idle",
    }),
    // The held-lease steady state: the holder the pane's header names.
    terminalLeaseTransitionBeat({
      atMs: 4100,
      sequence: 14,
      holderUserId: OWNER,
      previousHolderUserId: null,
      reason: "taken",
      actorId: OWNER,
    }),
  ],
  replies: [],
};
