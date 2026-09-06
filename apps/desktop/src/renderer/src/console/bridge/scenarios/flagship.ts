// The flagship scenario — four lanes streaming at once.
//
// The session `budgets.json`'s `frame-time-p95-four-lanes` row names as its subject:
// "four agent lanes stream concurrently into the ledger". That row is enforced, so
// this script is what the ceiling is measured against, and the concurrency is the
// property under measurement rather than a description of it — four runs are
// mid-turn at the same tick, interleaved beat by beat, and
// `scenarios/streaming-lanes.ts` reads that back off these beats so the harness
// asserts it instead of assuming it.
//
// WHAT THE SESSION DOES, IN THE ORDER IT DOES IT
//
//   • Two people, four agents, and the implementer's run opened — the opening this
//     scenario has always had, and the one every surface built against it expects.
//   • The other three lanes spin up, and from the architect's `running` transition
//     onward all four are streaming: thinking, messages, and tool calls interleaved
//     across four run chapters rather than four runs taken in turn.
//   • An approval lands MID-STREAM. The implementer's run enters
//     `waiting_for_approval` while the other three keep talking, and returns through
//     `running`. That is the whole of the approval story the log can tell — see the
//     note below on why no `approval.*` beat is scripted.
//   • The cost meter moves, four times, one per lane.
//   • A thread is drawn between two runs: the architect's turn spawns a helper run,
//     whose birth beat carries `parentRunId`. It is queued and starting at the last
//     tick, so the frame also has the one lane state a four-lane session otherwise
//     never shows — a run on screen that has produced nothing yet.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, under the two-leg
// rule `scenarios/wire-truth.ts` states in its header: the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`), both in
// `packages/contracts/src/event.ts`, are the code leg, and where a type has no strict
// variant its members come from the per-type payload rows of
// `docs/specs/006-session-event-taxonomy-and-audit-log.md`, the taxonomy
// those variants are implemented from. That predicate holds this file to
// the layers that exist in code. That is not tidiness — a fixture that plays a type
// no daemon emits produces screenshots, geometry readings, and end-to-end results
// about a wire that does not exist, and every one of them looks like a pass.
//
// THREE THINGS THIS SCRIPT DELIBERATELY DOES NOT SAY
//
//   • **An approval card.** `approval.requested` is a registered type, but the card
//     it would draw belongs to the surface that renders approvals, and the run-state
//     pair below is what the ledger reads: `run.waiting_for_approval` and the
//     `run.running` that releases it. Scripting both would put two records of one
//     approval in one session, and the ledger would have to decide which is true.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.
//   • **A link TYPE on the run thread.** `linkType` is typed by a Plan-016 symbol no
//     TypeScript in this workspace declares, so the thread carries the two linkage
//     members that do have types — `parentRunId` and `internalHelper` — and says
//     nothing about which kind of link it is.
//
// TWO CONSEQUENCES A READER WILL NOTICE FIRST:
//
//   • **The identifiers are UUIDs.** `SessionId`, `ParticipantId`, `MembershipId`,
//     `AgentId`, and `RunId` are branded UUIDs (`§Branded ID Types` in
//     `docs/architecture/contracts/api-payload-contracts.md`), and the strict layer
//     refuses anything else. A readable `"agent-scout"` would also have rendered at
//     a third of the width a real one does, which is a design lie in a fixture
//     whose whole job is to be measured.
//   • **`session.created` carries no title.** Its registered payload is
//     `{sessionId, config, metadata}` and it is `.strict()`, so a `title` member is
//     rejected outright. A session's display name reaches the console from the
//     session read, and `session.renamed` is where a later change to it would
//     arrive — never from the creation event.

import { scriptLedgerBeats } from "./ledger-script.js";
import {
  AGENT_ARCHITECT,
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  AGENT_SCOUT,
  EVENT_ID_STEM,
  FLAGSHIP_AGENTS,
  PARTICIPANT_PRIYA,
  PARTICIPANT_YOU,
  SESSION_ID,
  STARTED_AT_ISO,
  attachedAtIso,
} from "./flagship-cast.js";
import { FLAGSHIP_SCRIPT } from "./flagship-script.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

export const FLAGSHIP_SCENARIO_ID = "flagship";

/**
 * How many lanes this session streams at once.
 *
 * Read off the cast rather than written as a four: the budget row, the scenario's
 * own label, and the harness assertion all mean "one lane per agent", and a literal
 * in any of them would let the cast grow while the claim stayed at its old size.
 */
export const FLAGSHIP_LANE_COUNT: number = FLAGSHIP_AGENTS.length;

export const FLAGSHIP_SCENARIO: ConsoleScenario = {
  id: FLAGSHIP_SCENARIO_ID,
  label: "Four lanes",
  purpose:
    "A live session with four agents streaming at once — interleaved turns on four run chapters, an approval landing mid-stream while the other three carry on, the cost meter moving on every lane, and a helper run threaded to the turn that spawned it.",
  sessionId: SESSION_ID,
  // Join order IS the hue order. Two people first, then the agents in the order
  // they were attached — which is what a real session's join log looks like.
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_ARCHITECT,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
    AGENT_SCOUT,
  ],
  // Which of the six this window is. Stated rather than inferred from the head of
  // the join order — that entry is whoever opened the session, on whichever machine,
  // and the two facts coincide here only because this scenario chose to make them.
  viewingParticipantId: PARTICIPANT_YOU,
  // The two memberships, and only the two. The four agents are in the join order
  // because they take a hue; an agent is attached rather than admitted and holds no
  // membership, so naming one here would put a row in the participant partition that
  // resolves to a role no daemon granted.
  //
  // The viewer is an owner, which is what makes this scenario able to drive a
  // role-gated control at all: the identity read answers `PARTICIPANT_YOU`, and the
  // role a surface gates on is this entry, looked up in the roster the session read
  // establishes. Priya's `collaborator` is the same value her `membership.created`
  // beat carries — one fact, stated where the roster is read from and replayed
  // where the log records it arriving.
  membershipRoleByParticipantId: {
    [PARTICIPANT_YOU]: "owner",
    [PARTICIPANT_PRIYA]: "collaborator",
  },
  startedAtIso: STARTED_AT_ISO,
  beats: scriptLedgerBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtIso: STARTED_AT_ISO,
    entries: FLAGSHIP_SCRIPT,
  }),
  replies: [
    {
      // `session.read`, not a `session.list`: the registry carries no list method,
      // and a fixture answering one would put a call in front of a surface that
      // has nowhere to send it.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: "2026-01-01T14:20:02.450Z",
        },
        timelineCursors: { latest: "flagship-cursor-45" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: FLAGSHIP_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          // `AgentState` is the four-state lifecycle — `configured` / `ready` /
          // `disabled` / `archived`. A run being in flight is a RUN state and is
          // read from the run, never folded into the agent row.
          state: "ready",
          createdAt: attachedAtIso(agent.attachedAtMs),
        })),
      },
    },
  ],
};
