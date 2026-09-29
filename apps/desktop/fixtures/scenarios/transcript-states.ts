// The transcript-states scenario: three lanes ending in three different conditions.
//
// The session the ledger frame, the run groups, and the seams are all measured
// against. Each lane ends somewhere different, and the three
// endings are exactly the ones a reader has to be able to tell apart in one frame:
//
//   • The implementer's run runs, blocks on an approval, unblocks, is rewound past
//     a boundary, re-executes, and finishes — so its run group is TERMINAL and folds
//     to a one-line past-tense receipt, with a superseded band inside it.
//   • The reviewer's run runs, fails a tool call, and is PAUSED — so its run group
//     carries the pause seam and stays parked at the frozen tick.
//   • The architect's run is still LIVE at the last beat, mid-turn, so the frame
//     always has something streaming in it.
//
// A single-lane script would have rendered every one of those states too, one after
// another — and would have proved nothing about the thing this console exists for,
// which is several of them being true at once in different hues. The session's own
// EMPTY state is the one composition no script reaches, and it lives next door in
// `empty-session.ts` for that reason.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, under the two-leg
// rule `tests/helpers/scenario-contract-check/contract-check.ts` states: the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`), both in
// `packages/contracts/src/event.ts`, are the code leg, and the per-type payload rows of
// the session event taxonomy name the members of a registered type whose strict variant
// has not landed yet. That predicate holds this file to the code leg, and
// `fixtures/data/script-entries.ts` carries the payload builders so a
// member cannot drift between two beats of one kind.
//
// FOUR THINGS THE DESIGN ASKS FOR THAT THIS SCRIPT DELIBERATELY DOES NOT SAY
//
//   • **The provider-switch seam.** The event census does not register
//     `agent.provider_binding_changed` or `agent.provider_binding_change_failed` yet,
//     so a beat playing one would be a frame about a wire that does not exist.
//   • **An approval card.** `approval.requested` is a registered type, but the card it
//     would draw belongs to the surface that renders approvals — so the run reaches
//     `waiting_for_approval` and returns to `running`, which is the part of that story
//     the log can tell.
//   • **A cost or token reading.** Not because the members are unnamed — the taxonomy
//     leg names them, and `concurrent-streaming.ts` meters a cost against exactly that row
//     — but because this session's subject is the transcript frame, the run groups and the
//     seams, and the meter is not on any of them. Concurrent streaming is
//     the scenario that moves the meter; a second one here would be a reading no surface
//     in this session's frame reads. Scripting one would carry every member
//     the usage-telemetry family makes required of a post-amendment
//     emitter — `costStatus`, `costSource`, and `effectivePrincipal` — exactly as
//     that scenario's own builder does.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.

import {
  composeScriptBeats,
  createRunEntryBuilders,
  type ScriptEntry,
} from "../data/script-entries.js";
import type { Scenario } from "../scenario.js";
import {
  type ScenarioAgent,
  composeAttachedInstant,
  composeOpeningEntries,
  findScenarioMember,
} from "../data/opening-entries.js";

// The cast and its clock: every identifier in one place.

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// rendered identifier tells one fixture apart from another at a glance — and so an
// id is as wide on screen as a real one, which a readable name never is.
export const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's.
 *
 * `composeScriptBeats` completes it with the beat's position. Distinct from
 * `SESSION_ID` on purpose: an event id a caller could rebuild out of the session and
 * the sequence would let a projection that stopped carrying the real one keep
 * answering.
 */
export const EVENT_ID_STEM = "019b793b-7b60-7ea1-8110-e5e0d115";
const USER_YOU = "019b793b-7b60-79a4-8110-cca0117a0410";
const AGENT_ARCHITECT = "019b793b-7b60-7a6e-8110-d1a4c1150101";
const AGENT_IMPLEMENTER = "019b793b-7b60-7a6e-8120-d1a4c1150102";
const AGENT_REVIEWER = "019b793b-7b60-7a6e-8130-d1a4c1150103";
export const RUN_IMPLEMENTER = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_REVIEWER = "019b793b-7b60-740e-8120-d1a4c1150112";
const RUN_ARCHITECT = "019b793b-7b60-740e-8130-d1a4c1150113";

/**
 * The child run the architect's turn opens, and the only run here with a parent.
 *
 * A CHILD RUN IS NOT A FOURTH LANE. The ledger summarizes it onto the one row that
 * names both it and its parent rather than drawing a lane of its own, which is why
 * this id is stated beside the three above and is deliberately not one of them: the
 * three are the compositions a reader has to tell apart in one frame, and this is
 * the background work folded into one of them.
 */
export const RUN_ARCHITECT_CHILD = "019b793b-7b60-740e-8140-d1a4c1150114";

/**
 * The provider-native subagent the reviewer's run opens, as its provider names it.
 *
 * NOT A UUID, and that is the fact it carries: the identifier is minted by the
 * provider and is unique only inside that provider's run scope, which is why the
 * console keys a subagent by the whole `(runId, provider, subagentId)` triple and
 * never by this string alone. Written in the provider's own shape so a fixture
 * cannot teach a surface to expect a session-wide identifier here.
 */
