// What the terminal scenario ANSWERS, as opposed to what it plays.
//
// Split out of `terminal.ts` because these are request/response canned replies and
// the beats are a broadcast script: nothing about the roster's node row belongs in
// the middle of a hand-off sequence, and the one reply that carries a long
// explanation of a not-yet-compiled member was the largest thing standing between a
// reader and the transitions.

import type { ScenarioReply } from "../scenario.js";
import {
  TERMINAL_HOST_NODE_ATTACHED_AT_MS,
  TERMINAL_HOST_NODE_LAST_HEARTBEAT_AT_MS,
  terminalScenarioInstantAt,
} from "./terminal-beats.js";
import {
  TERMINAL_HOST_NODE_ID,
  TERMINAL_SCENARIO_CAST,
  TERMINAL_SCENARIO_SESSION_ID,
} from "./terminal-cast.js";

/**
 * How long the roster read takes, in scenario time.
 *
 * 8.8's loading state, scripted rather than described: "the pane attaches with
 * scrollback and the claim control settles last". The claim control settles last
 * precisely because it waits on the holder projection, so the roster read is the one
 * that arrives late. The frozen clock is the only clock, so a caller advances the
 * engine past this tick to settle it.
 */
const ROSTER_READ_LATENCY_MS = 260;

export const TERMINAL_SCENARIO_REPLIES: readonly ScenarioReply[] = [
  { call: "session.list", result: { sessions: [{ sessionId: TERMINAL_SCENARIO_SESSION_ID }] } },
  { call: "agent.list", result: { agents: [{ agentId: TERMINAL_SCENARIO_CAST.agent }] } },
  {
    call: "runtimenode.roster",
    afterMs: ROSTER_READ_LATENCY_MS,
    result: {
      // The projection the design's wire table grades "CP-LIVE query, FIXTURE
      // field". `runtimenode.roster` is a registered control-plane procedure and
      // `RuntimeNodeRosterResponse.controlHolder` is specified in
      // `docs/architecture/contracts/api-payload-contracts.md §Session
      // Terminal-Control Method Registry` — but the SHIPPED `.strict()` schema
      // in `packages/contracts` carries `nodes` alone, because the lease's
      // projection extension ships with the Plan-024 lease leg. So this reply
      // is the specified shape and not yet the compiled one, which is exactly
      // what the FIXTURE grading records; the member leaves this file when that
      // leg lands and the console reads it off the type.
      controlHolder: TERMINAL_SCENARIO_CAST.owner,
      nodes: [
        {
          nodeId: TERMINAL_HOST_NODE_ID,
          participantId: TERMINAL_SCENARIO_CAST.owner,
          state: "online",
          healthState: "online",
          lastHeartbeatAt: terminalScenarioInstantAt(TERMINAL_HOST_NODE_LAST_HEARTBEAT_AT_MS),
          readOnly: false,
          capabilities: {},
          clientVersion: "1.0",
          attachedAt: terminalScenarioInstantAt(TERMINAL_HOST_NODE_ATTACHED_AT_MS),
        },
      ],
    },
  },
];
