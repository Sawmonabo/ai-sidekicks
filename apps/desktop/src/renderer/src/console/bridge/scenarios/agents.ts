// The agents scenario — two agents, one switch pending and one already applied.
//
// One session, two attached agents, and the provider-axis switch in both of the
// states that matter. That pair is the point of the scenario rather than
// decoration: the agent card's hardest rule is that the EFFECTIVE binding and a
// PENDING switch are two different lines and the effective columns move only when
// the terminal settlement lands (`Spec-023 §Console Design (Meridian)` §The agent
// card). A scenario with only `agent.attached` beats can never exercise that, so
// the card would be built against a case that cannot go wrong.
//
// Every `kind` is a registered wire event type CARRYING THE REGISTERED PAYLOAD, and
// `scenarios/wire-truth.ts` holds this file to both. Two consequences a reader meets
// first, the same two `flagship.ts` records: the identifiers are the branded UUIDs
// the strict layer declares, and `session.created` carries `{sessionId, config,
// metadata}` rather than a title — a session's display name reaches the console from
// the session read, never from the creation event.
//
// THE TWO SWITCH STATES REACH THE CONSOLE THROUGH TWO DIFFERENT DOORS, AND THAT IS
// THE WIRE'S DOING RATHER THAN THIS FILE'S CONVENIENCE.
//
//   • A PENDING switch is durable and singular, so it rides the roster read: it is
//     `AgentRosterEntry.pendingSwitch`, re-read on every refresh, and it survives a
//     restart because the daemon persists the intent. This scenario's pending switch
//     also carries `replacedSwitchId`, which is the supersession case — the only
//     record that an earlier intent was displaced, since the wire carries no cancel.
//   • An APPLIED switch is a settlement, so it rides the mutation's own reply:
//     `agent.configUpdate` answers with a `switch` member carrying `continuity` and
//     the declared-loss list. `declaredLosses: []` asserts that nothing was dropped;
//     an ABSENT list asserts nothing at all, which is why the applied arm here
//     states one explicitly.
//
// WHY THE SWITCH TERMINALS ARE NOT BEATS. `agent.provider_switched` and
// `agent.provider_switch_failed` are named by `Spec-016 §The mutation surface` and
// are NOT in the shipped census (`packages/contracts/src/event.ts` registers
// `agent.attached`, `agent.detached`, and `agent.config_updated` and no third agent
// type), which is why `agents/agent-wire.ts` leaves them out of its own signal set.
// So the deferred application a pending switch is waiting for cannot be scripted at
// all, and this file does not pretend otherwise: the pending row stays pending and
// the console renders exactly that. A fixture that minted the terminal here would be
// authoring a wire shape, which is the one thing fixture data must not do.
//
// WHY THE TWO `driver.*` READS CARRY FULL CATALOGS. They are the only LIVE-NOW wires
// these surfaces have, and every axis control is composed from the pair — a model's
// effort vocabulary from the model catalog, the output-speed vocabulary and the
// capability gate from the capability report. The vocabularies below are the pinned
// providers' own published ones (`Spec-005 §Provider Parameter Vocabularies`): they
// differ PER MODEL, one of them exposes no effort surface at all, and only one of
// the two drivers declares an output-speed axis. A fixture that gave both drivers
// one uniform list would let the axis controls be built against a wire shape neither
// provider produces.

import {
  DRIVER_CAPABILITY_FLAGS,
  type DeclaredLossKind,
  type DriverCapabilityFlag,
  type ProviderOutputSpeedState,
} from "@ai-sidekicks/contracts";

import type { ConsoleScenario } from "../scenario.js";

export const AGENTS_SCENARIO_ID = "agents";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
const SESSION_ID = "019b7952-5ec0-75e5-8510-ada11a5a44a5";
const PARTICIPANT_YOU = "019b7952-5ec0-79a4-8110-cca0117a0440";
const AGENT_ARCHITECT = "019b7952-5ec0-7a6e-8110-d1a4c1150041";
const AGENT_IMPLEMENTER = "019b7952-5ec0-7a6e-8120-d1a4c1150042";
const PENDING_SWITCH_ID = "019b7952-5ec0-7b90-8110-d1a4c1150051";
const SUPERSEDED_SWITCH_ID = "019b7952-5ec0-7b90-8120-d1a4c1150052";
const APPLIED_SWITCH_ID = "019b7952-5ec0-7b90-8130-d1a4c1150053";
const PROVIDER_ACCOUNT_WORK = "019b7952-5ec0-7d40-8110-d1a4c1150061";
const PROVIDER_ACCOUNT_PERSONAL = "019b7952-5ec0-7d40-8120-d1a4c1150062";

/**
 * One driver's capability declaration, with every registered flag stated.
 *
 * Built from `DRIVER_CAPABILITY_FLAGS` rather than hand-listed, because
 * `DriverCapabilities.flags` is a TOTAL record over that tuple: a hand-written
 * literal would go stale the day the contract registers an eighteenth flag, and a
 * PARTIAL one would read as "the driver did not declare this" for every flag it
 * forgot — which is a different answer from `false` and the one
 * `agents/driver-catalog.ts` deliberately distinguishes.
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

/** What the pinned Claude build declares. Notably no `output_speed`-less arm here. */
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
  "cost_cap",
  "context_compaction",
  "provider_commands",
  "output_speed",
];

