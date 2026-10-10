// The long-conversation scenario: a long history of turns, then four lanes streaming at its tail.
//
// The session behind the conversation-scrolling rows in `tests/budget/document.json`. The history
// is long enough that a series of quick flings never reaches its first row, and the four
// concurrent-streaming lanes (`composeConcurrentStreamingLanes`) play after it, so one launch
// scrolls the conversation idle, with the clock stopped at the history's end, or with four lanes
// streaming, with the clock moved on through the lanes.
//
// The history is a number of turns, each a person's message and one run per agent of the
// concurrent-streaming cast. A run thinks, then answers in several replies, each followed by tool
// calls and their results, and ends its turn. Every beat of a history turn lands on one tick, so
// no history run is a streaming lane (`tests/endurance/streaming-lanes.ts`) and only the four
// lanes stream. The turns are composed apart from the session (`composeConversationTurn`), so
// `sustained-streaming.ts` plays the same turns with their beats spaced out.
//
// Assistant and tool payloads describe their body and never carry it, so each beat carries its
// body's media type and UTF-8 length, and the body is stored beside the beat for a read to return
// with its row. The bodies are the markdown and command output such a history holds, composed from
// a fixed set of blocks (prose, headings, lists, quotes, code in several languages, tables, math
// and diagrams), so the transcript draws, and its length-based height estimates see, a real
// conversation's spread.
//
// Determinism is the contract: every identifier, instant, block and length is a function of the
// turn, agent and reply indices alone, so a reading is comparable across runs and machines.

import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
} from "@ai-sidekicks/contracts/session/event-cursor";

import {
  composeScenarioInstant,
  composeScriptBeats,
  createRunEntryBuilders,
  findBeatCursor,
  newestBeatInstant,
  type ScriptEntry,
} from "../data/script-entries.js";
import { defineScenario, type Scenario, type ScenarioBeat } from "../scenario.js";
import { composeOpeningEntry, composeResolvedAgent } from "../data/opening-entries.js";
import { SESSION_LIST_OPENING_NOTICES, SETTINGS_REPLIES } from "../data/settings-replies.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "../data/workflow/clock.js";
import {
  CONCURRENT_STREAMING_AGENTS,
  CONCURRENT_STREAMING_LEAD,
  USER_YOU,
  composeConcurrentStreamingLanes,
} from "./concurrent-streaming.js";
import {
  BODY_BLOCKS,
  CODE_BLOCKS,
  COMMAND_OUTPUT,
  EDIT_OUTPUT,
  PROSE_BLOCKS,
  blockAt,
  bodyOf,
} from "../data/transcript-bodies.js";

// The session and its id stems. Ids are UUID v7 values whose leading bytes are a fixed instant.
const SESSION_ID = "019b7c40-0280-75e5-8510-ada11a5a77a5";

// The stem row ids are minted from; it differs from `SESSION_ID`, so a row id cannot be rebuilt
// from the session and the sequence.
const EVENT_ID_STEM = "019b7c40-0280-7ea1-8110-e5e0d115";

// The stem a history run's id is completed from, apart from the lanes' run ids.
const HISTORY_RUN_ID_STEM = "019b7c40-0280-740e-8110";

// The base instant the lanes' quota reset is measured against, as in the concurrent-streaming
// session, so its countdown is ahead of the clock.
const startedAtMs: number = WORKFLOW_FIXTURE_NOW_MS;

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/** How many turns the history holds: about three thousand rows across four agents. */
const HISTORY_TURN_COUNT = 24;

/** Scenario time between two turns of the history; every beat of a turn shares its tick. */
const HISTORY_TURN_SPACING_MS = 10;

/**
 * Scenario time the history has been delivered by: the last turn's tick. A driver that stops the
 * clock here has the whole history on screen and no lane started.
 */
export const LONG_CONVERSATION_HISTORY_END_MS: number =
  HISTORY_TURN_COUNT * HISTORY_TURN_SPACING_MS;

/** Scenario time the four lanes' own first tick lands at, after the history. */
const LANES_OFFSET_MS = 1_000;

const USER_MESSAGES: readonly string[] = [
  "Split the session store and keep each lane's run moving.",
  "Read the scroll trace again and tell me which frames missed their deadline.",
  "Draw the window cap as a diagram, then make the reader's row keep its place.",
  "Run the endurance tier on the transcript and summarize what changed since the last pass.",
];

const TOOL_NAMES: readonly string[] = ["read_file", "edit_file", "run_command"];

