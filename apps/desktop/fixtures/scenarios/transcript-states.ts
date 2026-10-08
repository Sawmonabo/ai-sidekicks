// The transcript-states scenario: three lanes ending in three different conditions.
//
// The session the transcript frame, the run groups and the seams are measured against. The
// three endings a reader must tell apart in one frame:
//
//   - The implementer's run runs, blocks on an approval, unblocks, is rewound past a boundary,
//     re-executes and finishes, so its run group is terminal and folds to a one-line
//     past-tense receipt with superseded turns inside it.
//   - The reviewer's run runs, fails a tool call and is paused, so its run group carries the
//     pause system message and stays parked at the pinned frame.
//   - The architect's run is still live at the last beat, mid-turn, so the frame always has
//     something streaming.
//
// A single-lane script cannot show several of these true at once in different hues. The
// empty session is the one composition no script reaches, and it lives in `empty-session.ts`.
//
// Every beat is a registered event with its registered payload.
// `tests/helpers/scenario/contract-check/all-axes.ts` holds the beats to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`) in
// `packages/contracts/src/event/session.ts`, and `fixtures/data/script-entries.ts` carries
// the payload builders so a member cannot drift between two beats of one kind.
//
// Deliberately not scripted:
//
//   - An approval card. The run reaches `waiting_for_approval` and returns to `running`, the
//     part of that story the log tells; the card belongs to the approvals view.
//   - A cost or token reading. No meter is on the transcript frame, the run groups or the
//     seams; `concurrent-streaming.ts` moves the meter.
//   - A machine body. `assistant.*` and `tool.*` payloads describe their body and never carry
//     it; the body is stored in `content_payload`.

import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";

import {
  composeScenarioInstant,
  composeScriptBeats,
  createRunEntryBuilders,
  findBeatCursor,
  newestBeatInstant,
  type ScriptEntry,
} from "../data/script-entries.js";
import type { Scenario } from "../scenario.js";
import {
  type ScenarioAgent,
  composeOpeningEntry,
  composeResolvedAgent,
  findScenarioMember,
} from "../data/opening-entries.js";

// The cast and its clock: every identifier in one place. Ids are UUID v7 values whose leading
// bytes are this scenario's start instant.

/** The scenario's session id. */
export const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/**
 * The stem this scenario's row ids are minted from. It differs from `SESSION_ID` on purpose,
 * so a row id cannot be rebuilt from the session and the sequence.
 */
export const EVENT_ID_STEM = "019b793b-7b60-7ea1-8110-e5e0d115";
const USER_YOU = "019b793b-7b60-79a4-8110-cca0117a0410";
const AGENT_ARCHITECT = "019b793b-7b60-7a6e-8110-d1a4c1150101";
const AGENT_IMPLEMENTER = "019b793b-7b60-7a6e-8120-d1a4c1150102";
const AGENT_REVIEWER = "019b793b-7b60-7a6e-8130-d1a4c1150103";
/** The implementer's run, the lane that finishes behind a rewind boundary. */
export const RUN_IMPLEMENTER = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_REVIEWER = "019b793b-7b60-740e-8120-d1a4c1150112";
const RUN_ARCHITECT = "019b793b-7b60-740e-8130-d1a4c1150113";

/**
 * The child run the architect's turn opens, the only run here with a parent. It is not a
 * fourth lane: the transcript summarizes it onto the row naming it and its parent.
 */
export const RUN_ARCHITECT_CHILD = "019b793b-7b60-740e-8140-d1a4c1150114";

/**
 * The provider-native subagent the reviewer's run opens, in the provider's own shape. It is
 * not a UUID and is unique only within that provider's run scope, so the app keys a
 * subagent by `(runId, provider, subagentId)`.
 */
export const SUBAGENT_REVIEWER = "sub_01k9wq4m2h";

/**
 * The base instant in epoch milliseconds, built with `Date.UTC` rather than by parsing a
 * string (`Date.parse` reads a timezone-less stamp in the host's zone), so the ISO spelling
 * below cannot disagree.
 */
export const startedAtMs: number = Date.UTC(2026, 0, 1, 11, 5);

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

// The three lanes, as the `agents` projection carries them. Drivers are mixed so a view sees a
// two-provider session.
const TRANSCRIPT_STATES_AGENTS: readonly ScenarioAgent[] = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5-5",
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    definitionId: "019b793b-7b60-7de1-8120-d1a4c1150122",
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    definitionId: "019b793b-7b60-7de1-8130-d1a4c1150123",
  },
];

// What the three lanes do, beat by beat. The script also plays a child run under the architect
// and a provider-native subagent under the reviewer, which the transcript folds into a lane
// rather than drawing beside one.

// The rewind anchor the implementer's run landed at. The boundary beat declares it and the
// superseded turns are every row of that run and epoch past it, so both read one value.
const IMPLEMENTER_REWIND_TARGET_POSITION = 4;

