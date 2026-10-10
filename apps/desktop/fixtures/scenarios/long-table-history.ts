// The long-table-history scenario: a reply holding a long markdown table, at the head of a long
// history of turns behind it.
//
// The session behind the `transcript-read-back-longest-task` row in `tests/budget/document.json`.
// Opened at its tail, it holds only the newest rows; a reader going back to its first message
// reads the rest back page after page, through the long conversation's turns
// (`composeConversationTurn`) and last the page holding the table's reply. Every beat of a turn
// lands on one tick, so nothing streams.
//
// The table's reply carries its body on its beat, as the daemon stores it beside the event. The
// body is too large to travel with its row, so a `transcript.read` row hands back its size, and the
// table, drawn as a window over its rows, lands when the reader asks for the full body.
// Determinism is the contract: every identifier, instant and cell is a function of the turn, agent,
// reply and row indices alone.

import {
  composeScriptBeats,
  createRunEntryBuilders,
  newestBeatInstant,
  type ScriptEntry,
} from "../data/script-entries.js";
import { defineScenario, type Scenario, type ScenarioBeat } from "../scenario.js";
import { composeOpeningEntry } from "../data/opening-entries.js";
import { SESSION_LIST_OPENING_NOTICES, SETTINGS_REPLIES } from "../data/settings-replies.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "../data/workflow/clock.js";
import { CONCURRENT_STREAMING_LEAD, USER_YOU } from "./concurrent-streaming.js";
import { composeConversationTurn } from "./long-conversation.js";
import { sessionReadReply } from "../data/session-record.js";

// The session and its id stems. Ids are UUID v7 values whose leading bytes are a fixed instant.
const SESSION_ID = "019b7f20-0280-75e5-8510-ada11a5a99a5";

// The stem row ids are minted from; it differs from `SESSION_ID`, so a row id cannot be rebuilt
// from the session and the sequence.
const EVENT_ID_STEM = "019b7f20-0280-7ea1-8110-e5e0d115";

// The stem every turn's run id is completed from, and the table's own run.
const RUN_ID_STEM = "019b7f20-0280-740e-8110";
const TABLE_RUN_ID = `${RUN_ID_STEM}-7ab1e0000000`;

const startedAtMs: number = WORKFLOW_FIXTURE_NOW_MS;

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/** How many rows the table holds below its head row. */
export const LONG_TABLE_BODY_ROW_COUNT = 800;

/** How many turns follow the table: about eighteen hundred rows across four agents. */
const HISTORY_TURN_COUNT = 14;

/** Scenario time between two turns; every beat of a turn shares its tick. */
const TURN_SPACING_MS = 10;

/** Scenario time the table's reply lands at, the history's first tick. */
const TABLE_AT_MS = TURN_SPACING_MS;

/**
 * Scenario time the whole history has been delivered by: the last turn's tick. A driver that
 * moves the clock here before opening the session has the session read its newest rows only.
 */
export const LONG_TABLE_HISTORY_END_MS: number = (HISTORY_TURN_COUNT + 1) * TURN_SPACING_MS;

/** The person's message the table answers: the session's first message. */
export const LONG_TABLE_REQUEST =
  "List every lane of the last run, one row each, with its state and timing.";

/** The line the table's reply says first. */
const TABLE_LEAD_IN = "The lanes as they stood when the run ended, one row each.";

/** The table's head and delimiter lines. */
const TABLE_HEAD: readonly string[] = [
  "| Lane | State | Rows | p95 (ms) | Note |",
  "| :-- | --- | ---: | ---: | --- |",
];

/** One body row of the table: a lane, its state, its figures and a note with inline markup. */
function tableRow(index: number): string {
  return (
    `| lane-${String(index)} | ${index % 7 === 0 ? "waiting" : "running"} | ` +
    `${String(index * 7)} | ${(index * 0.13).toFixed(2)} | ` +
    `keeps **the reader** in place with \`code\` ${String(index)} |`
  );
}

/** The table's reply: a line of prose, the table, and a closing line. */
function tableBody(): string {
  return [
    TABLE_LEAD_IN,
    [
      ...TABLE_HEAD,
      ...Array.from({ length: LONG_TABLE_BODY_ROW_COUNT }, (_, index) => tableRow(index)),
    ].join("\n"),
    "Every lane above finished in place.",
  ].join("\n\n");
}

/** The person's request, and the lead's run answering it with the table. */
function composeTableTurn(): readonly ScriptEntry[] {
  const lane = createRunEntryBuilders(SESSION_ID);
  return [
    {
      atMs: TABLE_AT_MS,
      kind: "user.message",
      // The payload's actor repeats the envelope's.
      actorId: USER_YOU,
      payload: { sessionId: SESSION_ID, actor: USER_YOU, message: LONG_TABLE_REQUEST },
    },
    lane.transition(TABLE_RUN_ID, {
      atMs: TABLE_AT_MS,
      runVersion: 1,
      newState: "queued",
      actorId: USER_YOU,
      agentId: CONCURRENT_STREAMING_LEAD.agentId,
    }),
    lane.transition(TABLE_RUN_ID, {
      atMs: TABLE_AT_MS,
      runVersion: 2,
      previousState: "queued",
      newState: "starting",
    }),
    lane.transition(TABLE_RUN_ID, {
      atMs: TABLE_AT_MS,
      runVersion: 3,
      previousState: "starting",
      newState: "running",
    }),
    lane.output(TABLE_RUN_ID, {
      atMs: TABLE_AT_MS,
      kind: "assistant.message",
      contentType: "text/markdown",
      body: tableBody(),
    }),
    lane.transition(TABLE_RUN_ID, {
      atMs: TABLE_AT_MS,
      runVersion: 4,
      previousState: "running",
      newState: "completed",
      completionKind: "turn",
    }),
  ];
}

function composeLongTableHistoryBeats(): readonly ScenarioBeat[] {
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
      ...composeTableTurn(),
      ...Array.from({ length: HISTORY_TURN_COUNT }, (_, turnIndex) =>
        composeConversationTurn({
          sessionId: SESSION_ID,
          startedAtMs,
          runIdStem: RUN_ID_STEM,
          turnIndex,
          startsAtMs: TABLE_AT_MS + (turnIndex + 1) * TURN_SPACING_MS,
          beatSpacingMs: 0,
          endsRuns: true,
        }),
      ).flat(),
    ],
  });
}

/** A reply holding a long table, then a long history of four agents' turns behind it. */
export const LONG_TABLE_HISTORY_SCENARIO: Scenario = defineScenario(
  {
    id: "long-table-history",
    label: "Long table in history",
    purpose:
      "A long conversation whose first reply is a table of eight hundred lanes — opened at its " +
      "tail, the history is read back page after page as the reader goes back to the first " +
      "message, and the table is drawn as a window over its rows.",
    sessionId: SESSION_ID,
    startedAtIso: STARTED_AT_ISO,
    openingNotices: SESSION_LIST_OPENING_NOTICES,
  },
  () => {
    const beats = composeLongTableHistoryBeats();
    return {
      beats,
      replies: [
        sessionReadReply({
          sessionId: SESSION_ID,
          state: "active",
          shape: "project",
          createdAt: STARTED_AT_ISO,
          updatedAt: newestBeatInstant(beats),
          beats,
        }),
        ...SETTINGS_REPLIES,
      ],
    };
  },
);
