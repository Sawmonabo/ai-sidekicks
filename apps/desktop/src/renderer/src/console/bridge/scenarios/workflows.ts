// The workflows scenario — the session four workflow runs are running in.
//
// The story is the one the workflow surfaces were built to make readable: a run
// working, a run parked with the resume the engine actually armed, a run somebody
// cancelled, and a run pinned to a version its definition has moved past. Four runs
// rather than one, because every fact the run list derives — the park discriminator,
// the band order, the frozen-pin inequality, the attention fold — is a comparison
// ACROSS runs, and a fixture with one run exercises none of them.
//
// WHERE THE RUNS ARE, AND WHY THEY ARE NOT BEATS
//
// They are data in `scenarios/workflow-fixture-data.ts`, not events on this stream,
// and that is a fact about the wire rather than a shortcut. The twenty-four workflow
// event types sit on `Plan-023 §Console growth slate` under
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
// HOW THE WORKFLOW STATE REACHES A SURFACE
//
// Two seams, because the wire has two different amounts of answer:
//
//   • The three READS are scripted replies. A served growth operation answers through
//     `answerFromScriptedReply(engine, "<call>", …)`, which is the one seam
//     `bridge/scripted-reply.ts` owns, so a workflow read gets the script, the frozen
//     clock's loading window, and the two non-arrival refusals a real read has.
//     `workflow.runRead` addresses ONE run by an id the caller already holds, so it
//     answers with the parked run — the run a run pane opens. One reply, one run: the
//     engine matches a reply on the call name alone, and a second reply for the same
//     call is a wire-truth defect precisely because it could never be served.
//   • The run LIST has no wire at all. The registered workflow registry carries
//     thirteen methods and none of them enumerates runs, so the set is stated as
//     fixture data and reaches the list from its caller — which is exactly how
//     `workflows/RunList.tsx` says its snapshots arrive.
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
// fixture and every session-owned record in `scenarios/workflow-fixture-data.ts`
// follows it. The scenario used to open at 10:00 while its four runs started between
// 07:12 and 09:52 and its session-scoped definition was dated a fortnight earlier,
// which made every screenshot, projection, and ordering assertion above it a reading
// of a lifecycle no daemon could produce. The session moved to 07:00 rather than the
// runs moving after 10:00 because the runs' own spread is the content — the band
// order and the newest-first secondary key are read off it — and shifting the four
// of them would have restated that spread instead of preserving it. Every beat keeps
// its millisecond offset from the start, so the ordering the script claims among its
// own beats is untouched. `scenarios/workflows.test.ts` holds the rule.
//
// EVERY ID IS THE UUID THE WIRE DECLARES. `scenarios/wire-truth.ts` presents each beat
// to the strict contract layer as the whole envelope it claims to be, so a readable
// placeholder is a beat no daemon could emit and the architecture tier refuses it. The
// literals are fixed rather than generated for the same reason the flagship's are: a
// screenshot reference and a recorded end-to-end run both name the same session twice.

import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_PARKED_RUN,
  WORKFLOWS_PARTICIPANT_YOU,
  WORKFLOWS_PHASE_AGENT_ID,
  WORKFLOWS_PHASE_AGENT_RUN_ID,
  WORKFLOWS_SCENARIO_AGENTS,
  WORKFLOWS_SCENARIO_DEFINITIONS,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
  WORKFLOWS_SESSION_ID,
} from "./workflow-fixture-data.js";
import type { ConsoleScenario } from "../scenario.js";

export const WORKFLOWS_SCENARIO_ID = "workflows";

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
  startedAtIso: "2026-01-01T07:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T07:00:00.000Z",
        actorParticipantId: WORKFLOWS_PARTICIPANT_YOU,
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
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: FIRST_AGENT_SEQUENCE + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. An agent does not attach
        // itself, and the envelope actor is who acted.
        actorParticipantId: WORKFLOWS_PARTICIPANT_YOU,
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
        sessionId: WORKFLOWS_SESSION_ID,
        sequence: 4,
        kind: "run.queued",
        occurredAt: "2026-01-01T07:00:00.240Z",
        actorParticipantId: WORKFLOWS_PARTICIPANT_YOU,
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
      call: "workflow.runRead",
      result: WORKFLOWS_PARKED_RUN,
    },
    {
      // The finished phase of that same run. A phase output is addressable once the
      // phase completes and stays addressable on a failed or cancelled run, which is
      // why this answers for the completed phase rather than a parked one.
      call: "workflow.phaseOutputRead",
      result: {
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
        state: "completed",
        outputs: WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
      },
    },
  ],
};