export const SUBAGENT_REVIEWER = "sub_01k9wq4m2h";

/**
 * The base instant, minted from its fields rather than read back out of a string.
 *
 * `Date.parse` is not a validator — it reads a timezone-less stamp in the host's
 * zone and normalizes a day that does not exist — so a fixture that derived its
 * milliseconds by parsing its own literal was asking a reader to trust the one
 * function the console bans. `Date.UTC` states the instant, and the ISO spelling
 * every reply carries is derived from it, so the two can never disagree. The name
 * ends `Ms` because that is what it holds — a number, not a stamp behind a name.
 */
export const startedAtMs: number = Date.UTC(2026, 0, 1, 11, 5);

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/**
 * The three lanes, as the `agents` projection carries them.
 *
 * One table rather than a literal per beat, so two hand-written copies of one agent
 * cannot drift in the direction nothing catches. The drivers are mixed on purpose — a
 * fixture whose whole cast runs one provider cannot show a surface what a two-provider
 * session looks like.
 */
const TRANSCRIPT_STATES_AGENTS: readonly ScenarioAgent[] = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 120,
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 160,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 200,
  },
];

// What the three lanes do, beat by beat.
//
// THREE LANES AND TWO THINGS THAT ARE NOT LANES. This script also plays a CHILD RUN
// under the architect and a provider-native SUBAGENT under the reviewer — the two
// shapes the transcript folds INTO a lane rather than drawing beside one, so the
// child-run summary and the handoff row are reachable from a session the fixture plays.

/**
 * The rewind anchor the implementer's run landed at.
 *
 * Named once because two things read it and they must agree: the boundary beat
 * declares it, and the superseded band the ledger draws is every row of that run
 * and epoch whose position EXCEEDS it. A second literal would let the band and the
 * boundary disagree about which turns are past.
 */
const IMPLEMENTER_REWIND_TARGET_POSITION = 4;

/**
 * The tool call the reviewer's subagent was opened under.
 *
 * Named once because four beats read it and they must agree: the invocation, its
 * settlement, and the `parentToolCallId` on each half of the subagent pair. A child
 * hung from a call nothing else in the log holds is a parent that never happened.
 */
const REVIEWER_TOOL_CALL_ID = "call-reviewer-1";

/**
 * The provider the reviewer's lane runs on, read off the cast rather than restated.
 *
 * A subagent is keyed by `(runId, provider, subagentId)`, so this has to be the same
 * string the reviewer's own attach beat carries — and the cast is where it is stated.
 */
const REVIEWER_PROVIDER = findScenarioMember(TRANSCRIPT_STATES_AGENTS, AGENT_REVIEWER).driverName;

/** The four entry builders, with this scenario's session bound in. */
const lane = createRunEntryBuilders(SESSION_ID);

const TRANSCRIPT_STATES_SCRIPT: readonly ScriptEntry[] = [
  ...composeOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: USER_YOU,
    cast: TRANSCRIPT_STATES_AGENTS,
  }),
  {
    atMs: 280,
    kind: "user.message",
    // The author is the envelope's actor and the text is not here: user
    // prose is sealed per user in `pii_payload`, and a fixture that put the
    // words on the payload would teach a row to read a member no daemon sets.
    actorId: USER_YOU,
    payload: { sessionId: SESSION_ID },
  },

  // Lane one — the implementer. Born, blocked, unblocked, rewound, finished.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 320,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
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
    agentId: AGENT_REVIEWER,
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

  // THE HANDOFF, OBSERVED TWICE. A provider-native subagent opens under the reviewer's
  // tool call and finishes inside it, both beats carrying the SAME identity — which is
  // why both are here. The ledger anchors a subagent at the first row naming it and
  // draws one handoff there; the completion joins that anchor and draws nothing of its
  // own, so one beat of the pair could never show the second was suppressed.
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
    // The compaction seam. The boundary POSITION the seam renders in mono is not
    // here: `usage.context_compacted` registers no payload variant and no member
    // of one is named anywhere in `packages/contracts`, so the two members every
    // run-scoped payload in the corpus carries are all this beat can honestly say.
    payload: { sessionId: SESSION_ID, runId: RUN_IMPLEMENTER },
  },
  // The pause seam, and the lane that is still parked at the last beat.
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

  // THE CHILD RUN, BORN HERE AND NOWHERE ELSE. The architect's turn opens a run of its
  // own, and this beat is the only one in the session naming both it and its parent —
  // the taxonomy puts the orchestration linkage on the birth beat, and the ledger
  // summarizes the child onto exactly the row carrying it. Everything else the summary
  // states is derived from the rows below.
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
    // `RunRolledBackEvent`'s own members (`packages/contracts/src/run-control.ts`):
    // the POST-rollback progression value, and the turn boundary the run landed
    // at — which is not the boundary row's own position, and is what the
    // superseded band above it is measured against.
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
    // THE COMPACTION INSIDE THE CHILD, which makes its summary a FLOOR rather than a
    // total: rows before this one left the child's own transcript, so the count the
    // summary carries is a lower bound over a history that lost entries — the one
    // incompleteness cause a log can state on its own. The implementer's lane carries
    // the session's other compaction seam and says nothing about a child, which is
    // how a reader sees the marker is scoped to the run it landed in.
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
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 2_980,
    runVersion: 7,
    previousState: "running",
    newState: "completed",
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 3_060,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_640,
  }),

  // THE OPEN ASK, and the reason it is the script's last beat. The architect lane's
  // whole job is to leave something unfinished in the frame, and a provider blocked
  // on a structured question is the one unfinished state that needs an answer FROM A
  // PERSON rather than from the daemon — so a session ending here is the composition
  // the input-ask card is measured against.
  //
  // EVERY MEMBER THE TAXONOMY MAKES REQUIRED OF A POST-AMENDMENT `requested` EMITTER
  // IS HERE: the session, the run, the ask's own id, the kind, the state — which the
  // taxonomy requires to equal the emitting type's suffix — and the stamped expiry,
  // which `requested` alone must carry. `input` is deliberately absent: the taxonomy
  // requires it on the PERMISSION arm, and this ask is an input one. `options` is the
  // additive-optional choice set, present so the card's structured arm is reachable
  // in the fixture; its free-text arm is unconditional and needs no beat to exist.
  {
    atMs: 3_140,
    kind: "driver_ask.requested",
    actorId: AGENT_ARCHITECT,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ARCHITECT,
      askId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e11",
      kind: "input",
      state: "requested",
      prompt: "Which storage backend should the draft assume?",
      options: [
        { value: "sqlite", label: "The node-local SQLite database" },
        { value: "postgres", label: "The control plane's Postgres" },
      ],
      // Ten minutes past the beat, stamped by the daemon at creation and never
      // extended. Derived from the scenario's own base instant rather than written
      // as a literal, so the countdown and the beat can never disagree about when
      // the ask was raised.
      expiresAt: composeAttachedInstant(startedAtMs, 3_140 + 600_000),
    },
  },
];

