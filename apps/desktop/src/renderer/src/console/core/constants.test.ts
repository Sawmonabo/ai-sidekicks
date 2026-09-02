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

import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  APPLY_COALESCE_MS,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
  BASE64_ENCODE_STRIDE_BYTES,
  CAST_BAR_CHIP_CAP,
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PRE_INITIALISATION_BUFFER_CAP,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
  TRIPWIRE_REPORT_CAP,
  WHEN_CLAUSE_MAX_DEPTH,
} from "./constants.js";

/** Every bound that counts whole things. A fractional or zero cap counts nothing. */
const COUNTING_BOUNDS: readonly (readonly [string, number])[] = [
  ["PERSISTENCE_SESSION_PARTITION_CAP", PERSISTENCE_SESSION_PARTITION_CAP],
  ["PERSISTENCE_RECORD_BYTE_CAP", PERSISTENCE_RECORD_BYTE_CAP],
  ["PALETTE_RECENTS_CAP", PALETTE_RECENTS_CAP],
  ["PALETTE_RESULT_CAP", PALETTE_RESULT_CAP],
  ["WHEN_CLAUSE_MAX_DEPTH", WHEN_CLAUSE_MAX_DEPTH],
  ["CAST_BAR_CHIP_CAP", CAST_BAR_CHIP_CAP],
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