/**
 * What the pinned Codex build declares.
 *
 * `output_speed` is absent, and its absence is the case the axis control exists to
 * handle: the control is ABSENT rather than disabled for this driver, because a
 * disabled control asserts a capability exists and is momentarily unavailable, which
 * would be false.
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
  "cost_cap",
  "context_compaction",
  "provider_commands",
];

/**
 * The two attached agents, as every view of them reads.
 *
 * One table rather than a literal per beat and a second per roster row, on
 * `flagship.ts`'s rule: `agent.attached` and the `agent.list` entry are two views of
 * one record, and two hand-written copies drift where nothing catches it. The
 * drivers are deliberately mixed — a fixture whose whole cast runs one provider
 * cannot show an axis control what a two-provider session looks like.
 */
const ATTACHED_AGENTS = [
  {
    agentId: AGENT_ARCHITECT,
    eventId: "019b7952-5ec0-7ea1-8120-e5e0d1150442",
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    effort: "high",
    outputSpeed: "standard",
    providerAccountId: PROVIDER_ACCOUNT_WORK,
    attachedAtMs: 80,
    attachedAtIso: "2026-01-01T11:30:00.080Z",
  },
  {
    agentId: AGENT_IMPLEMENTER,
    eventId: "019b7952-5ec0-7ea1-8130-e5e0d1150443",
    name: "Implementer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    effort: "medium",
    outputSpeed: undefined,
    providerAccountId: PROVIDER_ACCOUNT_PERSONAL,
    attachedAtMs: 140,
    attachedAtIso: "2026-01-01T11:30:00.140Z",
  },
] as const;

