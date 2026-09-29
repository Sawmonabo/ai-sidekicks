// The bounds whose checks span more than one owner: every cap counts whole things, and
// the relations between one owner's cap and another's. A relation inside one owner's caps
// sits beside those caps.

import {
  ATTACHMENT_INGEST_CHUNK_MAX_BYTES,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-caps.js";
import {
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  BASE64_ENCODE_STRIDE_BYTES,
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
} from "@renderer/features/composer/attachments/attachment-caps.js";
import {
  DIFF_FILE_LIST_SCROLL_THRESHOLD,
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
  INLINE_DIFF_CARD_HEIGHT_CAP_PX,
} from "@renderer/features/repos/diff-caps.js";
import {
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
} from "@renderer/services/daemon/engine.fixture.js";
import {
  LEDGER_EARLIER_PAGE_ROWS,
  LEDGER_PARKED_LEASE_CAP,
  LEDGER_WINDOW_ROW_CAP,
  REVEAL_CHECKPOINT_TAIL_CAP,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "@renderer/features/transcript/frame/frame-caps.js";
import {
  CHAPTER_VISIBLE_ROW_CAP,
  FIND_MATCH_CAP,
} from "@renderer/features/transcript/structure/structure-caps.js";
import {
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
} from "@renderer/components/LiveAnnouncer/live-announcement-caps.js";
import { PALETTE_RECENTS_CAP, PALETTE_RESULT_CAP, WHEN_CLAUSE_MAX_DEPTH } from "./palette-caps.js";
import {
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
} from "./persistence-caps.js";
import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALISATION_BUFFER_CAP,
} from "@renderer/store/session/session-store-caps.js";
import { TRIPWIRE_REPORT_CAP } from "@renderer/lib/tripwire-caps.js";

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
  ["ATTACHMENT_INGEST_CHUNK_MAX_BYTES", ATTACHMENT_INGEST_CHUNK_MAX_BYTES],
  ["INGEST_STREAM_LIFETIME_CEILING_MS", INGEST_STREAM_LIFETIME_CEILING_MS],
  ["INGEST_STALL_DISCLOSURE_MS", INGEST_STALL_DISCLOSURE_MS],
  ["BASE64_ENCODE_STRIDE_BYTES", BASE64_ENCODE_STRIDE_BYTES],
  ["ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP", ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP],
  ["DIFF_FILE_LIST_SCROLL_THRESHOLD", DIFF_FILE_LIST_SCROLL_THRESHOLD],
  ["DIFF_INTRALINE_CACHE_ENTRY_CAP", DIFF_INTRALINE_CACHE_ENTRY_CAP],
  ["DIFF_INTRALINE_LINE_CHARACTER_CAP", DIFF_INTRALINE_LINE_CHARACTER_CAP],
  ["DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP", DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP],
  ["INLINE_DIFF_CARD_HEIGHT_CAP_PX", INLINE_DIFF_CARD_HEIGHT_CAP_PX],
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

describe("console bounds — the attachment chunk against the payload", () => {
  it("keeps a chunk no larger than the whole payload a stream may carry", () => {
    // A chunk cap above the payload cap would describe a chunk no admissible stream
    // could ever fill, and the bounded slice would stop bounding anything.
    expect(ATTACHMENT_INGEST_CHUNK_MAX_BYTES).toBeLessThanOrEqual(ATTACHMENT_BYTE_CAP_DEFAULT);
  });
});
