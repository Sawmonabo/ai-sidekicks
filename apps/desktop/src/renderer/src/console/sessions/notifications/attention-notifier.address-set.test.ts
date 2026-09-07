// When a window may call one of a session's items news, enumerated over the orderings
// the address set actually settles in.
//
// `attention-notifier.test.ts` beside this drives the HISTORY rules — the dedup, the
// audience, the eviction — over a window that has been addressing the same sessions
// throughout. This file drives the set itself, because that set arrives in two moves
// and the emitter used to assume it arrived in one.
//
// THE DEFECT. `SessionAttentionBinding` fans the read out over the node's directory
// merged with this window's own open sessions. A window opened directly on a session
// knows that half at mount and reads the directory's half afterwards, so its first
// settled read covers exactly one session — and a baseline held once for the whole
// window was therefore taken from a read that had never covered any of the others.
// Every session the directory added next arrived already baselined, and its standing
// approvals, waiting input requests, and failed runs were announced as arrivals: OS
// banners for the state of the world, seconds after the console opened.
//
// SO THE ROWS ARE THE ORDERINGS. Each row is a script of settled reads, and each read
// names the sessions its fan-out asked about, the ones that refused, what it carried,
// and what the window may say out loud because of it. Written as data rather than as
// six `it` bodies, because the property is the same in every row and what varies is
// the order — and an enumeration makes an unlisted ordering visible as a missing row.
//
// Every read here is taken by an unfocused window, so the audience rule announces
// whatever it is handed: what these rows measure is the baseline and nothing else.

import { describe, expect, it } from "vitest";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "../../core/index.js";
import { growthUnavailable, type AttentionItem } from "../../bridge/index.js";
import { AttentionPlane, type AnsweredAttentionReading } from "./attention-plane.js";
import { AttentionNotifier, type AttentionNotifierAudience } from "./attention-notifier.js";

/** The session a window was opened directly on. Known before the directory answers. */
const OPENED_SESSION_ID = "session-opened-directly";
/** A session only the node's directory can name, so it joins the read later. */
const DIRECTORY_SESSION_ID = "session-from-the-directory";
/** A third session, used only to push the remembered events over their cap. */
const FILLER_SESSION_ID = "session-filling-the-cap";

/** Nobody is reading this window, so the audience rule withholds nothing. */
const AWAY: AttentionNotifierAudience = {
  activeSessionId: undefined,
  isAttentionSurfaceRouted: false,
  isWindowFocused: false,
};

function itemFor(sessionId: string, id: string): AttentionItem {
  return {
    id,
    sessionId,
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: `event-for-${id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
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
 * The scripted read as the reading a settled fan-out actually produces.
 *
 * Built through the real `AttentionPlane` rather than handed to the notifier as a
 * list, because the plane is what drops resolved items and fixes their order — a
 * hand-built reading would be asserting over a projection this console cannot
 * produce.
 */
function settledRead(script: ScriptedRead): AnsweredAttentionReading {
  return {
    phase: "read",
    plane: new AttentionPlane(script.items),
    droppedCount: 0,
    refusedSessions: (script.refusedSessionIds ?? []).map((sessionId) => ({
      sessionId,
      refusal: growthUnavailable("attentionProjectionRead"),
    })),
    addressedSessionIds: script.addressedSessionIds,
  };
}

/** Play one row's reads through one notifier, checking each read's claim as it goes. */
function playOrdering(reads: readonly ScriptedRead[]): void {
  const notifier = new AttentionNotifier();
  for (const scriptedRead of reads) {
    const announced = notifier
      .arrivalsToAnnounce(settledRead(scriptedRead), AWAY)
      .map((item) => item.id);
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
        // The window is demonstrably announcing at this point, so the silence on the
        // next read is about the session that joined and not about a notifier that
        // had stopped speaking.
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
        // The departed session's event is cleared from the projection, so the cap is
        // free to forget it — and this read hands the cap more than enough to do so.
        // The filler session is itself new, which is why none of it is announced.
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
        // The merge that addresses this read re-derives its array on every settling
        // directory, so the reader and the read holding it are replaced by ones
        // carrying an equal set. The baseline is keyed on the ids and not on the
        // array, so a replacement that asked the same question answers the same way.
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
        // Asked and unanswered is not covered: this window still has not been told
        // what that session holds, so the refusal may not stand in for a baseline.
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
        // Still addressed, so it has not left — and a refusal that dropped its
        // baseline would silence the first thing that arrived once it recovered.
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
    // The over-suppression direction, planted against the row that matters most. The
    // matrix's second read is silent about a session that has only just joined the
    // address set — and a notifier that suppressed every item of a session it had not
    // announced from before would satisfy that row for the wrong reason, and would
    // never say anything about a directory session again.
    //
    // Same item, same audience, same read index. The only difference is that this
    // window had already covered the session when the item appeared.
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
    // The other half of the removal row. That row's last read is silent because the
    // session had left the address set and lost its baseline — not because the cap
    // was somehow still holding the event. Here the same session stays addressed
    // throughout, the cap forgets its cleared event exactly as before, and the item
    // comes back as an arrival: the duplicate banner this cap is allowed to raise.
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
