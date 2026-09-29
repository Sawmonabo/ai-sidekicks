// The attachment bounds, held to their registered wire sources and to each other.
//
// Three of them are not the renderer's decisions at all: the daemon enforces them, and the
// wire registers each with a default and the range an operator may move it inside. A copy
// that drifted LOOSER than its source is the failure that matters — it would admit an upload
// the daemon then refuses, spending a person's bytes to earn a refusal the renderer could
// have explained first — so each is held to its registered source rather than to itself.

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
} from "./attachment-caps.js";

/** One bound, and the registered range its wire source admits, inclusive. */
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

function isInsideRange(value: number, lowest: number, highest: number): boolean {
  return value >= lowest && value <= highest;
}

describe("attachment caps — against their wire sources", () => {
  for (const [name, value, lowest, highest] of WIRE_MIRRORED_BOUNDS) {
    it(`${name} sits inside the range its wire source admits`, () => {
      expect(isInsideRange(value, lowest, highest), `${name} is ${String(value)}`).toBe(true);
    });
  }

  it("negative control: the range predicate rejects a bound looser than its source", () => {
    // Without this, a predicate that answered true unconditionally would pass every
    // case above over a cap ten times its registered ceiling.
    expect(isInsideRange(2 * 1024 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024)).toBe(false);
    expect(isInsideRange(0, 1, 50)).toBe(false);
  });

  it("discloses the stream ceiling well before the stream reaches it", () => {
    // The disclosure exists to tell a person the stream is bounded while there
    // is still time to act. At or above the ceiling it would fire on a stream the
    // daemon has already terminated, which is a disclosure with nothing to disclose.
    expect(INGEST_STALL_DISCLOSURE_MS).toBeLessThan(INGEST_STREAM_LIFETIME_CEILING_MS);
  });
});
