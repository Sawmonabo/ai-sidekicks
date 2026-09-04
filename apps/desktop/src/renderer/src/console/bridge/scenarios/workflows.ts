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
// HOW THE WORKFLOW STATE REACHES A SURFACE
//
// Every read is a scripted reply. A served growth operation answers through
// `answerFromScriptedReply(engine, "<call>", …)`, which is the one seam
// `bridge/scripted-reply.ts` owns, so a workflow read gets the script, the frozen
// clock's loading window, and the two non-arrival refusals a real read has. The
// engine matches a reply on the call name alone, so there is one reply per call and a
// second for the same call is a wire-truth defect precisely because it could never be
// served.
//
// THE TWO SNAPSHOT READS ARE ANSWERED PER REQUEST, and that is what makes the four
// runs openable. One reply per call and a FIXED value in it meant `workflow.runRead`
// answered with the parked run whatever it was asked — held to that run by the port's
// own scope check, so the destination listed four runs as openable and three of them
// refused `workflow.not_found` against a list this same fixture had just served. The
// reply is a `resultFor` instead, which is the seam's own request-keyed shape: it
// picks the snapshot out of the very table the enumeration is built from, so a listed
// run and a read run are one object and cannot come apart. A run this fixture holds no
// snapshot for still refuses, through the one constructor the scope module owns.
//
// The two differ in what the corpus registers, and that difference is on the slate
// rather than in this file: the run READ is one of the thirteen registered workflow
// methods and rides `workflow-run-control`, while the run ENUMERATION is registered
// nowhere — every registered run operation addresses one run by an id the caller must
// already hold — and rides `workflow-run-enumeration`. Both are fixture-only, and the
// port refuses both under a live bridge.
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
import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
} from "./workflow-fixture-phase-outputs.js";
import { WORKFLOWS_PARKED_RUN, WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import { workflowSubjectNotFound } from "../fixture-workflow-scope.js";
import type { ConsoleScenario } from "../scenario.js";
import { readUnknownStringMember } from "../unknown-member.js";
import type {
  WorkflowDefinitionSummary,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
} from "../workflow-projection.js";

export const WORKFLOWS_SCENARIO_ID = "workflows";

/**
 * Which definition each scripted run was started from, by the version it is pinned to.
 *
 * The pairing lives HERE, on the reply, rather than on the run rows next door,
 * because it is a fact about what the ENUMERATION answers with: `workflow.runRead`
 * carries a run's pinned version and nothing about its definition, and no registered
 * read maps a version id back to a definition — so a daemon serving a run list joins
 * the two rows and a fixture has to do the same work.
 *
 * Keyed by version id rather than by run id or by position: three of the four runs
 * are pinned to their definition's own latest, so their key is the value the
 * definition table already publishes, and the fourth is the deliberately frozen pin —
 * version 1 of `Ship pipeline` — which is exactly the case no derivation can recover.
 * `runListEntries` refuses a run this table does not name, so a version id edited in
 * the data file next door fails the scenario's own test loudly instead of quietly
 * dropping a run's definition.
 */
const DEFINITION_NAME_BY_RUN_VERSION: Readonly<Record<string, string>> = {
  // `Release checks`, at its own latest — the working run.
  "019b7a10-0280-7d22-8100-be5100150004": "Release checks",
  // `Ship pipeline`, at its own latest — the parked run.
  "019b7a10-0280-7d22-8100-be5100150003": "Ship pipeline",
  // `Incident triage`, at its own latest — the cancelled run.
  "019b7a10-0280-7d22-8100-be5100150002": "Incident triage",
  // `Ship pipeline` version 1, whose definition has since moved to version 3 — the
  // frozen pin, and the only run whose definition no match against the definition
  // table's latest ids could find.
  "019b7a10-0280-7d22-8100-be5100150001": "Ship pipeline",
};

/**
 * The definition a run's name resolves to, most-specific-first as the daemon would.
 *
 * Two definitions share each of two names in this fixture, which is what makes the
 * browser's resolution mark say anything — so a name alone does not identify a row,
 * and the entry takes the one the enumeration marked as resolving here. That is the
 * definition a run started from this context would have been pinned to.
 */
function resolvedDefinitionNamed(name: string): WorkflowDefinitionSummary {
  const resolved = WORKFLOWS_SCENARIO_DEFINITIONS.find(
    (definition) => definition.name === name && definition.resolvesAtThisContext,
  );
  if (resolved === undefined) {
    throw new Error(`the workflows fixture names no resolving definition called ${name}`);
  }
  return resolved;
}

/**
 * The four runs as the ENUMERATION answers with them: each run's own row plus the
 * definition facts a list needs and a single-run read never carries.
 */
function runListEntries(): readonly WorkflowRunListEntry[] {
  return WORKFLOWS_SCENARIO_RUNS.map((run) => {
    const definitionName = DEFINITION_NAME_BY_RUN_VERSION[run.workflowVersionId];
    if (definitionName === undefined) {
      throw new Error(`the workflows fixture pairs no definition with run ${run.workflowRunId}`);
    }
    const definition = resolvedDefinitionNamed(definitionName);
    return {
      ...run,
      definitionName: definition.name,
      definitionLatestWorkflowVersionId: definition.latestWorkflowVersionId,
    };
  });
}

/**
 * The snapshot this scenario answers `workflow.runRead` with, for the run asked about.
 *
 * Read out of `WORKFLOWS_SCENARIO_RUNS`, which is the same table `runListEntries`
 * widens into the enumeration — so every run the destination lists is a run the pane
 * can open, and the snapshot it opens on IS the row that was listed rather than a
 * second copy that agrees today.
 *
 * The two absences are two facts. A call carrying no run at all is the growth port's
 * request-less probe, and `undefined` settles it exactly as an unscripted call settles
 * — the seam's own rule for a computed reply asked about nothing. A call naming a run
 * this fixture holds no snapshot for is a read the daemon would refuse, so it refuses,
 * with the code and sentence `fixture-workflow-scope.ts` owns for every workflow
 * subject a scenario cannot answer for.
 */
function runSnapshotFor(request: unknown): WorkflowRunSnapshot | undefined {
  const requestedRunId = readUnknownStringMember(request, "workflowRunId");
  if (requestedRunId === undefined) {
    return undefined;
  }
  const run = WORKFLOWS_SCENARIO_RUNS.find(
    (candidate) => candidate.workflowRunId === requestedRunId,
  );
  if (run === undefined) {
    throw workflowSubjectNotFound("run", requestedRunId);
  }
  return run;
}

/**
 * The outputs this scenario answers `workflow.phaseOutputRead` with, for both of the
 * identifiers that read is addressed by.
 *
 * Computed for the run read's reason and pinned rather than tabled: these outputs
 * belong to ONE finished phase of ONE run, so a read naming another run would report
 * that run as having produced them. It was the run read's fixed value that used to pin
 * this — the port held both reads to the one run that reply named — and a run read
 * answering four runs can no longer stand in for a pin only this reply knows.
 */
function phaseOutputsFor(request: unknown): unknown {
  const requestedRunId = readUnknownStringMember(request, "workflowRunId");
  const requestedPhaseId = readUnknownStringMember(request, "phaseId");
  if (requestedRunId === undefined || requestedPhaseId === undefined) {
    return undefined;
  }
  if (requestedRunId !== WORKFLOWS_PARKED_RUN.workflowRunId) {
    throw workflowSubjectNotFound("run", requestedRunId);
  }
  if (requestedPhaseId !== WORKFLOWS_COMPLETED_PHASE_ID) {
    throw workflowSubjectNotFound("phase", requestedPhaseId);
  }
  return {
    phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
    state: "completed",
    outputs: WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
  };
}

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
      call: "workflow.runList",
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
