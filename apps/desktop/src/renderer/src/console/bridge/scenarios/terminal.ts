// The terminal scenario — one shared shell changing hands, and ending held.
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
// The payload members are `Spec-006`'s own: a holder, the holder it replaced, and
// the reason. `holderParticipantId: null` is the free lease, and it is written as
// an explicit null rather than an omitted member because 8.8 makes an unheld lease
// an explicit state that reads differently from a suppressed one.
//
// IT ENDS HELD, WHICH IS NOT A DETAIL. `runToCompletion()` is the screenshot tier's
// entry point, so the last beat is the frame a baseline pins. The pane's headline
// state is a held lease with a named holder and a claim control that must not offer
// itself to a non-holder, and a scenario that ran to a free lease would pin the
// emptiest frame the surface has instead of its busiest.
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
// Never rule reads "never derives the holder from the last observed claim".
//
// ITS LENGTH IS ITS SCRIPT'S LENGTH. The package's "a file over about 400 lines is
// doing two jobs" rule is a heuristic for a module that grew a second job; this one
// declares one session's beats in the order they play, and a script split across two
// files is a script whose order no longer reads off the page.
//
// WHAT REMAINS UNREACHABLE FROM A SCENARIO, STATED RATHER THAN QUIETLY MISSING. The
// three refusals (`pty.permission_denied` before any lease comparison,
// `pty.control_held_by_other` carrying the holder, `pty.control_not_held` on a
// release by a non-holder) are rejections of a CALL, and `ScenarioReply` always
// resolves — it carries a result, never an error. They are reachable today only
// through the growth port's own refusal, which the lease operations return.

import type { ConsoleScenario } from "../scenario.js";

export const TERMINAL_SCENARIO_ID = "terminal";

// Wire-declared UUIDs rather than readable placeholders: `wire-truth.ts` presents
// each beat to the strict contract layer as the whole envelope it claims to be,
// and an envelope whose session or actor is not the UUID the contract declares is
// a beat no daemon could emit.
const SESSION_ID = "019b7b30-0280-75e5-8510-ada11a5a5555";

const HUMAN_PARTICIPANT_ID = "019b7b30-0280-79a4-8110-cca0117a0130";
const HUMAN_MEMBERSHIP_ID = "019b7b30-0280-7e3b-8110-cca0117a0131";
const SECOND_HUMAN_PARTICIPANT_ID = "019b7b30-0280-79a4-8110-cca0117a0132";
const SECOND_HUMAN_MEMBERSHIP_ID = "019b7b30-0280-7e3b-8110-cca0117a0133";
const AGENT_PARTICIPANT_ID = "019b7b30-0280-7a6e-8100-d1a4c1150034";

/**
 * The agent's run, here rather than implied: `auto_released_run_idle` releases the
 * lease when THE ACQUIRING RUN leaves its running state, so the reason cannot be
 * scripted without a run to bind it to. Wire-declared, for the reason above.
 */
const AGENT_RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0134";

/**
 * The node hosting the session's one terminal. Bound because three surfaces name it
 * and they must agree: the presence beats, the roster reply's node row, and the
 * degraded state's one line naming the node. A pane naming a different node than the
 * one whose presence dropped sends a person to the wrong machine.
 */
const TERMINAL_HOST_NODE_ID = "node-workstation";

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

