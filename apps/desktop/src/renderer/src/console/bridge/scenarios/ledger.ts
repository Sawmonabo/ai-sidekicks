// The ledger scenario — three lanes ending in three different conditions.
//
// The session the ledger frame, the chapters, the seams, the rail, and the replay
// scrub are all measured against. Each lane ends somewhere different, and the three
// endings are exactly the ones a reader has to be able to tell apart in one frame:
//
//   • The implementer's run runs, blocks on an approval, unblocks, is rewound past
//     a boundary, re-executes, and finishes — so its chapter is TERMINAL and folds
//     to a one-line past-tense receipt, with a superseded band inside it.
//   • The reviewer's run runs, fails a tool call, and is PAUSED — so its chapter
//     carries the pause seam and stays parked at the frozen tick.
//   • The architect's run is still LIVE at the last beat, mid-turn, so the frame
//     always has something streaming in it.
//
// A single-lane script would have rendered every one of those states too, one after
// another — and would have proved nothing about the thing this console exists for,
// which is several of them being true at once in different hues. The session's own
// EMPTY state is the one composition no script reaches, and it lives next door in
// `ledger-quiet.ts` for that reason.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, under the two-leg
// rule `scenarios/wire-truth.ts` states in its header: the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`), both in
// `packages/contracts/src/event.ts`, are the code leg, and the per-type payload rows of
// `docs/specs/006-session-event-taxonomy-and-audit-log.md` name the members of a
// registered type whose strict variant has not landed yet. That predicate holds this file
// to the code leg, and `scenarios/ledger-script.ts` carries the payload builders so a
// member cannot drift between two beats of one kind.
//
// FIVE THINGS THE DESIGN ASKS FOR THAT THIS SCRIPT DELIBERATELY DOES NOT SAY
//
//   • **The provider-switch seam.** `agent.provider_switched` and
//     `agent.provider_switch_failed` are in no shipped `SessionEventType`, so a
//     beat playing one would be a frame about a wire that does not exist. The seam
//     module already renders that absence rather than drawing the seam.
//   • **A resume and an unblock as their own rows.** `run.resumed` and
//     `run.unblocked` are likewise unregistered; the registered transition back is
//     `run.running`, and that is what this script plays.
//   • **An approval card.** `approval.requested` is a registered type, but the card it
//     would draw belongs to the surface that renders approvals — so the run reaches
//     `waiting_for_approval` and returns to `running`, which is the part of that story
//     the log can tell.
//   • **A cost or token reading.** Not because the members are unnamed — the taxonomy
//     leg names them, and `scenarios/flagship.ts` meters a cost against exactly that row
//     — but because this session's subject is the ledger frame, the chapters, the seams,
//     the rail, and the replay scrub, and the meter is not on any of them. Flagship is
//     the scenario that moves the meter; a second one here would be a reading no surface
//     in this session's frame reads. Scripting one would carry every member
//     `Spec-006 §Usage Telemetry (usage_telemetry)` makes required of a post-amendment
//     emitter — `costStatus`, `costSource`, and `effectivePrincipal` — exactly as
//     flagship's own builder does.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.

import { scriptLedgerBeats } from "./ledger-script.js";
import {
  AGENT_ARCHITECT,
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  EVENT_ID_STEM,
  LEDGER_AGENTS,
  PARTICIPANT_PRIYA,
  PARTICIPANT_YOU,
  SESSION_ID,
  STARTED_AT_ISO,
  attachedAtIso,
} from "./ledger-cast.js";
import { LEDGER_SCRIPT } from "./ledger-beats.js";
import { REFUSED_NEGOTIATION_REPLY } from "./negotiation-replies.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

export const LEDGER_SCENARIO_ID = "ledger";

