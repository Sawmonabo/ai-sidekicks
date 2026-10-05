// When a window may call one of a session's items news, over the orderings the address set
// settles in. `attention-notifier.test.ts` covers the history rules; this file
// covers the set itself, which arrives in two moves.
//
// The attention read fans out over the node's directory merged with the window's own open
// sessions. A window opened on one session knows that half at mount and reads the directory's
// half later, so a single window-wide baseline taken from the first read would leave every
// later session already baselined, and its standing approvals would be announced as arrivals.
//
// Each row is a script of settled reads: the sessions asked, the ones that refused, what was
// carried, and what the window may announce.

import { describe, expect, it } from "vitest";

import { refuse } from "#renderer/lib/refusal/refusal.js";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { AttentionSummary, type AnsweredAttentionReading } from "./attention-summary.js";
import { AttentionNotifier } from "./attention-notifier.js";

/** The session a window was opened directly on. Known before the directory answers. */
const OPENED_SESSION_ID = "session-opened-directly";
/** A session only the node's directory can name, so it joins the read later. */
const DIRECTORY_SESSION_ID = "session-from-the-directory";

function itemFor(sessionId: string, id: string): AttentionItem {
  return {
    id,
    momentId: "moment-1",
    sessionId,
    trigger: "pending_approval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    summary: "An approval is waiting.",
    sourceEventId: `event-for-${id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
    bannerState: "pending",
    seen: false,
  };
}

/** One settlement of the fan-out, and what the window is allowed to say about it. */
interface ScriptedRead {
  /** What this read is, in the row's own words. Reported when its claim fails. */
  readonly moment: string;
  readonly addressedSessionIds: readonly string[];
  readonly refusedSessionIds?: readonly string[];
  readonly items: readonly AttentionItem[];
  /** The item ids this read may announce, in order. */
  readonly announces: readonly string[];
}

interface OrderingRow {
  readonly ordering: string;
  readonly reads: readonly ScriptedRead[];
}

/**
 * The scripted read as the reading a settled fan-out produces. Built through the real
 * `AttentionSummary`, which drops resolved items and fixes their order.
 */
function settledRead(script: ScriptedRead): AnsweredAttentionReading {
  return {
    phase: "read",
    summary: new AttentionSummary(script.items),
    droppedCount: 0,
    refusedSessions: (script.refusedSessionIds ?? []).map((sessionId) => ({
      sessionId,
      refusal: refuse(
        "attention-projection",
        "session.not_found",
        "That session is not known to the daemon.",
      ),
    })),
    addressedSessionIds: script.addressedSessionIds,
  };
}

/** Play one row's reads through one notifier, checking each read's claim as it goes. */
function playOrdering(reads: readonly ScriptedRead[]): void {
  const notifier = new AttentionNotifier();
  for (const scriptedRead of reads) {
    const announced = notifier.arrivalsToAnnounce(settledRead(scriptedRead)).map((item) => item.id);
    expect(announced, scriptedRead.moment).toStrictEqual(scriptedRead.announces);
  }
}

const OPENED_STANDING = itemFor(OPENED_SESSION_ID, "opened-standing");
const DIRECTORY_STANDING = itemFor(DIRECTORY_SESSION_ID, "directory-standing");
const DIRECTORY_ARRIVAL = itemFor(DIRECTORY_SESSION_ID, "directory-arrival");

const ORDERING_MATRIX: readonly OrderingRow[] = [
  {
    ordering: "the attention read settles before the directory does",
    reads: [
      {
        moment: "the first read, over the session this window was opened on",
        addressedSessionIds: [OPENED_SESSION_ID],
        items: [OPENED_STANDING],
        announces: [],
      },
      {
        moment: "the directory lands and its session joins the fan-out",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        moment: "something actually arrives in the session that joined",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING, DIRECTORY_ARRIVAL],
        announces: ["directory-arrival"],
      },
    ],
  },
  {
    ordering: "a session refuses on the first read that addresses it",
    reads: [
      {
        // Asked and unanswered is not covered, so the refusal may not stand in for a baseline.
        moment: "the first read, with the joining session refusing",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        refusedSessionIds: [DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING],
        announces: [],
      },
      {
        moment: "the read recovers and carries what was already waiting there",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        moment: "and the recovered session announces its next arrival",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING, DIRECTORY_ARRIVAL],
        announces: ["directory-arrival"],
      },
    ],
  },
  {
    ordering: "a session refuses after it has already been covered",
    reads: [
      {
        moment: "the first read, covering both sessions",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        // Still addressed, so it has not left; dropping its baseline on refusal would silence the
        // first thing that arrived after recovery.
        moment: "one session refuses, without leaving the address set",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        refusedSessionIds: [DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING],
        announces: [],
      },
      {
        moment: "it answers again, and what arrived in the meantime is announced",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING, DIRECTORY_ARRIVAL],
        announces: ["directory-arrival"],
      },
    ],
  },
];

describe("the attention emitter's baseline, per addressed session", () => {
  it.each(ORDERING_MATRIX)("$ordering", ({ reads }) => {
    playOrdering(reads);
  });
});
