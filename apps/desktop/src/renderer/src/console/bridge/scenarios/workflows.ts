// The workflows scenario — the session four workflow runs are running in.
//
// The story is the one the workflow surfaces were built to make readable: a run
// working, a run parked with the resume the engine actually armed, a run somebody
// cancelled, and a run pinned to a version its definition has moved past. Four runs
// rather than one, because every fact the run list derives — the park discriminator,
// the band order, the frozen-pin inequality, the attention fold — is a comparison
// ACROSS runs, and a fixture with one run exercises none of them.
//
// WHAT IS DECLARED HERE AND WHAT IS NOT
//
// This module is the scenario declaration: the roster, the beats, and the reply
// script. The records those replies are built out of are the `workflow-fixture-*.ts`
// modules beside it, and the three replies that are COMPUTED rather than tabled —
// the run-to-definition join, the request-keyed run read, and the phase-output read —
// are `workflow-fixture-replies.ts`, which carries the rules those reads obey.
//
// WHERE THE RUNS ARE, AND WHY THEY ARE NOT BEATS
//
// They are data in the `scenarios/workflow-fixture-*.ts` modules, not events on this
// stream, and that is a fact about the wire rather than a shortcut. The twenty-four
// workflow event types sit on `Plan-023 §Console growth slate` under
// `workflow-event-registration` and the corpus registers none of them, so a
// `workflow.phase_suspended` beat would be a type no daemon emits —
// `scenarios/wire-truth.ts` refuses it, and it would yield screenshots, geometry
// readings, and end-to-end results about a wire that does not exist.
//
// The beats below are therefore the SESSION the workflow runs in: the person, the two
// agents its phases dispatch to, and the ordinary agent run one running phase started.
// Every one is a registered type carrying its registered payload, which is the whole
// of what the event stream can honestly say about a workflow today.
//
// NO MUTATION IS SCRIPTED. Cancel, resume, gate resolve, and human-form submit each
// change state the fixture would then have to hold, and a scripted reply is a fixed
// answer rather than a state machine: scripting `workflow.runCancel` here would
// report a run cancelled while every read beside it kept answering `suspended`. A
// mutating call the port refuses says "nobody asked", which is true; a mutating call
// that answered would say the run changed, which would not be.
//
// THE SESSION IS CREATED BEFORE ANYTHING THE SESSION OWNS
//
// A daemon cannot project a run, or a `session`-scoped definition, that predates the
// session it belongs to — so the creation beat is the EARLIEST instant in this
// fixture and every session-owned record in the `scenarios/workflow-fixture-*.ts`
// modules follows it. The scenario used to open at 10:00 while its four runs started
// between 07:12 and 09:52 and its session-scoped definition was dated a fortnight
// earlier, which made every screenshot, projection, and ordering assertion above it a
// reading of a lifecycle no daemon could produce. The session moved to 07:00 rather
// than the runs moving after 10:00 because the runs' own spread is the content — the
// band order and the newest-first secondary key are read off it — and shifting the
// four of them would have restated that spread instead of preserving it. Every beat
// keeps its millisecond offset from the start, so the ordering the script claims
// among its own beats is untouched. `scenarios/workflows.chronology.test.ts` holds the
// rule.
//
// EVERY ID IS THE UUID THE WIRE DECLARES. `scenarios/wire-truth.ts` presents each beat
// to the strict contract layer as the whole envelope it claims to be, so a readable
// placeholder is a beat no daemon could emit and the architecture tier refuses it. The
// literals are fixed rather than generated for the same reason the flagship's are: a
// screenshot reference and a recorded end-to-end run both name the same session twice.

import {
  WORKFLOWS_PHASE_AGENT_ID,
  WORKFLOWS_PHASE_AGENT_RUN_ID,
  WORKFLOWS_SCENARIO_AGENTS,
} from "./workflow-fixture-agents.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import { WORKFLOWS_PARTICIPANT_YOU, WORKFLOWS_SESSION_ID } from "./workflow-fixture-ids.js";
import { phaseOutputsFor, runListEntries, runSnapshotFor } from "./workflow-fixture-replies.js";
import type { ConsoleScenario } from "../scenario.js";