export const LEDGER_SCENARIO: ConsoleScenario = {
  id: LEDGER_SCENARIO_ID,
  label: "Three lanes",
  purpose:
    "A session whose three runs end in three different conditions at once — one finished behind a rewind boundary, one parked, one still streaming — so the chapters, the seams, the rail, and the replay scrub all have something to render.",
  sessionId: SESSION_ID,
  // Join order IS hue order: two people first, then the agents in attach order,
  // which is what a real session's join log looks like.
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_ARCHITECT,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
  ],
  // Which of the roster this window is. Stated rather than read off the head of the
  // join order, which is whoever opened the session on whichever machine.
  viewingParticipantId: PARTICIPANT_YOU,
  // The roster every role gate resolves through. The viewer is an owner, which is what
  // lets a role-gated control be driven in this scenario at all; Priya's
  // `collaborator` is the same value her `membership.created` beat carries — one fact,
  // stated where the roster is read from and replayed where the log records it
  // arriving. The agents are absent on purpose: an agent is attached rather than
  // admitted and holds no membership, so a row here would resolve to a role no daemon
  // granted.
  membershipRoleByParticipantId: {
    [PARTICIPANT_YOU]: "owner",
    [PARTICIPANT_PRIYA]: "collaborator",
  },
  startedAtIso: STARTED_AT_ISO,
  beats: scriptLedgerBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtIso: STARTED_AT_ISO,
    entries: LEDGER_SCRIPT,
  }),
  replies: [
    {
      // `session.read`, not a `session.list`: the method registry carries no list
      // verb, and a fixture answering one would put a call in front of a surface
      // that has nowhere to send it.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: "2026-01-01T11:05:03.060Z",
        },
        // An ACKNOWLEDGED position beside the latest one, which is what makes the
        // resume cycle reachable at all: the store submits whatever a read
        // acknowledged on its NEXT read, and a reply carrying only `latest` names
        // no position to submit. Behind `latest`, as a real one is — this
        // participant has read most of the log and not all of it.
        timelineCursors: { latest: "ledger-cursor-33", acknowledged: "ledger-cursor-30" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: LEDGER_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          // `AgentState` is the four-state lifecycle. A run being in flight is a
          // RUN state, read from the run and never folded into the agent row.
          state: "ready",
          createdAt: attachedAtIso(agent.attachedAtMs),
        })),
      },
    },
    // The REFUSED handshake, and this scenario is where it belongs: its job is to
    // reach every state a surface renders, and the version banner has exactly one
    // state — a console and a runtime that did not meet. Scripted nowhere else, so
    // no demonstration window carries a claim about the operator's own install.
    //
    // It does not contradict the three lanes above it. An incompatible handshake
    // blocks MUTATING dispatch and leaves reads alone (`Spec-023 §Daemon Supervision
    // Lifecycle` step 3), and every beat this session plays is a replayed event —
    // which is what makes a refusal and a streaming ledger true at once rather than
    // an inconsistency the script papered over.
    REFUSED_NEGOTIATION_REPLY,
  ],
  // The REFUSED resume position, and this scenario is where it belongs for the reason
  // the handshake above it is: its job is to reach every state a surface renders, and
  // `SessionResumeDegraded` has exactly one — a position this console submitted that
  // the daemon could not resolve. It is a LEDGER surface, so a ledger-family scenario
  // is where a reader looks for it, and the family's other three each rule themselves
  // out by their own stated purpose: `ledger-quiet.ts` exists to hold the clean EMPTY
  // state, `ledger-first-sixty.ts` IS `DEFAULT_SCENARIO_ID` and no first-launch
  // demonstration should open onto a degradation, and `ledger-endurance.ts` is not in
  // the picker at all.
  //
  // It costs the committed captures nothing. The refusal needs a SECOND read — the
  // first submits no position — and a settled render performs one only on a focus, a
  // reconnect, or a named frame, none of which a screenshot pass raises. Reaching it
  // in the console is a person leaving the window and coming back.
  refusesSubmittedResumeCursor: true,
};
