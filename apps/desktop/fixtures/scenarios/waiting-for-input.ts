// The waiting-for-input scenario: a session addressed to something, with a message pending.
//
// One person and two agents, so the composer's target is a real choice, and the newest run is
// `waitingForInput`: the state where the person's next sentence is what the session is
// blocked on.
//
// Every beat is a registered event with its registered payload, and every id is the UUID its
// branded type declares. `tests/helpers/scenario/contract-check/all-axes.ts` holds each beat to
// its category and to the generated check of its whole event. So:
//
//   - `session.created` carries the lead, so the `agents` projection rebuilds from the log
//     alone. The reviewer takes part only when a run names it.
//   - A `run.*` beat is a state transition, `{sessionId, runId, runVersion, previousState,
//     newState, ...}`, with `previousState` absent only on `run.queued`.
//   - Nothing scripts `session.list`, which is a subscription and not a call a view makes.
//
// A reply is scripted only when a composer control issues that call to a real daemon method,
// because `services/daemon/scripted/reply.fixture.ts` refuses an unscripted call as
// `reply-unscripted`: `provider.command.list` from the command zone's discovery popover.
// The approval reads are deliberately not scripted, so this scenario makes a refused approval
// read reachable.
//
// There is one reply per call name: `replyFor` matches on the method name alone and serves the
// first entry, so a second `provider.command.list` refusal would be unreachable. That arm
// is tested in `features/composer/command-list/`, over a bridge whose scenario refuses the call.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type {
  ProviderCommandBinding,
  ProviderCommandListResponse,
} from "@ai-sidekicks/contracts/provider/driver/commands";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { type ScenarioAgent, composeSessionCreatedPayload } from "../data/opening-entries.js";
import {
  composeScenarioInstant,
  composeScriptBeats,
  createRunEntryBuilders,
  newestBeatInstant,
  type ScriptEntry,
} from "../data/script-entries.js";
import { defineScenario, type Scenario } from "../scenario.js";
import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";
import { sessionReadReply } from "../data/session-record.js";
import { PROVIDER_LIST_REPLY } from "../data/provider-list.js";

// The ids the beats and the scripted replies both name: UUID v7 values whose leading bytes are
// this scenario's start instant. The contract check holds each beat that names one to its
// generated check, so a malformed id fails there.
const SESSION_ID = "019b7a11-1100-75e5-8510-ada11a5a33a5" as SessionId;
const USER_YOU = "019b7a11-1100-79a4-8110-cca0117a0310" as UserId;
const AGENT_IMPLEMENTER = "019b7a11-1100-7a6e-8110-d1a4c1150301" as AgentId;
const RUN_ID = "019b7a11-1100-740e-8110-d1a4c1150311" as RunId;

/** The session's lead, born with it. */
const COMPOSER_LEAD: ScenarioAgent = {
  agentId: AGENT_IMPLEMENTER,
  name: "Implementer",
  providerName: "claude",
  modelId: "claude-sonnet-5",
};

// What the scenario answers, as opposed to what it plays. A call is looked up by method and
// answered once, with its own scripted latency; a beat is a stream frame routed by kind on the
// frozen clock.

/** The provider and account the lead's commands are read under. */
const LEAD_BINDING: ProviderCommandBinding = {
  providerName: COMPOSER_LEAD.providerName as ProviderId,
  providerAccountId: "pa-0001" as ProviderAccountId,
};

// Every call the scenario answers, and what it answers with.
const COMPOSER_REPLIES: readonly ScenarioReply[] = [
  {
    // The discovery popover's dispatch. The reply is the group list the wire declares, not a
    // flat entry array: each group carries the provider and account its entries were read
    // under, so an entry is offered only under its own binding. `runId` is the one live run on
    // this binding, the arm the contract answers with that run rather than `null`.
    //
    // The first command carries a description and the second a scope and an `enabled` flag, so
    // rows with and without a provider description are both reachable. A provider's skill is
    // not one of them: the list offers skills from the service's own skill list.
    call: "provider.command.list",
    result: {
      bindings: [
        {
          runId: RUN_ID,
          binding: LEAD_BINDING,
          entries: [
            {
              name: "compact",
              kind: "command",
              description: "Compact the conversation context.",
              binding: LEAD_BINDING,
            },
            {
              name: "review",
              kind: "command",
              scope: "project",
              enabled: true,
              binding: LEAD_BINDING,
            },
          ],
        },
      ],
    } satisfies ProviderCommandListResponse,
  },
];

// The base instant, built with `Date.UTC` rather than by parsing a string, so the ISO spelling
// below cannot disagree with it.
const STARTED_AT_MS: number = Date.UTC(2026, 0, 1, 11, 5);
const STARTED_AT_ISO: string = composeScenarioInstant(STARTED_AT_MS, 0);

// The stem row ids are minted from; `composeScriptBeats` completes it with the beat's position.
const EVENT_ID_STEM = "019b7a11-1100-7e00-8110-e5e0c115";

const run = createRunEntryBuilders(SESSION_ID);

const WAITING_FOR_INPUT_SCRIPT: readonly ScriptEntry[] = [
  {
    atMs: 0,
    kind: "session.created",
    actorId: USER_YOU,
    // The creation event carries no title; its `.strict()` payload rejects one.
    payload: composeSessionCreatedPayload({
      sessionId: SESSION_ID,
      shape: "project",
      openedBy: USER_YOU,
      lead: COMPOSER_LEAD,
      createdAt: STARTED_AT_ISO,
    }),
  },
  // `previousState` is absent here and only here: a queued run is being born.
  run.transition(RUN_ID, {
    atMs: 260,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
    actorId: USER_YOU,
  }),
  // No actor: the daemon moves a run out of `queued`.
  run.transition(RUN_ID, {
    atMs: 320,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  run.transition(RUN_ID, {
    atMs: 400,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  // Waiting is not pausing: this run is blocked on someone, and the composer is where they
  // answer.
  run.transition(RUN_ID, {
    atMs: 480,
    runVersion: 4,
    previousState: "running",
    newState: "waitingForInput",
  }),
  // The implementer's goal lives only in the log: this event is the goal. A person set it, so
  // the beat carries an actor.
  {
    atMs: 540,
    kind: "session.goal.updated",
    actorId: USER_YOU,
    payload: {
      sessionId: SESSION_ID,
      agentId: AGENT_IMPLEMENTER,
      goal: {
        text:
          "Land the rate-limit wiring behind the enforcement " +
          "legs, then close the backlog items it names.",
      },
      status: "active",
    },
  },
];

/** A session whose newest run is blocked on the person's next message. */
export const WAITING_FOR_INPUT_SCENARIO: Scenario = defineScenario(
  {
    id: "waiting-for-input",
    label: "Awaiting a reply",
    purpose:
      "A session whose newest run is blocked on a person's next message — the " +
      "state the composer's target, posture, and send resolution are read against.",
    sessionId: SESSION_ID,
    startedAtIso: STARTED_AT_ISO,
  },
  () => {
    const beats = composeScriptBeats({
      sessionId: SESSION_ID,
      eventIdStem: EVENT_ID_STEM,
      startedAtMs: STARTED_AT_MS,
      entries: WAITING_FOR_INPUT_SCRIPT,
    });
    return {
      beats,
      replies: [
        PROVIDER_LIST_REPLY,
        sessionReadReply({
          sessionId: SESSION_ID,
          state: "active",
          shape: "project",
          createdAt: STARTED_AT_ISO,
          updatedAt: newestBeatInstant(beats),
          beats,
        }),
        ...COMPOSER_REPLIES,
      ],
    };
  },
);