export const WORKFLOWS_SCENARIO_ID = "workflows";

/**
 * The routing key this scenario's run enumeration is answered under.
 *
 * Keyed on the growth OPERATION rather than on a wire method, because this one read
 * has none: `growth-operations/workflows.ts` registers `workflowRunList` with no
 * `expectedWireMethod` under the note that an invented string there would be a wire
 * fact traceable to nothing, and writing one here instead would put the same
 * invention one file further from the ledger that refused it. The `growth:` prefix is
 * what makes the key manifestly not a method — so the day the daemon registers the
 * enumeration under whatever name it chooses, this reply is not already answering
 * under a different one.
 *
 * Named rather than written inline because the two suites that drive this reply have
 * to name the same key, and a scenario's own call names are the scenario's to declare.
 */
export const WORKFLOWS_RUN_ENUMERATION_CALL = "growth:workflowRunList";

/** The sequence the first `agent.attached` beat takes. One beat precedes it. */
const FIRST_AGENT_SEQUENCE = 2;

export const WORKFLOWS_SCENARIO: ConsoleScenario = {
  id: WORKFLOWS_SCENARIO_ID,
  label: "Workflow park",
  purpose:
    "A session running four workflows: one working, one parked with the resume the engine armed, one cancelled, and one pinned to a version its definition has moved past.",
  sessionId: WORKFLOWS_SESSION_ID,
  // Join order IS the hue order. One person and the two agents a phase-per-agent
  // workflow attaches, in the order a real run would attach them.
  participantIdsInJoinOrder: [
    WORKFLOWS_PARTICIPANT_YOU,
    ...WORKFLOWS_SCENARIO_AGENTS.map((agent) => agent.agentId),
  ],
  // Which of the three this window is. Stated rather than inferred from the head of
  // the join order — that entry is whoever opened the session, on whichever machine.
  // Absent, the caller-identity read refuses and every operator control on a parked
  // run reads as unchecked rather than as adjudicated.
  viewingParticipantId: WORKFLOWS_PARTICIPANT_YOU,
  // And their role, which is what makes this scenario able to drive a role-gated
  // control at all: the identity read answers the viewer, and the role a run pane's
  // operator controls gate on is this entry, looked up in the roster the session read
  // establishes. Owner, because the story this fixture tells is a person adjudicating
  // their own session's parked run.
  membershipRoleByParticipantId: { [WORKFLOWS_PARTICIPANT_YOU]: "owner" },
  startedAtIso: "2026-01-01T07:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7a10-0280-7ea1-8110-e5e0d1150001",
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T07:00:00.000Z",
        actorId: WORKFLOWS_PARTICIPANT_YOU,
        // The registered shape, verbatim: the new session's id plus the resolved
        // config and metadata, both open records the corpus names no key inside. The
        // workflow's title is not on this wire; a fixture that put one here would be
        // teaching a surface to read a member no daemon sets.
        payload: { sessionId: WORKFLOWS_SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...WORKFLOWS_SCENARIO_AGENTS.map((agent, agentIndex) => ({
      atMs: agent.attachedAtMs,
      event: {
        id: agent.eventId,
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: FIRST_AGENT_SEQUENCE + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. An agent does not attach
        // itself, and the envelope actor is who acted.
        actorId: WORKFLOWS_PARTICIPANT_YOU,
        // The full persona plus the daemon-resolved resulting state, so the `agents`
        // projection rebuilds from the log alone. `name` is the member — `displayName`
        // is not on this wire.
        payload: {
          sessionId: WORKFLOWS_SESSION_ID,
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          state: "ready",
          actor: WORKFLOWS_PARTICIPANT_YOU,
        },
      },
    })),
    // The ordinary agent run one running phase dispatched. Three registered
    // run-lifecycle beats and no workflow beat: a `single-agent` phase starts a run,
    // and the run's transitions are types the census actually carries.
    {
      atMs: 240,
      event: {
        id: "019b7a10-0280-7ea1-8110-e5e0d1150004",
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: 4,
        kind: "run.queued",
        occurredAt: "2026-01-01T07:00:00.240Z",
        actorId: WORKFLOWS_PARTICIPANT_YOU,
        // A run-lifecycle payload is a STATE TRANSITION carrying the progression
        // counter. `previousState` is absent here and only here: a queued run is being
        // born, and no document names a value for the state it came from.
        payload: {
          sessionId: WORKFLOWS_SESSION_ID,
          runId: WORKFLOWS_PHASE_AGENT_RUN_ID,
          runVersion: 1,
          newState: "queued",
          agentId: WORKFLOWS_PHASE_AGENT_ID,
        },
      },
    },
    {
      atMs: 320,
      event: {
        id: "019b7a10-0280-7ea1-8110-e5e0d1150005",
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: 5,
        kind: "run.starting",
        occurredAt: "2026-01-01T07:00:00.320Z",
        // No actor. The daemon moves a run out of `queued`; a participant id here
        // would attribute a system transition to a person.
        payload: {
          sessionId: WORKFLOWS_SESSION_ID,
          runId: WORKFLOWS_PHASE_AGENT_RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 420,
      event: {
        id: "019b7a10-0280-7ea1-8110-e5e0d1150006",
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: 6,
        kind: "run.running",
        occurredAt: "2026-01-01T07:00:00.420Z",
        payload: {
          sessionId: WORKFLOWS_SESSION_ID,
          runId: WORKFLOWS_PHASE_AGENT_RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
        },
      },
    },
  ],
  replies: [
    {
      // `session.read`, not a `session.list`: the registry carries no list method, and
      // a fixture answering one would put a call in front of a surface that has
      // nowhere to send it.
      call: "session.read",
      result: {
        session: {
          id: WORKFLOWS_SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: "2026-01-01T07:00:00.000Z",
          updatedAt: "2026-01-01T07:00:00.420Z",
        },
        timelineCursors: { latest: "workflows-cursor-6" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: WORKFLOWS_SCENARIO_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          // `AgentState` is the four-state lifecycle. A run being in flight is a RUN
          // state, read from the run and never folded into the agent row.
          state: "ready",
          createdAt: agent.attachedAtIso,
        })),
      },
    },
    {
      call: "workflow.definitionList",
      // No `nextCursor`. The enumeration is cursor-paged on the wire, and a cursor
      // pointing at a second page would be a promise this fixture cannot keep: the
      // engine matches a reply on the call name alone, so there is exactly one page to
      // serve, and claiming otherwise would drive the browser into a fetch that
      // answers with this same page forever.
      result: { definitions: WORKFLOWS_SCENARIO_DEFINITIONS },
    },
    {
      // All four runs, in the table's own order. The list's ordering is the
      // projection's — parked first, then active, then settled, newest first inside
      // each — so a reply that pre-sorted them would be scripting a fold the console
      // performs, and a projection bug would be invisible behind fixture data that
      // had already done the work.
      call: WORKFLOWS_RUN_ENUMERATION_CALL,
      result: { runs: runListEntries() },
    },
    {
      // Answered per requested run, out of the same table the enumeration above is
      // built from — so opening any of the four runs the destination lists reads that
      // run's own phases, parks and start, and a run this fixture does not hold
      // refuses rather than being answered with somebody else's snapshot.
      call: "workflow.runRead",
      resultFor: runSnapshotFor,
    },
    {
      // The finished phase of the parked run. A phase output is addressable once the
      // phase completes and stays addressable on a failed or cancelled run, which is
      // why this answers for the completed phase rather than a parked one — and why
      // it is pinned to the one run whose work these outputs are.
      call: "workflow.phaseOutputRead",
      resultFor: phaseOutputsFor,
    },
  ],
};