/** One reply's markdown blocks: an optional heading, its prose, then two to five more blocks. */
function replyBlocks(turnIndex: number, agentIndex: number, replyIndex: number): string[] {
  const seed = turnIndex * 7 + agentIndex * 3 + replyIndex * 5;
  const blocks =
    seed % 2 === 0 ? [`## Step ${String(replyIndex + 1)} of turn ${String(turnIndex + 1)}`] : [];
  blocks.push(blockAt(PROSE_BLOCKS, seed));
  const extraBlockCount = 2 + ((turnIndex + agentIndex + replyIndex) % 4);
  for (let extraIndex = 0; extraIndex < extraBlockCount; extraIndex += 1) {
    blocks.push(blockAt(BODY_BLOCKS, seed + extraIndex));
  }
  return blocks;
}

/** What one tool call printed: test output for a command, code for a read, a diff for an edit. */
function toolOutput(toolName: string, seed: number): string {
  if (toolName === "run_command") {
    return COMMAND_OUTPUT;
  }
  return toolName === "read_file" ? blockAt(CODE_BLOCKS, seed) : EDIT_OUTPUT;
}

/** Where one conversation turn plays: its session, its clock, its run ids and its pace. */
export interface ConversationTurnInput {
  readonly sessionId: string;
  /** The instant tick zero stands for, in epoch milliseconds. */
  readonly startedAtMs: number;
  /** The stem the turn's run ids are completed from, apart from its session's other run ids. */
  readonly runIdStem: string;
  /** Which turn of the conversation this is; the first starts every agent but the lead. */
  readonly turnIndex: number;
  /** Scenario time the turn's first beat lands at. */
  readonly startsAtMs: number;
  /** Scenario time between two beats of the turn; zero lands the whole turn on one tick. */
  readonly beatSpacingMs: number;
  /** Whether each run ends with its turn; a run that does not stays live after its last row. */
  readonly endsRuns: boolean;
}

/**
 * One turn of a conversation with the concurrent-streaming cast: the person's message, then a run
 * per agent, one after another, each thinking, replying in several pieces with tool calls and
 * their results after each, and ending its turn where `endsRuns` says. Every identifier, block and
 * length is a function of the turn, agent and reply indices alone.
 */
export function composeConversationTurn(input: ConversationTurnInput): readonly ScriptEntry[] {
  const { sessionId, turnIndex } = input;
  const lane = createRunEntryBuilders(sessionId);
  // Each beat takes the next tick, in the order the beats are composed.
  let composedBeatCount = 0;
  const nextAtMs = (): number => {
    const atMs = input.startsAtMs + composedBeatCount * input.beatSpacingMs;
    composedBeatCount += 1;
    return atMs;
  };
  const entries: ScriptEntry[] = [
    {
      atMs: nextAtMs(),
      kind: "user.message",
      // The payload's actor repeats the envelope's.
      actorId: USER_YOU,
      payload: {
        sessionId,
        actor: USER_YOU,
        message: blockAt(USER_MESSAGES, turnIndex),
      },
    },
  ];
  for (const [agentIndex, agent] of CONCURRENT_STREAMING_AGENTS.entries()) {
    const runId = conversationRunId(input.runIdStem, turnIndex, agentIndex);
    const queuedAtMs = nextAtMs();
    // An agent other than the lead enters the session with its first run, from its saved
    // definition; every later run names it.
    const isAgentsFirstRun = turnIndex === 0 && agent.agentId !== CONCURRENT_STREAMING_LEAD.agentId;
    entries.push(
      lane.transition(runId, {
        atMs: queuedAtMs,
        runVersion: 1,
        newState: "queued",
        actorId: USER_YOU,
        ...(isAgentsFirstRun
          ? {
              resolvedAgent: composeResolvedAgent({
                agent,
                lead: CONCURRENT_STREAMING_LEAD,
                resolvedAt: composeScenarioInstant(input.startedAtMs, queuedAtMs),
              }),
            }
          : { agentId: agent.agentId }),
      }),
      lane.transition(runId, {
        atMs: nextAtMs(),
        runVersion: 2,
        previousState: "queued",
        newState: "starting",
      }),
      lane.transition(runId, {
        atMs: nextAtMs(),
        runVersion: 3,
        previousState: "starting",
        newState: "running",
      }),
      lane.output(runId, {
        atMs: nextAtMs(),
        kind: "assistant.thinking_update",
        contentType: "text/plain",
        body: bodyOf([
          blockAt(PROSE_BLOCKS, turnIndex + agentIndex),
          blockAt(PROSE_BLOCKS, turnIndex + agentIndex + 1),
        ]),
      }),
    );
    const replyCount = 3 + ((turnIndex + agentIndex) % 3);
    for (let replyIndex = 0; replyIndex < replyCount; replyIndex += 1) {
      entries.push(
        lane.output(runId, {
          atMs: nextAtMs(),
          kind: "assistant.message",
          contentType: "text/markdown",
          body: bodyOf(replyBlocks(turnIndex, agentIndex, replyIndex)),
        }),
      );
      const toolCallCount = 2 + ((turnIndex + agentIndex + replyIndex) % 3);
      for (let toolIndex = 0; toolIndex < toolCallCount; toolIndex += 1) {
        const seed = turnIndex + agentIndex + replyIndex + toolIndex;
        const toolName = blockAt(TOOL_NAMES, seed);
        const toolCallId =
          `call-${String(turnIndex)}-${String(agentIndex)}-` +
          `${String(replyIndex)}-${String(toolIndex)}`;
        entries.push(
          lane.tool(runId, { atMs: nextAtMs(), kind: "tool.invoked", toolName, toolCallId }),
          lane.tool(runId, {
            atMs: nextAtMs(),
            kind: "tool.result",
            toolName,
            toolCallId,
            durationMs: 40 + ((seed * 37) % 900),
            body: toolOutput(toolName, seed),
          }),
        );
      }
    }
    // The turn is finished: where runs end, its group is ended rather than live.
    if (input.endsRuns) {
      entries.push(
        lane.transition(runId, {
          atMs: nextAtMs(),
          runVersion: 4,
          previousState: "running",
          newState: "completed",
          completionKind: "turn",
        }),
      );
    }
  }
  return entries;
}

