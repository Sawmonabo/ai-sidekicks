// The named bounds, held to what their own rationales claim.
//
// A constants module looks untestable — the value IS the assertion — and that
// reading is what lets a bound drift into a value its comment no longer describes.
// The checkable content is not the numbers but the RELATIONS between them: several
// of these bounds are only meaningful relative to another, and when the relation
// inverts the mechanism does not fail loudly, it quietly stops existing. A debounce
// at or above its own absolute deadline makes the deadline unreachable; a
// coalescing window wider than the debounce coalesces across the read it feeds; a
// recents cap above the result cap promises rows the list will never render.
//
// So this file states each relation once, next to the reason it holds.
//
// AND IT SITS BESIDE THE HOME RATHER THAN INSIDE ONE OF ITS MODULES, because a
// relation is the one thing about a bound that no single module can hold: the
// announcer's hold window is checked against the store's coalescing frame, and the
// fixture tick against the same frame again. A copy of either case inside each
// module it names would be the second home for a claim that this directory exists
// to keep singular, so the cases live here and reach each declaring module by name.

import { MAX_MESSAGE_BYTES, TIMELINE_READ_LIMIT_MAX } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-caps.js";
import {
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  BASE64_ENCODE_STRIDE_BYTES,
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
} from "./attachment-caps.js";
import {
  DIFF_FILE_LIST_SCROLL_THRESHOLD,
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
  INLINE_DIFF_CARD_HEIGHT_CAP_PX,
} from "./diff-caps.js";
import { SCENARIO_PENDING_REPLY_CAP, SCENARIO_TICK_MS } from "./fixture-caps.js";
import {
  LEDGER_EARLIER_PAGE_ROWS,
  LEDGER_PARKED_LEASE_CAP,
  LEDGER_WINDOW_ROW_CAP,
  REVEAL_CHECKPOINT_TAIL_CAP,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "./ledger-frame-caps.js";
import { CHAPTER_VISIBLE_ROW_CAP, FIND_MATCH_CAP } from "./ledger-structure-caps.js";
import {
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
} from "./live-announcement-caps.js";
import { PALETTE_RECENTS_CAP, PALETTE_RESULT_CAP, WHEN_CLAUSE_MAX_DEPTH } from "./palette-caps.js";
import {
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
} from "./persistence-caps.js";
import { APPLY_COALESCE_MS, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "./refresh-caps.js";
import {
  RESTORE_PATH_ROW_HEIGHT_PX,
  RESTORE_PATH_VIRTUALIZATION_THRESHOLD,
  RESTORE_PATH_VISIBLE_ROW_CAP,
  RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX,
} from "./restore-caps.js";
import {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALISATION_BUFFER_CAP,
} from "./session-store-caps.js";
import { TRIPWIRE_REPORT_CAP } from "./tripwire-caps.js";
import {
  PHASE_GRAPH_MAX_ZOOM,
  PHASE_GRAPH_MIN_ZOOM,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
} from "./workflows-caps.js";

/** Every bound that counts whole things. A fractional or zero cap counts nothing. */
const COUNTING_BOUNDS: readonly (readonly [string, number])[] = [
  ["PERSISTENCE_SESSION_PARTITION_CAP", PERSISTENCE_SESSION_PARTITION_CAP],
  ["PERSISTENCE_RECORD_BYTE_CAP", PERSISTENCE_RECORD_BYTE_CAP],
  ["PALETTE_RECENTS_CAP", PALETTE_RECENTS_CAP],
  ["PALETTE_RESULT_CAP", PALETTE_RESULT_CAP],
  ["WHEN_CLAUSE_MAX_DEPTH", WHEN_CLAUSE_MAX_DEPTH],
  ["TRIPWIRE_REPORT_CAP", TRIPWIRE_REPORT_CAP],
  ["SCENARIO_PENDING_REPLY_CAP", SCENARIO_PENDING_REPLY_CAP],
  ["PRE_INITIALISATION_BUFFER_CAP", PRE_INITIALISATION_BUFFER_CAP],
  ["MAX_REPAIRABLE_SEQUENCE_GAP", MAX_REPAIRABLE_SEQUENCE_GAP],
  ["LIVE_ANNOUNCEMENT_QUEUE_CAP", LIVE_ANNOUNCEMENT_QUEUE_CAP],
  ["ATTACHMENT_BYTE_CAP_DEFAULT", ATTACHMENT_BYTE_CAP_DEFAULT],
  ["ATTACHMENTS_PER_CARRIER_CAP_DEFAULT", ATTACHMENTS_PER_CARRIER_CAP_DEFAULT],
  ["ATTACHMENT_CHUNK_BYTE_CAP", ATTACHMENT_CHUNK_BYTE_CAP],
  ["INGEST_STREAM_LIFETIME_CEILING_MS", INGEST_STREAM_LIFETIME_CEILING_MS],
  ["INGEST_STALL_DISCLOSURE_MS", INGEST_STALL_DISCLOSURE_MS],
  ["BASE64_ENCODE_STRIDE_BYTES", BASE64_ENCODE_STRIDE_BYTES],
  ["ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP", ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP],
  ["DIFF_FILE_LIST_SCROLL_THRESHOLD", DIFF_FILE_LIST_SCROLL_THRESHOLD],
  ["DIFF_INTRALINE_CACHE_ENTRY_CAP", DIFF_INTRALINE_CACHE_ENTRY_CAP],
  ["DIFF_INTRALINE_LINE_CHARACTER_CAP", DIFF_INTRALINE_LINE_CHARACTER_CAP],
  ["DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP", DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP],
  ["INLINE_DIFF_CARD_HEIGHT_CAP_PX", INLINE_DIFF_CARD_HEIGHT_CAP_PX],
  ["RESTORE_PATH_ROW_HEIGHT_PX", RESTORE_PATH_ROW_HEIGHT_PX],
  ["RESTORE_PATH_VIRTUALIZATION_THRESHOLD", RESTORE_PATH_VIRTUALIZATION_THRESHOLD],
  ["RESTORE_PATH_VISIBLE_ROW_CAP", RESTORE_PATH_VISIBLE_ROW_CAP],
  ["RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX", RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX],
  ["WORKFLOW_CANCEL_REASON_BYTE_CAP", WORKFLOW_CANCEL_REASON_BYTE_CAP],
  ["LEDGER_WINDOW_ROW_CAP", LEDGER_WINDOW_ROW_CAP],
  ["LEDGER_EARLIER_PAGE_ROWS", LEDGER_EARLIER_PAGE_ROWS],
  ["LEDGER_PARKED_LEASE_CAP", LEDGER_PARKED_LEASE_CAP],
  ["CHAPTER_VISIBLE_ROW_CAP", CHAPTER_VISIBLE_ROW_CAP],
  ["FIND_MATCH_CAP", FIND_MATCH_CAP],
  ["REVEAL_FRAME_CHARACTER_BUDGET", REVEAL_FRAME_CHARACTER_BUDGET],
  ["REVEAL_CHECKPOINT_TAIL_CAP", REVEAL_CHECKPOINT_TAIL_CAP],
  ["REVEAL_LITERAL_BACKTRACK_CAP", REVEAL_LITERAL_BACKTRACK_CAP],
];

function isWholeCount(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

describe("console bounds — every cap counts whole things", () => {
  for (const [name, value] of COUNTING_BOUNDS) {
    it(`${name} is a positive integer`, () => {
      // Zero disables the mechanism the cap names; a fraction makes "the 8th chip"
      // a comparison no renderer can act on.
      expect(isWholeCount(value), `${name} is ${String(value)}`).toBe(true);
    });
  }

  it("negative control: the predicate rejects the values it is meant to catch", () => {
    // Without this, a predicate that returned true unconditionally would pass every
    // case above over any value at all.
    expect(isWholeCount(0)).toBe(false);
    expect(isWholeCount(-1)).toBe(false);
    expect(isWholeCount(8.5)).toBe(false);
    expect(isWholeCount(Number.NaN)).toBe(false);
  });
});

describe("console bounds — the refresh scheduler's two windows", () => {
  it("keeps the trailing debounce strictly inside the absolute deadline", () => {
    // The scheduler fires at `min(lastEvent + DEBOUNCE, firstEvent + MAX_WAIT)`. At
    // or above the deadline the debounce always wins that `min`, and the starvation
    // guard the deadline exists to be stops existing without any code changing.
    expect(REFRESH_DEBOUNCE_MS).toBeLessThan(REFRESH_MAX_WAIT_MS);
  });

  it("keeps the apply-coalescing window no wider than the debounce", () => {
    // Coalescing folds a burst into one notification for the read the debounce then
    // schedules. A window wider than the debounce would fold across that read, so
    // the render the burst caused would show the state before it.
    expect(APPLY_COALESCE_MS).toBeLessThanOrEqual(REFRESH_DEBOUNCE_MS);
  });

  it("keeps every millisecond bound positive", () => {
    expect(REFRESH_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(REFRESH_MAX_WAIT_MS).toBeGreaterThan(0);
    expect(APPLY_COALESCE_MS).toBeGreaterThan(0);
  });
});

describe("console bounds — the live announcer's hold window", () => {
  it("holds a message for longer than the console calls one frame", () => {
    // A live region whose text is set and reverted inside a frame announces
    // nothing: the observer never sees a settled string. `APPLY_COALESCE_MS` is
    // this console's own name for one frame, so the hold has to sit above it, and
    // the relation is what says so rather than 500 happening to be bigger than 16.
    expect(LIVE_ANNOUNCEMENT_HOLD_MS).toBeGreaterThan(APPLY_COALESCE_MS);
  });
});

describe("console bounds — the palette's two caps describe one list", () => {
  it("does not remember more commands than the list can show", () => {
    // Recents are rendered inside the ranked result list. A recents cap above the
    // result cap would remember rows that are unreachable by construction.
    expect(PALETTE_RECENTS_CAP).toBeLessThanOrEqual(PALETTE_RESULT_CAP);
  });
});

describe("console bounds — the fixture tick names one frame", () => {
  it("is longer than the coalescing window", () => {
    // A tick inside the coalescing window would fold two scenario ticks into one
    // notification, and a frozen tick would stop naming one exact frame — which is
    // the whole property the screenshot target's byte-stability rests on.
    expect(SCENARIO_TICK_MS).toBeGreaterThan(APPLY_COALESCE_MS);
  });

  it("is a whole number of milliseconds, because scripts are expressed in whole ticks", () => {
    expect(Number.isInteger(SCENARIO_TICK_MS)).toBe(true);
  });
});

describe("console bounds — the two sequence bounds describe one store", () => {
  it("repairs a gap at least as wide as the pre-initialisation buffer can shed", () => {
    // A store whose read never lands sheds its oldest buffered events, and the
    // drain re-derives that loss as one gap. At or below the buffer's own cap the
    // ordinary overflow path would report the stream DIVERGED — refusing the very
    // events the buffer kept — so the repairable bound has to sit above it, and
    // the relation is what says so rather than the two numbers happening to.
    expect(MAX_REPAIRABLE_SEQUENCE_GAP).toBeGreaterThan(PRE_INITIALISATION_BUFFER_CAP);
  });
});

describe("console bounds — the storage pressure gauge", () => {
  it("reports pressure before the quota is gone rather than at the moment it is", () => {
    // At 1 the gauge fires only once writing has already failed, which is a report
    // with nothing left to report about; at 0 it is always in pressure and the
    // operator learns to ignore it.
    expect(PERSISTENCE_QUOTA_PRESSURE_RATIO).toBeGreaterThan(0);
    expect(PERSISTENCE_QUOTA_PRESSURE_RATIO).toBeLessThan(1);
  });
});

// --- The bounds that mirror a wire bound ---------------------------------
//
// Four of the five attachment bounds are not this console's decisions at all: the
// daemon enforces them and `Spec-014 §Bounds (normative defaults; operator-tunable)`
// registers each with a default and, for the three tunable ones, the range an
// operator may move it inside. A console copy that drifted LOOSER than its source
// is the failure that matters — it would admit an upload the daemon then refuses,
// spending a participant's bytes to earn a refusal the console could have explained
// first — so each is held to its registered source rather than to itself.

/** One console bound, and the registered range its wire source admits, inclusive. */
const WIRE_MIRRORED_BOUNDS: readonly (readonly [string, number, number, number])[] = [
  // `max_attachment_ingest_bytes`: default 100 MB, operator-tunable 1 MB – 1 GB.
  ["ATTACHMENT_BYTE_CAP_DEFAULT", ATTACHMENT_BYTE_CAP_DEFAULT, 1024 * 1024, 1024 * 1024 * 1024],
  // `max_attachments_per_carrier`: default 10, operator-tunable 1 – 50.
  ["ATTACHMENTS_PER_CARRIER_CAP_DEFAULT", ATTACHMENTS_PER_CARRIER_CAP_DEFAULT, 1, 50],
  // `max_ingest_stream_lifetime`: default 6 h, operator-tunable 1 – 24 h.
  [
    "INGEST_STREAM_LIFETIME_CEILING_MS",
    INGEST_STREAM_LIFETIME_CEILING_MS,
    60 * 60 * 1000,
    24 * 60 * 60 * 1000,
  ],
];

/** Base64 characters an RFC 4648 §4 encoder emits for this many raw bytes. */
function base64Length(decodedByteLength: number): number {
  return Math.ceil(decodedByteLength / 3) * 4;
}

function isInsideRange(value: number, lowest: number, highest: number): boolean {
  return value >= lowest && value <= highest;
}

describe("console bounds — the restore enumerations' four describe one list", () => {
  it("windows only an enumeration longer than the window would show", () => {
    // Below the threshold the whole list is shorter than the container, so windowing
    // would add a scrollbar and a focus stop and remove no node. A threshold at or
    // under the visible-row cap would make the scroll container decorative.
    expect(RESTORE_PATH_VIRTUALIZATION_THRESHOLD).toBeGreaterThan(RESTORE_PATH_VISIBLE_ROW_CAP);
  });

  it("keeps the window shorter than the enumeration that opens it", () => {
    // The height cap is the row height times the visible-row cap, and the point of it
    // is that a threshold-length enumeration does not fit: if it did, the first
    // windowed list would render whole and the window would never be exercised.
    const thresholdListHeightPx =
      RESTORE_PATH_VIRTUALIZATION_THRESHOLD * RESTORE_PATH_ROW_HEIGHT_PX;
    expect(RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX).toBeLessThan(thresholdListHeightPx);
  });
});

describe("console bounds — the intraline diff's two cost bounds", () => {
  it("bounds the pair by more than one admissible line can reach alone", () => {
    // The line cap bounds ONE side; the product cap bounds what the algorithm is
    // actually quadratic in. A product cap at or below the line cap would make the
    // line cap unreachable, so the pair bound would be the only one that ever fired
    // and the per-line rationale would describe nothing.
    expect(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP).toBeGreaterThan(
      DIFF_INTRALINE_LINE_CHARACTER_CAP,
    );
  });

  it("admits a pair of two cap-length lines only if the product allows it", () => {
    // The two bounds are checkable against each other rather than by eye: the widest
    // pair the line cap alone admits is the square of it, and whether that pair is
    // computed is the product cap's answer and not a second reading of the first.
    const widestAdmissiblePair = DIFF_INTRALINE_LINE_CHARACTER_CAP ** 2;
    expect(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP).toBeLessThan(widestAdmissiblePair);
  });
});

describe("console bounds — the attachment bounds against their wire sources", () => {
  for (const [name, value, lowest, highest] of WIRE_MIRRORED_BOUNDS) {
    it(`${name} sits inside the range its wire source admits`, () => {
      expect(isInsideRange(value, lowest, highest), `${name} is ${String(value)}`).toBe(true);
    });
  }

  it("negative control: the range predicate rejects a bound looser than its source", () => {
    // Without this, a predicate that answered true unconditionally would pass every
    // case above over a console cap ten times its registered ceiling.
    expect(isInsideRange(2 * 1024 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024)).toBe(false);
    expect(isInsideRange(0, 1, 50)).toBe(false);
  });

  it("keeps an encoded chunk inside the frame ceiling the wire declares", () => {
    // `max_attachment_chunk_bytes` is fixed rather than tunable because THIS is what
    // fixes it: the wire is JSON with no binary serialization, so a chunk rides as
    // base64 and expands by 4/3, and the framer refuses a declared length over
    // `MAX_MESSAGE_BYTES` before it buffers a body. The relation is what says the
    // chunk cap is right, rather than 512 KiB happening to be smaller than 1 MB.
    expect(base64Length(ATTACHMENT_CHUNK_BYTE_CAP)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it("negative control: the expansion is what the ceiling binds, not the raw length", () => {
    // A raw chunk just under the ceiling fits by the wrong measure and overflows by
    // the right one — which is the whole reason the cap is not simply the ceiling.
    const rawChunkAtTheCeiling = MAX_MESSAGE_BYTES - 1;
    expect(rawChunkAtTheCeiling).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(base64Length(rawChunkAtTheCeiling)).toBeGreaterThan(MAX_MESSAGE_BYTES);
  });

  it("keeps a chunk no larger than the whole payload a stream may carry", () => {
    // A chunk cap above the payload cap would describe a chunk no admissible stream
    // could ever fill, and the bounded slice would stop bounding anything.
    expect(ATTACHMENT_CHUNK_BYTE_CAP).toBeLessThanOrEqual(ATTACHMENT_BYTE_CAP_DEFAULT);
  });

  it("discloses the stream ceiling well before the stream reaches it", () => {
    // The disclosure exists to tell a participant the stream is bounded while there
    // is still time to act. At or above the ceiling it would fire on a stream the
    // daemon has already terminated, which is a disclosure with nothing to disclose.
    expect(INGEST_STALL_DISCLOSURE_MS).toBeLessThan(INGEST_STREAM_LIFETIME_CEILING_MS);
  });
});

describe("console bounds — the phase graph's zoom range", () => {
  it("leaves a range to zoom through", () => {
    // Strictly, not `<=`: an equal pair is a viewport with exactly one scale, which
    // is a graph that answers a zoom gesture by doing nothing. `@xyflow/react` takes
    // both as props and clamps against them, so an inverted pair leaves the graph
    // pinned at one scale with nothing on screen or in a log saying why.
    expect(PHASE_GRAPH_MIN_ZOOM).toBeLessThan(PHASE_GRAPH_MAX_ZOOM);
  });

  it("zooms out from the fitted view and in past it", () => {
    // The fitted view is 1x, and the range is written around it: a floor above 1
    // could not show a long run whole and a ceiling below it could not show a label
    // at reading size. Both halves, because a range entirely on one side of the fit
    // is a range the surface never actually offers.
    expect(PHASE_GRAPH_MIN_ZOOM).toBeLessThan(1);
    expect(PHASE_GRAPH_MAX_ZOOM).toBeGreaterThan(1);
  });
});

describe("console bounds — the ledger's five caps describe one window", () => {
  it("parks exactly one window's worth of leases", () => {
    // `LEDGER_PARKED_LEASE_CAP`'s own rationale states the bound as a RELATION —
    // "parking one window's worth covers a page back and no more" — so the two
    // numbers being equal is the claim, not a coincidence. Above the window's cap it
    // would hold leases for rows a page back cannot reach; below it, paging back one
    // window would find rows that had silently collapsed.
    expect(LEDGER_PARKED_LEASE_CAP).toBe(LEDGER_WINDOW_ROW_CAP);
  });

  it("keeps one chapter's body shorter than the whole retained window", () => {
    // A chapter is one entry INSIDE the window and a nested scroller of its own. At
    // or above the window's cap a single run could mount as many rows as the entire
    // ledger retains, and "scrolling inside a chapter is reading rather than paging"
    // would be describing the ledger rather than the chapter.
    expect(CHAPTER_VISIBLE_ROW_CAP).toBeLessThan(LEDGER_WINDOW_ROW_CAP);
  });

  it("fetches a page the window can hold, and the wire will serve", () => {
    // TWO RELATIONS, and both are the reason this number is not free. At or above the
    // window's row cap one press would deliver a page the cap has to trim before the
    // reader can reach the end of it — the round trip spent on rows nobody sees. And
    // past the wire's own ceiling the request is refused by the contract rather than
    // answered, so the control would offer a walk that never takes a step.
    expect(LEDGER_EARLIER_PAGE_ROWS).toBeLessThan(LEDGER_WINDOW_ROW_CAP);
    expect(LEDGER_EARLIER_PAGE_ROWS).toBeLessThanOrEqual(TIMELINE_READ_LIMIT_MAX);
  });

  it("ranks more matches than the window can hold rows", () => {
    // The find field searches the loaded window, and its own rationale says a
    // one-character query "matches most of it". At or below the window's row cap, a
    // query matching every retained row would be truncated by the cap rather than by
    // the window — so the counter's denominator would understate a set the walk can
    // in fact reach, which is the opposite of the promise that cap exists to keep.
    expect(FIND_MATCH_CAP).toBeGreaterThan(LEDGER_WINDOW_ROW_CAP);
  });
});

describe("console bounds — the reveal engine's three per-frame bounds", () => {
  it("keeps the literal backtrack far inside one frame's published characters", () => {
    // The gate walks back from a candidate ceiling inside the characters this frame
    // is publishing. A backtrack cap at or above the frame budget could walk the
    // whole frame's output, which is exactly the scan its rationale says it "refuses
    // to become".
    expect(REVEAL_LITERAL_BACKTRACK_CAP).toBeLessThan(REVEAL_FRAME_CHARACTER_BUDGET);
  });

  it("retains more than one checkpoint, so the tail is history rather than a latch", () => {
    // A checkpoint re-anchors a commit that arrived out of band. A tail of one holds
    // only the newest, so any commit that is not the newest has nothing to
    // re-anchor against and the retention stops being a tail at all.
    expect(REVEAL_CHECKPOINT_TAIL_CAP).toBeGreaterThan(1);
  });
});
