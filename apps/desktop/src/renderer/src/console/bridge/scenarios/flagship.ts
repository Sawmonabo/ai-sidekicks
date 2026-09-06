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
//   • An approval lands MID-STREAM, in four beats: the request, the implementer's run
//     entering `waiting_for_approval` while the other three keep talking, the grant,
//     and the return through `running`.
//   • A lane PARKS. A provider quota reading lands at 100% with the instant it resets
//     at, and the scout's run suspends on it — so the frame carries a park with a
//     countdown, and three lanes still streaming beside it.
//   • The cost meter moves, four times, one per lane, and the session read answers the
//     accountant's committed figure — the past-tense receipt of everything above.
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
//   • **A provider switch.** `agent.provider_switched` and
//     `agent.provider_switch_failed` are registered in the taxonomy and are NOT in
//     this workspace's `SessionEventType` census: the union under
//     `// SessionEventType — the canonical event-type census` in
//     `packages/contracts/src/event.ts` says so in its own words, registering the
//     post-B18 156 and naming the two as a widening that has not landed. A beat for
//     one would fail the census leg of the wire-truth predicate, and a screenshot of
//     it would be a frame of a wire that does not exist. The seam a switch would draw
//     is therefore absent from this composition by the same rule every other absence
//     here follows, and it arrives the day that union does.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.
//   • **A link TYPE on the run thread.** `linkType` is typed by a Plan-016 symbol no
//     TypeScript in this workspace declares, so the thread carries the two linkage
//     members that do have types — `parentRunId` and `internalHelper` — and says
//     nothing about which kind of link it is.
//
// AND ONE IT USED TO REFUSE AND NO LONGER DOES. This header once declined the
// `approval.*` pair on the ground that scripting it beside the run-state pair "would
// put two records of one approval in one session". Re-read against the contract, that
// is not what the two pairs are: `approval_flow` records WHAT was asked, by whom, over
// what resource, and who granted it, and `run_lifecycle` records what the RUN did
// about it. Neither is derivable from the other — a run can block on an ask nobody
// answers, and an approval can be granted for a run that has already ended — so a
// session carrying only the run pair leaves the approvals surface nothing to render,
// which is the state this scenario was in.
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
          // The display title, which is metadata a session HAPPENS to carry: no
          // registered session shape has a first-class name field, and
          // `session.created` is `.strict()` with no title member at all. So the
          // console reads one from here or renders the session by its identifier.
          metadata: { title: "Ship the ledger" },
          createdAt: STARTED_AT_ISO,
          updatedAt: "2026-01-01T14:20:02.450Z",
        },
        timelineCursors: { latest: "flagship-cursor-45" },
      },
    },
    {
      // The node's health, which is a MEASUREMENT and so is scripted rather than
      // folded out of beats: nothing in a session's log says whether the node's
      // storage is healthy. Two components, one of them not — so the cast bar's
      // compact mark has something to say, and the mark's own absence when
      // everything is healthy is still reachable from any other scenario.
      call: "health.statusRead",
      result: {
        overall: "degraded",
        components: [
          { component: "session-store", state: "healthy", observedAt: STARTED_AT_ISO },
          { component: "relay", state: "degraded", observedAt: STARTED_AT_ISO },
        ],
      },
    },
    {
      // The handshake this window's shell performed, which is an OBSERVATION of two
      // builds meeting and so is scripted rather than folded out of beats: nothing in
      // a session's log says which protocol the runtime agreed to.
      //
      // The AGREEING arm, deliberately. This is the composition a first launch opens
      // into, and a scripted disagreement would put a refusal across a demonstration
      // window every time — a claim about the operator's own install that no author
      // made. The refusing arm is reachable from any scenario that scripts one, and
      // the version mark's own suites drive it directly.
      call: "daemon.hello",
      result: {
        compatible: true,
        consoleProtocolVersion: "2026-05-01",
        daemonProtocolVersion: "2026-05-01",
        daemonSupportedProtocols: ["2026-05-01"],
      },
    },
    {
      // The accountant's own committed figure — the ONE source of a spend number for
      // every surface, and the reason the cast bar sums nothing. `priced` because
      // every debit this session's four lanes raised was priced; the unpriced arm is
      // a different session's story and a different scenario's to tell.
      call: "orchestration.budgetRead",
      result: {
        sessionId: SESSION_ID,
        costLimitCents: 500_00,
        turnLimitPerAgent: 40,
        maxExecutingChannels: 4,
        maxQueueDepthPerChannel: 8,
        maxPendingOrchestrationRuns: 4,
        activeChildLimit: 2,
        unpricedFamilyCaps: [],
        // The decomposition is arithmetic the DAEMON did, mirrored here exactly:
        // priced plus unpriced is observed, and observed plus reserved is the
        // committed figure. A scenario whose members did not add up would teach a
        // surface that the identity does not hold.
        observedCostCents: 9_47,
        reservedCostCents: 3_00,
        observedPricedCostCents: 9_47,
        observedUnpricedDebitCents: 0,
        committedSpendCents: 12_47,
        costStatus: "priced",
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
