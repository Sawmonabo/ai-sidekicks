// The waiting-for-input scenario: a session addressed to something, with a message pending.
//
// It exists so the composer's zones have a session to be addressed WITHIN. One
// person and two agents, so a target is a real choice rather than the only one, and
// the newest run is `waiting_for_input` — the state in which a person's next
// sentence is the thing the session is blocked on, which is the moment the composer
// matters most.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, and every identifier is the
// UUID its branded id type declares. `tests/helpers/scenario-contract-check/contract-check.ts`
// holds this file to the census (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict payload layer
// (`SessionEventSchema`), both in `packages/contracts/src/event.ts`. Three consequences a reader
// will notice first:
//
//   • **`session.created` carries the lead.** The lead is born with the session, named
//     as the live agent list names it, so the `agents` projection rebuilds from the
//     log alone. The reviewer takes part only when a run names it.
//   • **A `run.*` beat is a STATE TRANSITION.** Its payload is
//     `{sessionId, runId, runVersion, previousState, newState, …}` and not a bare
//     `{runId}` — `previousState` is absent only on `run.queued`, where the run is
//     being born and no document names the state it came from.
//   • **Nothing scripts `session.list`.** No method registry in the corpus carries
//     that name, so a scripted reply would be an answer to a question nothing asks.
//
// WHICH CALLS ARE SCRIPTED, AND WHY ONLY THOSE. `services/daemon/scripted-reply.fixture.ts` refuses
// an unscripted call as `reply-unscripted`, which is the fixture's authoring error and a state some
// views are built to render. So a reply is scripted here exactly when a composer control issues
// that call to a real daemon method: `driver.compactContext` from the compaction control,
// `driver.listProviderCommands` from the command zone's discovery popover for the addressed agent,
// and `driver.listModels` and `driver.listCapabilities`, the driver catalog. The approval reads are
// deliberately NOT scripted: this scenario is what makes a refused approval read reachable.
//
// ONE REPLY PER CALL NAME, so the refusing-target half of the enumeration is not
// reachable from here: `replyFor` matches on the method name alone and the fixture
// serves the first entry, so a second `driver.listProviderCommands` scripting a
// refusal would be unreachable rather than conditional. That arm is driven in the
// command zone's own unit, over a bridge whose scenario refuses this call.

import {
  AgentIdSchema,
  UserIdSchema,
  RunIdSchema,
  SessionIdSchema,
  type AgentId,
  type UserId,
  type RunId,
  type SessionId,
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts";
import { type ScenarioAgent, composeSessionCreatedPayload } from "../data/opening-entries.js";
import type { Scenario } from "../scenario.js";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";

// The identifiers the beats and the scripted replies both name.

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
//
// MINTED THROUGH THE REGISTERED SCHEMAS RATHER THAN `as`-CAST. A scenario constant is
// where a fixture chooses the bytes, and a cast asserts a brand without checking it —
// so a malformed id surfaced at the first `.strict()` reply that carried it, which
// takes the whole reply down and names the reply rather than the value. Parsing at
// declaration fails the module instead, naming the constant.
const SESSION_ID: SessionId = SessionIdSchema.parse("019b7a11-1100-75e5-8510-ada11a5a33a5");
const USER_YOU: UserId = UserIdSchema.parse("019b7a11-1100-79a4-8110-cca0117a0310");
const AGENT_IMPLEMENTER: AgentId = AgentIdSchema.parse("019b7a11-1100-7a6e-8110-d1a4c1150301");
const AGENT_REVIEWER: AgentId = AgentIdSchema.parse("019b7a11-1100-7a6e-8120-d1a4c1150302");
const RUN_ID: RunId = RunIdSchema.parse("019b7a11-1100-740e-8110-d1a4c1150311");

/** The session's lead, born with it. */
const COMPOSER_LEAD: ScenarioAgent = {
  agentId: AGENT_IMPLEMENTER,
  name: "Implementer",
  driverName: "claude",
  modelId: "claude-sonnet-5",
};

// What the scenario ANSWERS, as opposed to what it plays.
//
// A reply is a read and a beat is a stream frame, and the fixture serves them through
// different seams: a call is looked up by method and answered once, while a beat is
// routed to a subscription by kind and arrives on the frozen clock. These replies carry
// their own scripted latencies, which is a property of a call and meaningless for a frame.

/**
 * One driver's capability declaration, with every registered flag stated.
 *
 * Built from `DRIVER_CAPABILITY_FLAGS` rather than hand-listed, because
 * `DriverCapabilities.flags` is a TOTAL record over that tuple: a partial literal
 * would read as "the driver did not declare this" for every flag it forgot, which is
 * a different answer from `false`.
 */
function declaredFlags(
  enabled: readonly DriverCapabilityFlag[],
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = enabled.includes(flag);
  }
  return flags;
}

