// Who is composing where, and which runs are working where, as the room reads over
// scenario time. Without these frames every indicator in the console renders its
// empty state permanently — which is the state the registry was in until it had a
// producer at all — and a screenshot of a room with people in it shows a room where
// nothing is happening.
//
// TWO FRAMES, BECAUSE ONE COULD ONLY SHOW A STILL. The first is the room mid-
// conversation; the second is what it looks like a moment later, and the difference
// between them is what the fold has to get right: Priya's `since` MOVES, which is a
// publisher still typing and the only thing that re-arms the receiver's clear, and
// Tomas simply leaves, which is the stop. A frame that repeated Priya's reading
// unchanged would be the same publication read twice, and treating that as a
// refresh is the failure the receiver-timed bound exists to prevent.
//
// TOMAS IS `reconnecting` AND IS TYPING, which is not a contradiction and is here
// because it looks like one: composing rides beside presence rather than inside it,
// so a person on a flaky connection is still writing a sentence.
//
// THE AGENT RUN NAMES A RUN THIS LOG HAS NOT CARRIED. This session attaches no
// agent, and the run below belongs to a peer's machine — one of the three in
// `collaboration-runtime-nodes.js` — whose `run.*` beats have not reached this
// console. That is not a shape the wire cannot produce; it is the case
// `sessionProjectionLabels.runLabel` has an id fallback FOR, and a fixture whose
// every indicator resolved to a name would leave that arm unreachable.

import {
  CHANNEL_MAIN,
  CHANNEL_REVIEW,
  PARTICIPANT_PRIYA,
  PARTICIPANT_TOMAS,
  PEER_RUN_ID,
} from "./collaboration.identifiers.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** The frames the composing and agent-run indicators are read from. */
export const COLLABORATION_ACTIVITY: NonNullable<ConsoleScenario["activity"]> = [
  {
    atMs: 0,
    activity: {
      composing: [
        {
          participantId: PARTICIPANT_PRIYA,
          channelId: CHANNEL_MAIN,
          since: "2026-01-01T10:04:58.000Z",
        },
        {
          participantId: PARTICIPANT_TOMAS,
          channelId: CHANNEL_REVIEW,
          since: "2026-01-01T10:04:59.000Z",
        },
      ],
      agentRuns: [
        {
          runId: PEER_RUN_ID,
          channelId: CHANNEL_REVIEW,
          since: "2026-01-01T10:04:30.000Z",
        },
      ],
    },
  },
  {
    atMs: 500,
    activity: {
      composing: [
        {
          participantId: PARTICIPANT_PRIYA,
          channelId: CHANNEL_MAIN,
          since: "2026-01-01T10:05:00.500Z",
        },
      ],
      agentRuns: [
        {
          runId: PEER_RUN_ID,
          channelId: CHANNEL_REVIEW,
          since: "2026-01-01T10:04:30.000Z",
        },
      ],
    },
  },
];