// The tool call the reviewer's subagent opens under, read by the invocation, its settlement and
// both halves of the subagent pair.
const REVIEWER_TOOL_CALL_ID = "call-reviewer-1";

// The reviewer's provider, read off the cast: a subagent is keyed by
// `(runId, provider, subagentId)`, so it must match the reviewer's own runs.
const REVIEWER_PROVIDER = findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_REVIEWER).driverName;

const lane = createRunEntryBuilders(SESSION_ID);

const TRANSCRIPT_STATES_SCRIPT: readonly ScriptEntry[] = [
  composeOpeningEntry({
    sessionId: SESSION_ID,
    shape: "project",
    openedBy: USER_YOU,
    lead: findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_ARCHITECT),
    createdAt: STARTED_AT_ISO,
  }),
  {
    atMs: 280,
    kind: "user.message",
    // The payload's actor repeats the envelope's.
    actorId: USER_YOU,
    payload: {
      sessionId: SESSION_ID,
      actor: USER_YOU,
      message: "Split the session store and keep each lane's run moving.",
    },
  },

  // Lane one — the implementer. Born, blocked, unblocked, rewound, finished.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 320,
    runVersion: 1,
    newState: "queued",
    resolvedAgent: composeResolvedAgent({
      agent: findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_IMPLEMENTER),
      lead: findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_ARCHITECT),
      resolvedAt: composeScenarioInstant(startedAtMs, 320),
    }),
    actorId: USER_YOU,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 400,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 480,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 520,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 412,
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 640,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_284,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 760,
    kind: "tool.invoked",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 900,
    kind: "tool.result",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
    durationMs: 140,
    contentLength: 96,
  }),

  // Lane two — the reviewer.
  lane.transition(RUN_REVIEWER, {
    atMs: 960,
    runVersion: 1,
    newState: "queued",
    resolvedAgent: composeResolvedAgent({
      agent: findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_REVIEWER),
      lead: findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_ARCHITECT),
      resolvedAt: composeScenarioInstant(startedAtMs, 960),
    }),
    actorId: USER_YOU,
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 1_040,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 1_120,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_REVIEWER, {
    atMs: 1_180,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 806,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_240,
    kind: "tool.invoked",
    toolName: "run_tests",
    toolCallId: REVIEWER_TOOL_CALL_ID,
  }),

  // The handoff, observed twice: a subagent opens under the reviewer's tool call and finishes
  // inside it, both beats carrying the same identity. The transcript anchors a subagent at the
  // first row naming it and draws one handoff there; the completion draws nothing of its own,
  // so one beat could not show that.
  lane.subagent(RUN_REVIEWER, {
    atMs: 1_300,
    kind: "subagent.started",
    provider: REVIEWER_PROVIDER,
    subagentId: SUBAGENT_REVIEWER,
    parentToolCallId: REVIEWER_TOOL_CALL_ID,
  }),
  lane.subagent(RUN_REVIEWER, {
    atMs: 1_380,
    kind: "subagent.completed",
    provider: REVIEWER_PROVIDER,
    subagentId: SUBAGENT_REVIEWER,
    parentToolCallId: REVIEWER_TOOL_CALL_ID,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_420,
    kind: "tool.error",
    toolName: "run_tests",
    toolCallId: REVIEWER_TOOL_CALL_ID,
    durationMs: 180,
    contentLength: 244,
  }),

  // A wait for approval and its return: the run enters `waiting_for_approval` and
  // comes back through `run.running`, which is the transition the daemon emits.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_620,
    runVersion: 4,
    previousState: "running",
    newState: "waiting_for_approval",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_960,
    runVersion: 5,
    previousState: "waiting_for_approval",
    newState: "running",
  }),
  {
    atMs: 2_100,
    kind: "usage.context_compacted",
    // The compaction seam. `usage.context_compacted` has no strict payload variant in
    // `packages/contracts`, so the beat carries only the two members every run-scoped payload
    // has, and the seam's boundary position is not here.
    payload: { sessionId: SESSION_ID, runId: RUN_IMPLEMENTER },
  },
  // The pause seam; the lane stays parked at the last beat.
  lane.transition(RUN_REVIEWER, {
    atMs: 2_200,
    runVersion: 4,
    previousState: "running",
    newState: "paused",
    actorId: USER_YOU,
  }),

  // Lane three — the architect, which is still mid-turn when the script ends.
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_320,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ARCHITECT,
    actorId: USER_YOU,
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_400,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_480,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 2_540,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 318,
  }),

  // The child run is born here and nowhere else: this is the only beat naming both it and its
  // parent, and the transcript summarizes the child onto the row carrying it.
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_560,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ARCHITECT,
    parentRunId: RUN_ARCHITECT,
  }),

  {
    atMs: 2_600,
    kind: "run.rolled_back",
    // `RunRolledBackEvent`'s members (`packages/contracts/src/run/control.ts`): the
    // post-rollback progression value and the turn boundary the run landed at, which the
    // superseded turns above it are measured against.
    actorId: USER_YOU,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      runVersion: 6,
      targetPosition: IMPLEMENTER_REWIND_TARGET_POSITION,
    },
  },
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_620,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_660,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 2_700,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_012,
  }),
  lane.output(RUN_ARCHITECT_CHILD, {
    atMs: 2_740,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 284,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 2_820,
    kind: "tool.invoked",
    toolName: "read_file",
    toolCallId: "call-implementer-2",
  }),
  {
    atMs: 2_860,
    // The compaction inside the child folds the provider's context, not the session's log, so
    // the child's summary stays whole across it.
    kind: "usage.context_compacted",
    payload: { sessionId: SESSION_ID, runId: RUN_ARCHITECT_CHILD },
  },
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 2_900,
    kind: "tool.result",
    toolName: "read_file",
    toolCallId: "call-implementer-2",
    durationMs: 62,
    contentLength: 2_048,
  }),
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_940,
    runVersion: 4,
    previousState: "running",
    newState: "completed",
    completionKind: "turn",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 2_980,
    runVersion: 7,
    previousState: "running",
    newState: "completed",
    completionKind: "turn",
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 3_060,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_640,
  }),

  // The open question is the last beat: an agent blocked on a question needs an answer from a
  // person, so the session ends on the composition the question card is measured against.
  {
    atMs: 3_140,
    kind: "question.asked",
    actorId: AGENT_ARCHITECT,
    payload: {
      questionId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e11",
      sessionId: SESSION_ID,
      runId: RUN_ARCHITECT,
      isAgentWaiting: true,
      questions: [
        {
          text: "Keep the old session store behind a flag while the lanes move over?",
          options: [{ label: "Keep it" }, { label: "Remove it" }],
          severalAnswers: false,
          secret: false,
        },
      ],
    },
  },
];