export const TERMINAL_SCENARIO: ConsoleScenario = {
  id: TERMINAL_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "The session's one shared shell moving between two people and an agent run — the run queued, started, taken on the agent path, and completed, so the run-idle release follows the acquisition it releases — reaching all five transition reasons, ending held, then losing its host so the unheld-and-read-only degraded state is reachable. The output stream is absent until the terminal pane's renderer surface is registered.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [
    HUMAN_PARTICIPANT_ID,
    SECOND_HUMAN_PARTICIPANT_ID,
    AGENT_PARTICIPANT_ID,
  ],
  startedAtIso: "2026-01-01T16:40:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T16:40:00.000Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        // The registered shape, verbatim: the new session's id plus the resolved
        // config and metadata, both open records the corpus names no key inside. A
        // session's name is read off `session.list`, and the lifecycle payload
        // carries no state transition — `session.activated` below is the separate
        // registered event that reaches `active`.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 30,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "session.activated",
        occurredAt: "2026-01-01T16:40:00.030Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          previousState: "provisioning",
          newState: "active",
          actor: HUMAN_PARTICIPANT_ID,
        },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        // The canonical first-joined event. `participant.joined` is not a
        // registered type, so a fixture scripting it would be scripting a string
        // no consumer will ever receive.
        kind: "membership.created",
        occurredAt: "2026-01-01T16:40:00.060Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        // The registered membership shape: the membership row's own id, the
        // participant, the role from the closed role vocabulary, and the handle.
        payload: {
          membershipId: HUMAN_MEMBERSHIP_ID,
          participantId: HUMAN_PARTICIPANT_ID,
          role: "owner",
          identityHandle: "sawyer",
        },
      },
    },
    {
      atMs: 100,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "membership.created",
        occurredAt: "2026-01-01T16:40:00.100Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        // A collaborator, not a viewer, and the choice is load-bearing: taking
        // the lease is owner/collaborator-only, so a viewer second participant
        // could never hold it and the hand-off below would be unreachable.
        payload: {
          membershipId: SECOND_HUMAN_MEMBERSHIP_ID,
          participantId: SECOND_HUMAN_PARTICIPANT_ID,
          role: "collaborator",
          identityHandle: "priya",
        },
      },
    },
    {
      atMs: 160,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "runtime_node.online",
        occurredAt: "2026-01-01T16:40:00.160Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        // The terminal's host, present before any lease exists. Without it the
        // offline beat at the end would drop a node the pane had never heard of,
        // and the degraded line naming the node would have no name to use.
        payload: {
          sessionId: SESSION_ID,
          nodeId: TERMINAL_HOST_NODE_ID,
          previousState: "registering",
          newState: "online",
          actor: HUMAN_PARTICIPANT_ID,
        },
      },
    },
    {
      atMs: 220,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "agent.attached",
        occurredAt: "2026-01-01T16:40:00.220Z",
        // The person who attached the agent, not the agent: an agent does not
        // attach itself, and the envelope actor is who acted.
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_PARTICIPANT_ID,
          name: "Builder",
          driverName: "codex",
          modelId: "gpt-5.6-luna",
          defaultNodeId: TERMINAL_HOST_NODE_ID,
          state: "ready",
          actor: HUMAN_PARTICIPANT_ID,
        },
      },
    },
    {
      atMs: 400,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:00.400Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:00.900Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: HUMAN_PARTICIPANT_ID,
          reason: "released",
        },
      },
    },
    {
      atMs: 1200,
      event: {
        sessionId: SESSION_ID,
        sequence: 9,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:01.200Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 1800,
      event: {
        sessionId: SESSION_ID,
        sequence: 10,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:01.800Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
          reason: "auto_released_disconnect",
        },
      },
    },
    {
      atMs: 2300,
      event: {
        sessionId: SESSION_ID,
        sequence: 11,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:02.300Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 2700,
      event: {
        sessionId: SESSION_ID,
        sequence: 12,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:02.700Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: HUMAN_PARTICIPANT_ID,
          reason: "auto_released_authorization_lost",
        },
      },
    },
    {
      atMs: 3000,
      event: {
        sessionId: SESSION_ID,
        sequence: 13,
        kind: "run.queued",
        occurredAt: "2026-01-01T16:40:03.000Z",
        // The person who started the run, not the agent. `previousState` is absent
        // here and only here: a queued run is being born, and no document names the
        // state it came from.
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          runId: AGENT_RUN_ID,
          runVersion: 1,
          newState: "queued",
          agentId: AGENT_PARTICIPANT_ID,
        },
      },
    },
    {
      atMs: 3100,
      event: {
        sessionId: SESSION_ID,
        sequence: 14,
        kind: "run.starting",
        occurredAt: "2026-01-01T16:40:03.100Z",
        // No actor: the daemon moves a run through its own states, and a
        // participant id here would attribute a system transition to a person.
        payload: {
          sessionId: SESSION_ID,
          runId: AGENT_RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 3200,
      event: {
        sessionId: SESSION_ID,
        sequence: 15,
        kind: "run.running",
        occurredAt: "2026-01-01T16:40:03.200Z",
        payload: {
          sessionId: SESSION_ID,
          runId: AGENT_RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
        },
      },
    },
    {
      atMs: 3300,
      event: {
        sessionId: SESSION_ID,
        sequence: 16,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:03.300Z",
        // THE AGENT-PATH TAKE, with no actor on purpose: the node's own agent runs
        // take through the daemon's in-process lease authority, so nobody pressed a
        // control and the ledger's actor column reads "The daemon".
        payload: {
          sessionId: SESSION_ID,
          // The NODE-OWNER participant, which is who an agent-path take holds as:
          // agents are `AgentId`-keyed domain actors and not `participants` rows,
          // so no agent-participant exists to hold and the holder surfaces stay
          // participant ids (`api-payload-contracts.md §Session Terminal-Control
          // Method Registry`). The roster reply below names the same owner.
          holderParticipantId: HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 3600,
      event: {
        sessionId: SESSION_ID,
        sequence: 17,
        kind: "run.completed",
        occurredAt: "2026-01-01T16:40:03.600Z",
        // The acquiring run's first lifecycle transition out of `running` — what the
        // auto-release below is a consequence of, rather than an asserted state.
        payload: {
          sessionId: SESSION_ID,
          runId: AGENT_RUN_ID,
          runVersion: 4,
          previousState: "running",
          newState: "completed",
        },
      },
    },
    {
      atMs: 3700,
      event: {
        sessionId: SESSION_ID,
        sequence: 18,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:03.700Z",
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: HUMAN_PARTICIPANT_ID,
          reason: "auto_released_run_idle",
        },
      },
    },
    {
      atMs: 4100,
      event: {
        sessionId: SESSION_ID,
        sequence: 19,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:04.100Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        // The held-lease steady state. Everything above this beat is history in
        // the transition ledger; this is the holder the pane's header names and
        // the roster's `controlHolder` agrees with.
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 4900,
      event: {
        sessionId: SESSION_ID,
        sequence: 20,
        kind: "runtime_node.offline",
        occurredAt: "2026-01-01T16:40:04.900Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        // THE DEGRADED BEAT. `heartbeat_lost` and not `explicit_shutdown`,
        // because the case the read-side suppression exists for is the host that
        // never says goodbye — a crashed or powered-off machine calls no detach,
        // and its presence transition is the only signal it emits. The lease
        // record is untouched and no `pty.control_changed` follows: the holder
        // stops being ADVERTISED, not released.
        payload: {
          sessionId: SESSION_ID,
          nodeId: TERMINAL_HOST_NODE_ID,
          previousState: "online",
          newState: "offline",
          lastHeartbeatAt: "2026-01-01T16:40:03.780Z",
          reason: "heartbeat_lost",
        },
      },
    },
  ],
  replies: [
    { call: "session.list", result: { sessions: [{ sessionId: SESSION_ID }] } },
    { call: "agent.list", result: { agents: [{ agentId: AGENT_PARTICIPANT_ID }] } },
    {
      call: "runtimenode.roster",
      // 8.8's loading state, scripted rather than described: "the pane attaches
      // with scrollback and the claim control settles last". The claim control
      // settles last precisely because it waits on the holder projection, so the
      // roster read is the one that arrives late. The frozen clock is the only
      // clock, so a caller advances the engine past this tick to settle it.
      afterMs: 260,
      result: {
        // The projection the design's wire table grades "CP-LIVE query, FIXTURE
        // field". `runtimenode.roster` is a registered control-plane procedure and
        // `RuntimeNodeRosterResponse.controlHolder` is specified in
        // `docs/architecture/contracts/api-payload-contracts.md §Session
        // Terminal-Control Method Registry` — but the SHIPPED `.strict()` schema
        // in `packages/contracts` carries `nodes` alone, because the lease's
        // projection extension ships with the Plan-024 lease leg. So this reply
        // is the specified shape and not yet the compiled one, which is exactly
        // what the FIXTURE grading records; the member leaves this file when that
        // leg lands and the console reads it off the type.
        controlHolder: HUMAN_PARTICIPANT_ID,
        nodes: [
          {
            nodeId: TERMINAL_HOST_NODE_ID,
            participantId: HUMAN_PARTICIPANT_ID,
            state: "online",
            healthState: "online",
            lastHeartbeatAt: "2026-01-01T16:40:03.780Z",
            readOnly: false,
            capabilities: {},
            clientVersion: "1.0",
            attachedAt: "2026-01-01T16:40:00.160Z",
          },
        ],
      },
    },
  ],
};