export const AGENTS_SCENARIO: ConsoleScenario = {
  id: AGENTS_SCENARIO_ID,
  label: "Two agents, one re-bound",
  purpose:
    "Two attached agents across two providers, one holding a pending switch that displaced an earlier one and one whose switch has already applied with its losses declared — the case that separates the effective binding from a pending one.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, AGENT_ARCHITECT, AGENT_IMPLEMENTER],
  // Which of the three this window is — the person, not either agent. Stated rather
  // than inferred: the head of the join order is whoever opened the session on
  // whichever machine, and reading it as "me" is a fabrication a role gate would
  // then be rendered from.
  viewingParticipantId: PARTICIPANT_YOU,
  // The one membership in the room, and only the one. Both agents are in the join
  // order because each takes a hue; an agent is attached rather than admitted and
  // holds no membership, so naming one here would put a row in the participant
  // partition that resolves to a role no daemon granted.
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  startedAtIso: "2026-01-01T11:30:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7952-5ec0-7ea1-8110-e5e0d1150441",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:30:00.000Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...ATTACHED_AGENTS.map((agent, agentIndex) => ({
      atMs: agent.attachedAtMs,
      event: {
        id: agent.eventId,
        sessionId: SESSION_ID,
        sequence: 2 + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. An agent does not attach
        // itself, and the envelope actor is who acted.
        actorId: PARTICIPANT_YOU,
        // The full persona plus the daemon-resolved resulting state, so the `agents`
        // projection rebuilds from the log alone. `name` is the member —
        // `displayName` is not on this wire.
        payload: {
          sessionId: SESSION_ID,
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          state: "ready",
          actor: PARTICIPANT_YOU,
        },
      },
    })),
    {
      atMs: 320,
      event: {
        id: "019b7952-5ec0-7ea1-8140-e5e0d1150444",
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.config_updated",
        occurredAt: "2026-01-01T11:30:00.320Z",
        actorId: PARTICIPANT_YOU,
        // The signal that a roster re-read is owed. The census registers no payload
        // variant for this type, so the payload names the agent the mutation
        // addressed and nothing else — the settlement itself travels on the
        // mutation's reply, and duplicating it here would give the card a second
        // source of truth for the one fact it must read from one place.
        payload: { sessionId: SESSION_ID, agentId: AGENT_IMPLEMENTER },
      },
    },
    {
      atMs: 420,
      event: {
        id: "019b7952-5ec0-7ea1-8150-e5e0d1150445",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "agent.config_updated",
        occurredAt: "2026-01-01T11:30:00.420Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, agentId: AGENT_ARCHITECT },
      },
    },
  ],
  replies: [
    {
      call: "agent.list",
      result: {
        agents: [
          {
            agentId: AGENT_ARCHITECT,
            name: "Architect",
            state: "ready",
            createdAt: ATTACHED_AGENTS[0].attachedAtIso,
            driverName: ATTACHED_AGENTS[0].driverName,
            modelId: ATTACHED_AGENTS[0].modelId,
            config: {
              providerAccountId: ATTACHED_AGENTS[0].providerAccountId,
              effort: ATTACHED_AGENTS[0].effort,
              outputSpeed: ATTACHED_AGENTS[0].outputSpeed,
            },
            // What the provider DECLARED, beside what was requested. Carried
            // separately because folding it into `config.outputSpeed` would make a
            // declined request indistinguishable from an honoured one.
            //
            // THE OBJECT IS THE WIRE SHAPE, and `satisfies` is what keeps it one.
            // A scripted reply is stored as `unknown`, so a bare `"standard"` here
            // parsed perfectly and reached the card as a value whose `.declared` is
            // `undefined` — the fixture breaking the one surface it exists to prove.
            // No `reason`: the request and the declaration agree, so the provider
            // has nothing to explain, and an absent `reason` says exactly that.
            observedOutputSpeed: { declared: "standard" } satisfies ProviderOutputSpeedState,
            // The durable, singular pending intent — held at a RUN boundary because
            // `providerAccountId` is spawn-bound on every driver, and naming the
            // intent it displaced, which is the wire's only record of the earlier
            // one. There is no cancel verb, so no cancel control is drawn over this.
            pendingSwitch: {
              switchId: PENDING_SWITCH_ID,
              appliesAt: "run_boundary",
              interruptRequested: false,
              pendingAxes: [
                { axis: "providerAccountId", value: PROVIDER_ACCOUNT_PERSONAL },
                { axis: "effort", value: "max" },
              ],
              replacedSwitchId: SUPERSEDED_SWITCH_ID,
            },
          },
          {
            agentId: AGENT_IMPLEMENTER,
            name: "Implementer",
            state: "ready",
            createdAt: ATTACHED_AGENTS[1].attachedAtIso,
            driverName: ATTACHED_AGENTS[1].driverName,
            modelId: ATTACHED_AGENTS[1].modelId,
            // The applied switch's effect, already folded into the effective
            // binding: this is the row AFTER the settlement below landed, which is
            // what makes the two lines distinguishable on screen at all.
            config: {
              providerAccountId: ATTACHED_AGENTS[1].providerAccountId,
              effort: ATTACHED_AGENTS[1].effort,
            },
          },
        ],
      },
    },
    {
      // The applied arm, with its losses DECLARED rather than implied. `continuity`
      // is `replayed`, which is what makes a non-empty loss list possible at all: an
      // `in_place` carry drops nothing, and a `memo` settlement drops the transcript
      // wholesale.
      //
      // THE PAIR IS THE REPLAY PIPELINE'S OWN, and `satisfies` is what holds it to
      // the registered vocabulary — the list was two invented strings, which the
      // settlement renderer read as two UNNAMED losses, so the surface built for the
      // declared-loss path was being shown a response no daemon may emit. The two
      // are also causally ordered rather than merely both legal: stripping private
      // reasoning orphans the tool calls that referenced it, and the pairing repair
      // that follows mints a synthetic result for each — which is why a replay that
      // declares the first so often declares the second. The two memo-scoped kinds
      // are deliberately absent: they belong to the settlement this one is not.
      call: "agent.configUpdate",
      // A real switch is not instant — it waits for the boundary the daemon
      // resolved — so the settlement is parked on the frozen clock and the card's
      // in-flight rendering is reachable. The caller moves the clock; nothing here
      // does.
      afterMs: 180,
      result: {
        switch: {
          status: "applied",
          switchId: APPLIED_SWITCH_ID,
          appliesAt: "turn_boundary",
          continuity: "replayed",
          declaredLosses: [
            "provider_private_reasoning",
            "tool_call_history_repaired",
          ] satisfies readonly DeclaredLossKind[],
        },
      },
    },
    {
      call: "driver.listModels",
      result: {
        drivers: [
          {
            driverName: "claude",
            models: [
              {
                id: "claude-opus-5[1m]",
                name: "Opus 5 (1M)",
                capabilities: ["reasoning", "tool_calls"],
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
              },
              {
                id: "claude-sonnet-5",
                name: "Sonnet 5",
                capabilities: ["reasoning", "tool_calls"],
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
              },
              {
                // The model with NO effort surface. Its absent `effortLevels` is the
                // case the effort control exists to handle: no control at all rather
                // than an empty one, because an empty select asserts an axis exists
                // with nothing on it and no provider surface makes that claim.
                id: "claude-haiku-4-5-20251001",
                name: "Haiku 4.5",
                capabilities: ["tool_calls"],
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
              },
              {
                // A published list carrying `max` without `xhigh`, which is why the
                // vocabulary is read per MODEL: no provider-wide list is right for
                // every model in the provider's own reply.
                id: "gpt-5.6-luna",
                name: "GPT-5.6 Luna",
                capabilities: ["reasoning", "tool_calls"],
                effortLevels: ["low", "medium", "high", "max"],
              },
            ],
          },
        ],
      },
    },
    {
      call: "driver.listCapabilities",
      result: {
        drivers: [
          {
            driverName: "claude",
            capabilities: { flags: declaredFlags(CLAUDE_FLAGS), contractVersion: "1.0" },
            // Present exactly because the flag is true. The pair is the daemon's
            // composition rule and the fixture keeps it.
            outputSpeedLevels: ["standard", "fast"],
          },
          {
            driverName: "codex",
            capabilities: { flags: declaredFlags(CODEX_FLAGS), contractVersion: "1.0" },
          },
        ],
      },
    },
  ],
};