/** What the pinned Claude build declares. */
const CLAUDE_FLAGS: readonly DriverCapabilityFlag[] = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "rollback",
  "session_goals",
  "callback_tools",
  "subagents",
  "context_compaction",
  "provider_commands",
  "output_speed",
];

/**
 * What the pinned Codex build declares.
 *
 * `output_speed` is absent, and its absence is the case a speed control exists to
 * handle: the control is ABSENT rather than disabled for this driver, because a
 * disabled control asserts a capability exists and is momentarily unavailable.
 */
const CODEX_FLAGS: readonly DriverCapabilityFlag[] = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "structured_output",
  "session_goals",
  "callback_tools",
  "subagents",
  "transcript_replay",
  "context_compaction",
  "provider_commands",
];

/** Every call the composer scenario answers, and what it answers with. */
const COMPOSER_REPLIES: readonly ScenarioReply[] = [
  {
    // The discovery popover's dispatch, agent-addressed within the session. The
    // reply is the GROUP LIST the wire declares and never a flat entry array: the
    // group is what carries the `(driverName, providerAccountId)` the entries were
    // read under, and the invariant this popover renders is that an entry is
    // offered only under the binding it came from.
    //
    // `runId` is the run this scenario plays, which is the one live run on this
    // binding — the arm the contract says answers with THAT run rather than with
    // `null`. `providerAccountId` is `null`, the positive statement that this
    // fixture binds no provider account: the composer scenario registers no
    // account, and a synthesized placeholder would make the routing
    // pair compare equal where it must not.
    //
    // The two entries differ in what the provider published, deliberately: the
    // command carries a description and the skill carries a scope and an `enabled`
    // flag, so the row that renders a provider-supplied description and the row
    // that renders its absence are both reachable.
    call: "driver.listProviderCommands",
    result: {
      bindings: [
        {
          runId: RUN_ID,
          binding: { driverName: "claude", providerAccountId: null },
          entries: [
            {
              name: "compact",
              kind: "command",
              description: "Compact the conversation context.",
              binding: { driverName: "claude", providerAccountId: null },
            },
            {
              name: "review",
              kind: "skill",
              scope: "project",
              enabled: true,
              binding: { driverName: "claude", providerAccountId: null },
            },
          ],
          complete: true,
        },
      ],
    },
  },
  {
    // The compaction control's dispatch. `DriverCompactionResult` is a
    // discriminated union whose `applied` arm REQUIRES `boundaryPosition`, typed
    // `number | null` — null being the positive statement that the provider's
    // frame carried no position, which is a different fact from a driver that
    // forgot to report one. This scenario reports a position, so the boundary the
    // compaction landed on is renderable.
    call: "driver.compactContext",
    // A scripted latency, so the in-flight half of the control is reachable: a
    // compaction that settled instantly would let a control ship without ever
    // rendering the state a person actually watches.
    afterMs: 200,
    result: { status: "applied", boundaryPosition: 8 },
  },
  {
    // The first half of the driver catalog the target chip's axis popover renders.
    // Scripted whether or not anybody opens the popover: an unscripted call is the
    // fixture's authoring error, and a refusal pinned into every composer reference
    // would be a statement about a read this scenario never meant to refuse.
    //
    // TWO DRIVERS, BECAUSE THE NODE RUNS TWO. The lead runs on `claude` and the
    // reviewer on `codex`, so the chip has a real target choice, and a catalog
    // carrying only one of them would hold the popover's actions back on the agent
    // whose own driver the catalog could not vouch for.
    call: "driver.listModels",
    result: {
      drivers: [
        {
          driverName: "claude",
          models: [
            {
              id: "claude-sonnet-5",
              name: "Sonnet 5",
              capabilities: ["reasoning", "tool_calls"],
              effortLevels: ["low", "medium", "high", "xhigh", "max"],
              fast: false,
            },
            {
              id: "claude-opus-5[1m]",
              name: "Opus 5 (1M)",
              capabilities: ["reasoning", "tool_calls"],
              effortLevels: ["low", "medium", "high", "xhigh", "max"],
              fast: true,
            },
          ],
        },
        {
          driverName: "codex",
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              capabilities: ["reasoning", "tool_calls"],
              effortLevels: ["low", "medium", "high", "xhigh"],
              fast: true,
            },
          ],
        },
      ],
    },
  },
  {
    // The catalog's other half, declared from the two pinned-build flag sets above.
    //
    // `outputSpeedLevels` rides the CLAUDE row only, because it is present exactly
    // where the flag is true — the daemon's own composition rule, which a fixture
    // publishing a level list beside a false flag would quietly break.
    call: "driver.listCapabilities",
    result: {
      drivers: [
        {
          driverName: "claude",
          capabilities: { flags: declaredFlags(CLAUDE_FLAGS), contractVersion: "1.0" },
          outputSpeedLevels: ["off", "on"],
          builtInTools: [
            "Read",
            "Edit",
            "Write",
            "Bash",
            "Glob",
            "Grep",
            "WebFetch",
            "WebSearch",
            "Agent",
          ],
        },
        {
          driverName: "codex",
          capabilities: { flags: declaredFlags(CODEX_FLAGS), contractVersion: "1.0" },
          builtInTools: ["shell", "apply_patch", "web_search"],
        },
      ],
    },
  },
];

