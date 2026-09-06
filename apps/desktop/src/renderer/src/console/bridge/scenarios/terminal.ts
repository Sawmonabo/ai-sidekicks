// The terminal scenario — one shared shell changing hands, and ending degraded.
//
// THIS FILE IS THE SCRIPT. The cast is in `terminal-cast.ts`, and the beat envelope
// and its clock in `terminal-beats.ts`.
// What stays here is the one thing that has to be read in order to be understood:
// which beat follows which, and why.
//
// WHAT IT CAN SCRIPT, AND WHY IT IS MORE THAN THE BROWSER'S. The terminal's own
// renderer surface is unregistered (`Plan-023 §Console growth slate` row 3), but the
// lease is not: `pty.control_changed` is a registered event type with a closed
// five-member reason vocabulary, and the holder is a field on it. So the transitions
// this scenario scripts are wire-true today, and it is the terminal output — the
// bytes, the scrollback, the resize — that has no type to carry it and is absent
// here rather than invented.
//
// THE FIVE REASONS ARE THE POINT. `Spec-023 §Console Design (Meridian)` 8.8 requires
// every transition to render as a ledger line naming its reason, with the three
// automatic reasons kept distinct — the holder disconnected, the holder lost
// authorization, or the acquiring agent run left its running state. A fixture that
// scripted only `taken` and `released` would let a surface collapse the other three
// into one sentence and still look right, so all five appear below, in the order a
// session reaches them.
//
// AND EACH ONE IS REACHED THE WAY THE DAEMON REACHES IT. A reason scripted onto a
// sequence no daemon produces is a fixture that looks exercised and is not, so the
// run-idle release below is preceded by the acquisition it releases: the agent's run
// queued, started, and reached `running`; an AGENT-PATH take bound to that run; the
// run leaving `running`; and only then `auto_released_run_idle` for that holder.
// `Spec-003 §Required Behavior` makes this release the acquiring run's first
// lifecycle transition out of `running` after an agent-path take, and it leaves a
// client-acquired human hold alone — so releasing a human who had simply pressed
// Claim was a beat with no producer, and the tests and baselines reading it were
// exercising nothing.
//
// IT ENDS DEGRADED, WHICH IS NOT A DETAIL. `runToCompletion()` is the screenshot
// tier's entry point, so the last beat is the frame a baseline pins — and the last
// beat is the host going silent under a lease that had just been taken. The frame is
// therefore 8.8's degraded state: unheld and read-only, with the node named, standing
// over a transition ledger that reached all five reasons and a claim control that
// offers itself to nobody. That is the busier frame as well as the more honest one,
// because it carries everything the held frame carried plus the reading that took the
// keyboard away. A script that ended on a plain free lease would pin the emptiest
// frame the surface has; one that stopped at the final take would pin a surface whose
// degraded state no baseline had ever seen.
//
// THE DEGRADED STATE ARRIVES WITHOUT A TRANSITION, AND THAT IS THE WHOLE DESIGN.
// 8.8's degraded state is a holder whose node has gone offline: the pane renders
// unheld and read-only under one line naming the node. There is deliberately NO
// `pty.control_changed` for it — the roster read SUPPRESSES `controlHolder` to null
// while the producing node reads offline and writes nothing, so nothing transitioned
// and a read authors no events (`api-payload-contracts.md §Session Terminal-Control
// Method Registry`). The only wire signal a departed host emits is its presence
// transition, so this scenario scripts exactly that — a `runtime_node.offline` beat
// after the final take — and a surface that derived the unheld rendering from a
// missing `pty.control_changed` would never reach it, which is also why 8.8's last
// Never rule reads "never derives the holder from the last observed claim". The pane
// reaches it by folding these presence beats beside the lease ones —
// `terminal/pane/node-presence-model.ts` — and handing the host's reported reachability to
// the lease fold as its vouching input.
//
// WHAT REMAINS UNREACHABLE FROM A SCENARIO, STATED RATHER THAN QUIETLY MISSING. The
// three refusals (`pty.permission_denied` before any lease comparison,
// `pty.control_held_by_other` carrying the holder, `pty.control_not_held` on a
// release by a non-holder) are rejections of a CALL, and `ScenarioReply` always
// resolves — it carries a result, never an error. They are reachable today only
// through the growth port's own refusal, which the lease operations return.