export const TRANSCRIPT_STATES_SCENARIO_ID = "transcript-states";

export const TRANSCRIPT_STATES_SCENARIO: Scenario = {
  id: TRANSCRIPT_STATES_SCENARIO_ID,
  label: "Three lanes",
  purpose:
    "A session whose three runs end in three different conditions at once — one finished behind a rewind boundary, one parked, one still streaming — so the run groups and the seams all have something to render.",
  sessionId: SESSION_ID,
  // Join order IS hue order: the person first, then the agents in attach order,
  // which is what a real session's join log looks like.
  userIdsInJoinOrder: [USER_YOU, AGENT_ARCHITECT, AGENT_IMPLEMENTER, AGENT_REVIEWER],
  // Which of the roster this window is. Stated rather than read off the head of the
  // join order, which is whoever opened the session on whichever machine.
  callerUserId: USER_YOU,
  startedAtIso: STARTED_AT_ISO,
  beats: composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtMs,
    entries: TRANSCRIPT_STATES_SCRIPT,
  }),
  replies: [
    // The run-scoped reasoning surface, on its `available` arm with a bounded page.
    //
    // A REGISTERED WIRE, so this reply is parsed against the contract's own schema.
    // The arm is `available` because the three empty arms need no scripted entries to
    // be reachable — a run this reply does not name answers with the fixture's own
    // refusal, and the card renders that as itself — while the entries are the one
    // thing no other beat in this session can produce.
    {
      call: "timeline.reasoningSurfaceRead",
      result: {
        availability: "available",
        hasMore: false,
        reasoningEntries: [
          {
            sequence: 12,
            content: "The two storage backends differ in who owns the row, not in what it holds.",
            timestamp: composeAttachedInstant(startedAtMs, 2_500),
          },
          {
            sequence: 13,
            content: "A node-local answer is reversible; a control-plane answer is not.",
            timestamp: composeAttachedInstant(startedAtMs, 2_520),
          },
        ],
      },
    },
    // The answer to the open ask. `DriverAckResult` is an ACKNOWLEDGEMENT that the
    // answer reached the driver and never a settlement of the ask — the scenario
    // scripts no `driver_ask.responded` beat behind it, because a fixture that
    // settled the ask locally would be teaching the surface the one thing it must
    // never do. The registered ack is the EMPTY object — the acknowledgement is the
    // reply's arrival and carries no members at all — so an invented `status` here
    // would fail the strict parse the call goes through.
    {
      call: "driver.respondToRequest",
      result: {},
    },
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
        // user has read most of the log and not all of it.
        timelineCursors: { latest: "ledger-cursor-33", acknowledged: "ledger-cursor-30" },
      },
    },
  ],
  // The refused resume position belongs here: this scenario reaches every state the
  // transcript renders, and `SessionResumeDegraded` has exactly one, a position the app
  // submitted that the daemon could not resolve. The empty-session scenario holds the
  // clean empty state instead, and the endurance generator is not in the picker.
  //
  // The captures pay nothing for it: the refusal needs a second read (the first submits
  // no position), and a settled render performs one only on a focus, a reconnect, or a
  // named frame, none of which a screenshot pass raises.
  refusesSubmittedResumeCursor: true,
};