/** A conversation run's id, a function of its stem, turn and agent alone. */
function conversationRunId(runIdStem: string, turnIndex: number, agentIndex: number): string {
  const tail = (turnIndex * CONCURRENT_STREAMING_AGENTS.length + agentIndex).toString(16);
  return `${runIdStem}-${tail.padStart(12, "0")}`;
}

function composeLongConversationBeats(): readonly ScenarioBeat[] {
  return composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtMs,
    entries: [
      composeOpeningEntry({
        sessionId: SESSION_ID,
        shape: "project",
        openedBy: USER_YOU,
        lead: CONCURRENT_STREAMING_LEAD,
        createdAt: STARTED_AT_ISO,
      }),
      ...Array.from({ length: HISTORY_TURN_COUNT }, (_, turnIndex) =>
        composeConversationTurn({
          sessionId: SESSION_ID,
          startedAtMs,
          runIdStem: HISTORY_RUN_ID_STEM,
          turnIndex,
          startsAtMs: (turnIndex + 1) * HISTORY_TURN_SPACING_MS,
          beatSpacingMs: 0,
          endsRuns: true,
        }),
      ).flat(),
      ...composeConcurrentStreamingLanes({
        sessionId: SESSION_ID,
        startedAtMs,
        offsetMs: LANES_OFFSET_MS,
        isAgentsFirstRun: false,
      }),
    ],
  });
}

/** A long history of four agents' turns, then the four concurrent-streaming lanes at its tail. */
export const LONG_CONVERSATION_SCENARIO: Scenario = defineScenario(
  {
    id: "long-conversation",
    label: "Long conversation",
    purpose:
      "A long conversation to scroll through — turns of a person's message and four agents' " +
      "thinking, replies and tool calls, each run finished and folded to its receipt — with " +
      "the four concurrent lanes streaming at its tail once the clock moves past the history.",
    sessionId: SESSION_ID,
    startedAtIso: STARTED_AT_ISO,
    openingNotices: SESSION_LIST_OPENING_NOTICES,
  },
  () => {
    const beats = composeLongConversationBeats();
    return {
      beats,
      replies: [
        {
          // The frame's read is `session.read`; nothing in the renderer calls `session.list`.
          call: "session.read",
          result: {
            session: {
              id: SESSION_ID,
              state: "active",
              shape: "project",
              muted: false,
              pendingWorkingFolder: null,
              createdAt: STARTED_AT_ISO,
              updatedAt: newestBeatInstant(beats),
              draft: "",
              tags: [],
            },
            transcriptCursors: {
              earliest: encodeEventCursor(START_OF_LOG_POSITION),
              latest: findBeatCursor(beats, beats.length - 1),
            },
            liveRuns: [],
            standingEvents: [],
          },
        },
        ...SETTINGS_REPLIES,
      ],
    };
  },
);
