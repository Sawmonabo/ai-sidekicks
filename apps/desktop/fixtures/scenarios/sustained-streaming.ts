// The sustained-streaming scenario: a session that streams without pause for half an hour.
//
// The session behind the `steady-heap-sustained-streaming` row in `tests/budget/document.json`.
// It plays the long conversation's turns (`composeConversationTurn`) one after another, with
// every beat a fixed step of scenario time after the one before: a person's message, then each
// agent of the cast in turn thinking, replying in several pieces with tool calls and their results
// between them, and ending its turn. A finished run group folds to its receipt, so a reader
// following the live tail sees finished turns scroll away above it while the next one streams,
// and the transcript window lets go of what has gone far enough.
//
// The turns run until the stream has covered half an hour of scenario time, so a run that walks
// the clock over the whole script has watched the session stream for that long.

import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";

import {
  composeScriptBeats,
  findBeatCursor,
  newestBeatInstant,
  type ScriptEntry,
} from "../data/script-entries.js";
import { defineScenario, type Scenario, type ScenarioBeat } from "../scenario.js";
import { composeOpeningEntry } from "../data/opening-entries.js";
import { SESSION_LIST_OPENING_NOTICES, SETTINGS_REPLIES } from "../data/settings-replies.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "../data/workflow/clock.js";
import { CONCURRENT_STREAMING_LEAD, USER_YOU } from "./concurrent-streaming.js";
import { composeConversationTurn } from "./long-conversation.js";

// The session and its id stems. Ids are UUID v7 values whose leading bytes are a fixed instant.
const SESSION_ID = "019b7e90-0280-75e5-8510-ada11a5a33a5";

// The stem row ids are minted from; it differs from `SESSION_ID`, so a row id cannot be rebuilt
// from the session and the sequence.
const EVENT_ID_STEM = "019b7e90-0280-7ea1-8110-e5e0d115";

// The stem every run's id is completed from.
const RUN_ID_STEM = "019b7e90-0280-740e-8110";

const startedAtMs: number = WORKFLOW_FIXTURE_NOW_MS;

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/** How long the session streams, in scenario time: half an hour. */
const STREAMING_SPAN_MS = 30 * 60_000;

/**
 * Scenario time between two beats. A reply arrives in pieces this far apart, so a turn of the
 * four agents lasts under half a minute and finished turns pile up above the reader early in the
 * half hour, long before it ends.
 */
const BEAT_SPACING_MS = 200;

/** Turns one after another, each a beat after the last one ended, until the span is covered. */
function composeStreamingTurns(): readonly ScriptEntry[] {
  const entries: ScriptEntry[] = [];
  let lastAtMs = 0;
  for (let turnIndex = 0; lastAtMs < STREAMING_SPAN_MS; turnIndex += 1) {
    const turn = composeConversationTurn({
      sessionId: SESSION_ID,
      startedAtMs,
      runIdStem: RUN_ID_STEM,
      turnIndex,
      startsAtMs: lastAtMs + BEAT_SPACING_MS,
      beatSpacingMs: BEAT_SPACING_MS,
    });
    entries.push(...turn);
    lastAtMs = turn.at(-1)?.atMs ?? lastAtMs;
  }
  return entries;
}

function composeSustainedStreamingBeats(): readonly ScenarioBeat[] {
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
      ...composeStreamingTurns(),
    ],
  });
}

/** Half an hour of agents' turns streaming and finishing one after another, never pausing. */
export const SUSTAINED_STREAMING_SCENARIO: Scenario = defineScenario(
  {
    id: "sustained-streaming",
    label: "Sustained streaming",
    purpose:
      "A session that streams without pause for half an hour — a person's message, then four " +
      "agents one after another thinking, replying in pieces and calling tools, each turn " +
      "finishing and scrolling away above a reader following the live tail as the next streams in.",
    sessionId: SESSION_ID,
    startedAtIso: STARTED_AT_ISO,
    openingNotices: SESSION_LIST_OPENING_NOTICES,
  },
  () => {
    const beats = composeSustainedStreamingBeats();
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
              createdAt: STARTED_AT_ISO,
              updatedAt: newestBeatInstant(beats),
              draft: "",
              tags: [],
            },
            transcriptCursors: {
              earliest: encodeEventCursor(START_OF_LOG_POSITION),
              latest: findBeatCursor(beats, beats.length - 1),
            },
            // The record a read before any beat lands holds: no run has begun.
            liveRuns: [],
            standingEvents: [],
          },
        },
        ...SETTINGS_REPLIES,
      ],
    };
  },
);