const TRANSCRIPT_STATES_BEATS = composeScriptBeats({
  sessionId: SESSION_ID,
  eventIdStem: EVENT_ID_STEM,
  startedAtMs,
  entries: TRANSCRIPT_STATES_SCRIPT,
});

/** The acknowledged log position: the implementer's answer after its rewind. */
const ACKNOWLEDGED_LOG_POSITION = 29;

/** The id of the transcript-states scenario. */
export const TRANSCRIPT_STATES_SCENARIO_ID = "transcript-states";

/** Three runs ending in three conditions at once: finished behind a rewind, parked, streaming. */
export const TRANSCRIPT_STATES_SCENARIO: Scenario = {
  id: TRANSCRIPT_STATES_SCENARIO_ID,
  label: "Three lanes",
  purpose:
    "A session whose three runs end in three different conditions at once — " +
    "one finished behind a rewind boundary, one parked, one still streaming " +
    "— so the run groups and the seams all have something to render.",
  sessionId: SESSION_ID,
  startedAtIso: STARTED_AT_ISO,
  beats: TRANSCRIPT_STATES_BEATS,
  replies: [
    // The run-scoped reasoning read, on its `available` arm with a bounded page. The empty arms
    // need no scripted entries (a run this reply does not name gets the fixture's refusal),
    // while the entries are what no beat in this session produces.
    {
      call: "transcript.reasoningSurfaceRead",
      result: {
        availability: "available",
        hasMore: false,
        reasoningEntries: [
          {
            sequence: 12,
            content: "The two storage backends differ in who owns the row, not in what it holds.",
            timestamp: composeScenarioInstant(startedAtMs, 2_500),
          },
          {
            sequence: 13,
            content: "An answer kept on this machine is reversible; a hosted answer is not.",
            timestamp: composeScenarioInstant(startedAtMs, 2_520),
          },
        ],
      },
    },
    {
      // The frame's read is `session.read`; nothing in the renderer calls `session.list`.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          shape: "project",
          muted: false,
          createdAt: STARTED_AT_ISO,
          updatedAt: newestBeatInstant(TRANSCRIPT_STATES_BEATS),
          draft: "",
          tags: [],
        },
        // An acknowledged position beside `latest` makes the resume cycle reachable: the store
        // submits the acknowledged position on its next read. It sits behind `latest`, the newest
        // row, as a real one does.
        transcriptCursors: {
          earliest: encodeEventCursor(START_OF_LOG_POSITION),
          latest: findBeatCursor(TRANSCRIPT_STATES_BEATS, TRANSCRIPT_STATES_BEATS.length - 1),
          acknowledged: findBeatCursor(TRANSCRIPT_STATES_BEATS, ACKNOWLEDGED_LOG_POSITION),
        },
      },
    },
  ],
};
