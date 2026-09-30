// When a window may call one of a session's items news, enumerated over the orderings the
// address set settles in. `attention-notifier.test.ts` covers the history rules; this file
// covers the set itself, which arrives in two moves.
//
// The attention read fans out over the node's directory merged with the window's own open
// sessions. A window opened on one session knows that half at mount and reads the directory's
// half later, so a single window-wide baseline taken from the first read would leave every
// later session already baselined, and its standing approvals would be announced as arrivals.
//
// Each row is a script of settled reads: the sessions asked, the ones that refused, what was
// carried, and what the window may announce. Rows as data make an unlisted ordering visible
// as a missing row.

import { describe, expect, it } from "vitest";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "./attention-notifier.js";
import { refuse } from "@renderer/lib/refusal.js";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { AttentionSummary, type AnsweredAttentionReading } from "./attention-summary.js";
import { AttentionNotifier } from "./attention-notifier.js";

/** The session a window was opened directly on. Known before the directory answers. */
const OPENED_SESSION_ID = "session-opened-directly";
/** A session only the node's directory can name, so it joins the read later. */
const DIRECTORY_SESSION_ID = "session-from-the-directory";
/** A third session, used only to push the remembered events over their cap. */
const FILLER_SESSION_ID = "session-filling-the-cap";

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
const OPENED_ARRIVAL = itemFor(OPENED_SESSION_ID, "opened-arrival");
const DIRECTORY_STANDING = itemFor(DIRECTORY_SESSION_ID, "directory-standing");
const DIRECTORY_ARRIVAL = itemFor(DIRECTORY_SESSION_ID, "directory-arrival");
/** Enough cleared events to push the remembered set past its cap in one read. */
const CAP_FILLERS: readonly AttentionItem[] = Array.from(
  { length: ATTENTION_NOTIFIED_ITEM_CAP + 1 },
  (_unused, index) => itemFor(FILLER_SESSION_ID, `filler-${String(index)}`),
);

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
    ordering: "the directory settles before the first attention read",
    reads: [
      {
        moment: "the first read, already covering both sessions",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        moment: "an arrival in either session, once both are baselined",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING, OPENED_ARRIVAL, DIRECTORY_ARRIVAL],
        announces: ["opened-arrival", "directory-arrival"],
      },
    ],
  },
  {
    ordering: "a session joins the address set long after the window went live",
    reads: [
      {
        moment: "the first read, over one session with nothing waiting",
        addressedSessionIds: [OPENED_SESSION_ID],
        items: [],
        announces: [],
      },
      {
        // The window is announcing here, so silence on the next read is about the joined session,
        // not a notifier that stopped speaking.
        moment: "an ordinary arrival, proving this window is not simply silent",
        addressedSessionIds: [OPENED_SESSION_ID],
        items: [OPENED_ARRIVAL],
        announces: ["opened-arrival"],
      },
      {
        moment: "a session joins, carrying items that were already waiting in it",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_ARRIVAL, DIRECTORY_STANDING],
        announces: [],
      },
      {
        moment: "and the session that joined announces its next arrival",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_ARRIVAL, DIRECTORY_STANDING, DIRECTORY_ARRIVAL],
        announces: ["directory-arrival"],
      },
    ],
  },
  {
    ordering: "a session leaves the address set and comes back",
    reads: [
      {
        moment: "the first read, over both sessions",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        // The departed session's event is cleared, so the cap may forget it, and this read hands
        // the cap more than enough to do so. The filler session is itself new, so none of it is
        // announced.
        moment: "the session drops out while the remembered events are pushed past the cap",
        addressedSessionIds: [OPENED_SESSION_ID, FILLER_SESSION_ID],
        items: [OPENED_STANDING, ...CAP_FILLERS],
        announces: [],
      },
      {
        moment: "it rejoins, carrying the same item the cap has since forgotten",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID, FILLER_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING, ...CAP_FILLERS],
        announces: [],
      },
    ],
  },
  {
    ordering: "both readers are superseded and the same projection settles again",
    reads: [
      {
        moment: "the first read over both sessions",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        // The merge that addresses this read re-derives its array on every settling directory, so
        // the reader is replaced by one carrying an equal set. The baseline is keyed on the ids,
        // not the array, so the answer is the same.
        moment: "the rebuilt read asks the same question in a different order",
        addressedSessionIds: [DIRECTORY_SESSION_ID, OPENED_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        moment: "and the rebuilt read still announces what arrives after it",
        addressedSessionIds: [DIRECTORY_SESSION_ID, OPENED_SESSION_ID],
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

  it("negative control: the same item announces when its session was addressed all along", () => {
    // The over-suppression direction. The matrix's second read is silent about a session that
    // just joined the address set, and a notifier that suppressed every item of an unannounced
    // session would satisfy that row for the wrong reason. Same item, same read index; the only
    // difference is that this window had already covered the session.
    playOrdering([
      {
        moment: "the first read covers both sessions, with nothing waiting",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [],
        announces: [],
      },
      {
        moment: "the same item, in a session this window had already covered",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [DIRECTORY_STANDING],
        announces: ["directory-standing"],
      },
    ]);
  });

  it("negative control: the cap forgets an item of a session that never left", () => {
    // The other half of the removal row, whose last read is silent because the session lost its
    // baseline, not because the cap still held the event. Here the session stays addressed, the
    // cap forgets its cleared event, and the item returns as an arrival: the duplicate banner
    // this cap may raise.
    playOrdering([
      {
        moment: "the first read, over both sessions",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING],
        announces: [],
      },
      {
        moment: "the session stays addressed while its event is pushed past the cap",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID, FILLER_SESSION_ID],
        items: [OPENED_STANDING, ...CAP_FILLERS],
        announces: [],
      },
      {
        moment: "and the forgotten event is announced again, baseline intact",
        addressedSessionIds: [OPENED_SESSION_ID, DIRECTORY_SESSION_ID, FILLER_SESSION_ID],
        items: [OPENED_STANDING, DIRECTORY_STANDING, ...CAP_FILLERS],
        announces: ["directory-standing"],
      },
    ]);
  });
});