import type { ConsoleScenario } from "../scenario-runtime/index.js";
import {
  TERMINAL_HOST_NODE_ATTACHED_AT_MS,
  TERMINAL_HOST_NODE_LAST_HEARTBEAT_AT_MS,
  TERMINAL_SCENARIO_STARTED_AT_ISO,
  terminalLeaseTransitionBeat,
  terminalScenarioBeat,
  terminalScenarioInstantAt,
} from "./terminal-beats.js";
import {
  TERMINAL_AGENT_RUN_ID,
  TERMINAL_COLLABORATOR_MEMBERSHIP_ID,
  TERMINAL_HOST_NODE_ID,
  TERMINAL_OWNER_MEMBERSHIP_ID,
  TERMINAL_SCENARIO_CAST,
  TERMINAL_SCENARIO_SESSION_ID,
} from "./terminal-cast.js";

// The cast reaches this family's consumers through the script they already import.
// The VALUE only: `TerminalScenarioCast` stays exported from the module that
// declares it and is re-exported nowhere, because a type re-exported through a
// second module that never mentions it is an export with no reader, which the
// dead-code gate reports rather than tolerates.
export { TERMINAL_SCENARIO_CAST } from "./terminal-cast.js";

export const TERMINAL_SCENARIO_ID = "terminal";

const OWNER = TERMINAL_SCENARIO_CAST.owner;
const COLLABORATOR = TERMINAL_SCENARIO_CAST.collaborator;
const AGENT = TERMINAL_SCENARIO_CAST.agent;

