// The waiting-for-input scenario: a session addressed to something, with a message pending.
//
// One person and two agents, so the composer's target is a real choice, and the newest run is
// `waiting_for_input`: the state where the person's next sentence is what the session is
// blocked on.
//
// Every beat is a registered event with its registered payload, and every id is the UUID its
// branded type declares. `tests/helpers/scenario-contract-check/contract-check.ts` holds the
// beats to the census (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict payload layer
// (`SessionEventSchema`) in `packages/contracts/src/event.ts`. So:
//
//   - `session.created` carries the lead, so the `agents` projection rebuilds from the log
//     alone. The reviewer takes part only when a run names it.
//   - A `run.*` beat is a state transition, `{sessionId, runId, runVersion, previousState,
//     newState, ...}`, with `previousState` absent only on `run.queued`.
//   - Nothing scripts `session.list`, which is a subscription and not a call a view makes.
//
// A reply is scripted only when a composer control issues that call to a real daemon method,
// because `services/daemon/scripted-reply.fixture.ts` refuses an unscripted call as
// `reply-unscripted`: `driver.compactContext` from the compaction popover,
// `driver.listProviderCommands` from the command zone's discovery popover, and
// `driver.listModels` and `driver.listCapabilities`, the driver catalog. The approval reads are
// deliberately not scripted, so this scenario makes a refused approval read reachable.
//
// There is one reply per call name: `replyFor` matches on the method name alone and serves the
// first entry, so a second `driver.listProviderCommands` refusal would be unreachable. That arm
// is tested in `features/composer/command-list/`, over a bridge whose scenario refuses the call.

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

// The ids the beats and the scripted replies both name: UUID v7 values whose leading bytes are
// this scenario's start instant. Parsed through the registered schemas, not cast, so a
// malformed id fails the module and names the constant instead of failing a later reply.
const SESSION_ID: SessionId = SessionIdSchema.parse("019b7a11-1100-75e5-8510-ada11a5a33a5");
const USER_YOU: UserId = UserIdSchema.parse("019b7a11-1100-79a4-8110-cca0117a0310");
const AGENT_IMPLEMENTER: AgentId = AgentIdSchema.parse("019b7a11-1100-7a6e-8110-d1a4c1150301");
const RUN_ID: RunId = RunIdSchema.parse("019b7a11-1100-740e-8110-d1a4c1150311");

/** The session's lead, born with it. */
const COMPOSER_LEAD: ScenarioAgent = {
  agentId: AGENT_IMPLEMENTER,
  name: "Implementer",
  driverName: "claude",
  modelId: "claude-sonnet-5",
};

// What the scenario answers, as opposed to what it plays. A call is looked up by method and
// answered once, with its own scripted latency; a beat is a stream frame routed by kind on the
// frozen clock.

// One driver's capability declaration with every registered flag stated:
// `DriverCapabilities.flags` is a total record, and a forgotten flag would read as undeclared
// rather than `false`.
function declaredFlags(
  enabled: readonly DriverCapabilityFlag[],
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = enabled.includes(flag);
  }
  return flags;
}

// What the pinned Claude build declares.
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

// What the pinned Codex build declares. `output_speed` is absent, so the speed control is
// absent for this driver rather than disabled, which would claim the capability exists.
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
  "context_compaction",
  "provider_commands",
];

// Every call the scenario answers, and what it answers with.
const COMPOSER_REPLIES: readonly ScenarioReply[] = [
  {
    // The discovery popover's dispatch. The reply is the group list the wire declares, not a
    // flat entry array: each group carries the `(driverName, providerAccountId)` its entries
    // were read under, so an entry is offered only under its own binding.
    //
    // `runId` is the one live run on this binding, the arm the contract answers with that run
    // rather than `null`. `providerAccountId` is `null` because this scenario binds no account.
    //
    // The command carries a description and the skill a scope and an `enabled` flag, so rows
    // with and without a provider description are both reachable.
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
    // The compaction popover's dispatch. The `applied` arm of `DriverCompactionResult` requires
    // `boundaryPosition` (`number | null`); this scenario reports a position so the boundary is
    // renderable.
    call: "driver.compactContext",
    // A scripted latency, so the control's in-flight state is reachable.
    afterMs: 200,
    result: { status: "applied", boundaryPosition: 8 },
  },
  {
    // The first half of the driver catalog the target chip's axis popover renders. Two drivers:
    // the lead runs on `claude` and the reviewer on `codex`, so the target choice is real.
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
    // The catalog's other half, from the two flag sets above. `outputSpeedLevels` rides the
    // claude row only, because it is present exactly where the flag is true.
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

/** A session whose newest run is blocked on the person's next message. */
export const WAITING_FOR_INPUT_SCENARIO: Scenario = {
  id: "waiting-for-input",
  label: "Awaiting a reply",
  purpose:
    "A session whose newest run is blocked on a person's next message — the state the composer's target, posture, and send resolution are read against.",
  sessionId: SESSION_ID,
  thisDeviceId: USER_YOU,
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
        // The creation event carries no title; its `.strict()` payload rejects one.
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
        // No actor: the daemon moves a run out of `queued`.
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
        // Waiting is not pausing: this run is blocked on someone, and the composer is where
        // they answer.
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
        // The implementer's goal lives only in the log: this event is the goal. A person set
        // it, so the beat carries an actor.
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