export const WAITING_FOR_INPUT_SCENARIO: Scenario = {
  id: "waiting-for-input",
  label: "Awaiting a reply",
  purpose:
    "A session whose newest run is blocked on a person's next message — the state the composer's target, posture, and send resolution are read against.",
  sessionId: SESSION_ID,
  // Join order IS hue order: the person who joined, then the agents in the order they
  // joined.
  userIdsInJoinOrder: [USER_YOU, AGENT_IMPLEMENTER, AGENT_REVIEWER],
  // Which of the three this window is. Stated rather than read off the head of the
  // join order — that entry is whoever opened the session, on whichever machine, and
  // a view handed a fabricated identity renders a role gate as though it had been
  // checked. The fixture answers `callerUserRead` from this field alone.
  callerUserId: USER_YOU,
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorId: USER_YOU,
        // The registered shape: the session's shape and the lead born with it. A
        // session's name reaches the console from the sessions list; the creation
        // event carries no title, and its `.strict()` payload rejects one.
        payload: composeSessionCreatedPayload({
          sessionId: SESSION_ID,
          shape: "project",
          openedBy: USER_YOU,
          lead: COMPOSER_LEAD,
          createdAt: "2026-01-01T11:05:00.000Z",
        }),
      },
    },
    {
      atMs: 260,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150003",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.260Z",
        actorId: USER_YOU,
        // `previousState` is absent here and only here: a queued run is being born.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 1,
          newState: "queued",
          agentId: AGENT_IMPLEMENTER,
        },
      },
    },
    {
      atMs: 320,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150004",
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "run.starting",
        occurredAt: "2026-01-01T11:05:00.320Z",
        // No actor: the daemon moves a run out of `queued`, and a user id
        // here would attribute a system transition to a person.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 400,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150005",
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "run.running",
        occurredAt: "2026-01-01T11:05:00.400Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
        },
      },
    },
    {
      atMs: 480,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150006",
        sessionId: SESSION_ID,
        sequence: 5,
        // Waiting is not pausing: this run is blocked on someone, and the composer
        // is where that someone answers.
        kind: "run.waiting_for_input",
        occurredAt: "2026-01-01T11:05:00.480Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 4,
          previousState: "running",
          newState: "waiting_for_input",
        },
      },
    },
    {
      atMs: 540,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150007",
        sessionId: SESSION_ID,
        sequence: 6,
        // The implementer's goal, as the log carries it — there is no goal store, so
        // this event IS the goal. A person set it, so the beat carries an actor.
        kind: "session.goal_updated",
        occurredAt: "2026-01-01T11:05:00.540Z",
        actorId: USER_YOU,
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_IMPLEMENTER,
          goal: {
            text: "Land the rate-limit wiring behind the enforcement legs, then close the backlog items it names.",
          },
          status: "active",
        },
      },
    },
  ],
  replies: COMPOSER_REPLIES,
};