export const TERMINAL_SCENARIO: ConsoleScenario = {
  id: TERMINAL_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "The session's one shared shell moving between two people and an agent run — the run queued, started, taken on the agent path, and completed, so the run-idle release follows the acquisition it releases — reaching all five transition reasons, ending held, then losing its host so the unheld-and-read-only degraded state is reachable. The output stream is absent until the terminal pane's renderer surface is registered.",
  sessionId: TERMINAL_SCENARIO_SESSION_ID,
  participantIdsInJoinOrder: [OWNER, COLLABORATOR, AGENT],
  // The owner is the person at this window. The lease line's `held-by-me` arm —
  // and the handback it offers — is reachable only when the caller read names
  // the holder, and this scenario ends with the owner holding the degraded
  // lease; without a viewer the pane can only show that the identity is being
  // read, which is a true state of the console and not the state this
  // scenario exists to show. The agent holds no membership, so it takes no role.
  viewingParticipantId: OWNER,
  membershipRoleByParticipantId: {
    [OWNER]: "owner",
    [COLLABORATOR]: "collaborator",
  },
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
      atMs: 60,
      sequence: 3,
      // The canonical first-joined event. `participant.joined` is not a registered
      // type, so a fixture scripting it would be scripting a string no consumer
      // will ever receive. The registered membership shape: the membership row's
      // own id, the participant, the role from the closed role vocabulary, and the
      // handle.
      kind: "membership.created",
      actorId: OWNER,
      payload: {
        membershipId: TERMINAL_OWNER_MEMBERSHIP_ID,
        participantId: OWNER,
        role: "owner",
        identityHandle: "sawyer",
      },
    }),
    terminalScenarioBeat({
      atMs: 100,
      sequence: 4,
      kind: "membership.created",
      actorId: COLLABORATOR,
      // A collaborator, not a viewer, and the choice is load-bearing: taking the
      // lease is owner/collaborator-only, so a viewer second participant could
      // never hold it and the hand-off below would be unreachable.
      payload: {
        membershipId: TERMINAL_COLLABORATOR_MEMBERSHIP_ID,
        participantId: COLLABORATOR,
        role: "collaborator",
        identityHandle: "priya",
      },
    }),
    terminalScenarioBeat({
      atMs: TERMINAL_HOST_NODE_ATTACHED_AT_MS,
      sequence: 5,
      kind: "runtime_node.online",
      actorId: OWNER,
      // The terminal's host, present before any lease exists. Without it the
      // offline beat at the end would drop a node the pane had never heard of, and
      // the degraded line naming the node would have no name to use.
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        nodeId: TERMINAL_HOST_NODE_ID,
        previousState: "registering",
        newState: "online",
        actor: OWNER,
      },
    }),
    terminalScenarioBeat({
      atMs: 220,
      sequence: 6,
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
        defaultNodeId: TERMINAL_HOST_NODE_ID,
        state: "ready",
        actor: OWNER,
      },
    }),
    terminalLeaseTransitionBeat({
      atMs: 400,
      sequence: 7,
      holderParticipantId: OWNER,
      previousHolderParticipantId: null,
      reason: "taken",
      actorId: OWNER,
    }),
    terminalLeaseTransitionBeat({
      atMs: 900,
      sequence: 8,
      holderParticipantId: null,
      previousHolderParticipantId: OWNER,
      reason: "released",
      actorId: OWNER,
    }),
    terminalLeaseTransitionBeat({
      atMs: 1200,
      sequence: 9,
      holderParticipantId: COLLABORATOR,
      previousHolderParticipantId: null,
      reason: "taken",
      actorId: COLLABORATOR,
    }),
    terminalLeaseTransitionBeat({
      atMs: 1800,
      sequence: 10,
      holderParticipantId: null,
      previousHolderParticipantId: COLLABORATOR,
      reason: "auto_released_disconnect",
      actorId: COLLABORATOR,
    }),
    terminalLeaseTransitionBeat({
      atMs: 2300,
      sequence: 11,
      holderParticipantId: OWNER,
      previousHolderParticipantId: null,
      reason: "taken",
      actorId: OWNER,
    }),
    terminalLeaseTransitionBeat({
      atMs: 2700,
      sequence: 12,
      holderParticipantId: null,
      previousHolderParticipantId: OWNER,
      reason: "auto_released_authorization_lost",
      actorId: OWNER,
    }),
    terminalScenarioBeat({
      atMs: 3000,
      sequence: 13,
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
      sequence: 14,
      kind: "run.starting",
      // No actor: the daemon moves a run through its own states, and a participant
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
      sequence: 15,
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
    // NODE-OWNER participant, which is who an agent-path take holds as: agents are
    // `AgentId`-keyed domain actors and not `participants` rows, so no
    // agent-participant exists to hold and the holder surfaces stay participant ids
    // (`api-payload-contracts.md §Session Terminal-Control Method Registry`). The
    // roster reply names the same owner.
    terminalLeaseTransitionBeat({
      atMs: 3300,
      sequence: 16,
      holderParticipantId: OWNER,
      previousHolderParticipantId: null,
      reason: "taken",
    }),
    terminalScenarioBeat({
      atMs: 3600,
      sequence: 17,
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
      sequence: 18,
      holderParticipantId: null,
      previousHolderParticipantId: OWNER,
      reason: "auto_released_run_idle",
    }),
    // The held-lease steady state. Everything above this beat is history in the
    // transition ledger; this is the holder the pane's header names and the
    // roster's `controlHolder` agrees with.
    terminalLeaseTransitionBeat({
      atMs: 4100,
      sequence: 19,
      holderParticipantId: OWNER,
      previousHolderParticipantId: null,
      reason: "taken",
      actorId: OWNER,
    }),
    terminalScenarioBeat({
      atMs: 4900,
      sequence: 20,
      kind: "runtime_node.offline",
      actorId: OWNER,
      // THE DEGRADED BEAT. `heartbeat_lost` and not `explicit_shutdown`, because
      // the case the read-side suppression exists for is the host that never says
      // goodbye — a crashed or powered-off machine calls no detach, and its
      // presence transition is the only signal it emits. The lease record is
      // untouched and no `pty.control_changed` follows: the holder stops being
      // ADVERTISED, not released.
      payload: {
        sessionId: TERMINAL_SCENARIO_SESSION_ID,
        nodeId: TERMINAL_HOST_NODE_ID,
        previousState: "online",
        newState: "offline",
        lastHeartbeatAt: terminalScenarioInstantAt(TERMINAL_HOST_NODE_LAST_HEARTBEAT_AT_MS),
        reason: "heartbeat_lost",
      },
    }),
  ],
  // The one read the scenario answers. Everything the terminal family itself needs
  // arrives as beats: the holder is a field on `pty.control_changed`, and the host's
  // presence is the `runtime_node.*` pair above — so no roster read is scripted, and
  // a scripted reply nothing calls would be a promise the wire has not made.
  replies: [
    { call: "agent.list", result: { agents: [{ agentId: TERMINAL_SCENARIO_CAST.agent }] } },
  ],
};
