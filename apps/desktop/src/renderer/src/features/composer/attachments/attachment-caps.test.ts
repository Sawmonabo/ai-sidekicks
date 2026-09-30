// The stream ceiling is the daemon's, registered on the wire with a default and an operator
// range. A copy drifting looser than its source would promise a stream the daemon then ends, so
// it is held to the registered range.

import { describe, expect, it } from "vitest";

import {
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
} from "./attachment-caps.js";

/** One bound, and the registered range its wire source admits, inclusive. */
const WIRE_MIRRORED_BOUNDS: readonly (readonly [string, number, number, number])[] = [
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
    // Without this a predicate answering true unconditionally would pass every case above.
    expect(isInsideRange(2 * 1024 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024)).toBe(false);
    expect(isInsideRange(0, 1, 50)).toBe(false);
  });

  it("discloses the stream ceiling well before the stream reaches it", () => {
    // At or above the ceiling it would fire on a stream the daemon already terminated.
    expect(INGEST_STALL_DISCLOSURE_MS).toBeLessThan(INGEST_STREAM_LIFETIME_CEILING_MS);
  });
});
