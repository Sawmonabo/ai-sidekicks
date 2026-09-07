// The tripwire reading: it fires on the fixed form and on nothing else.

import { describe, expect, it } from "vitest";

import { TEXT_NEUTRALIZATION_ORIGINS, readTextNeutralization } from "./neutralization-tripwire.js";

describe("readTextNeutralization — the fixed form, read the way the wire says to", () => {
  it("reads the code and every declared origin arm", () => {
    for (const origin of TEXT_NEUTRALIZATION_ORIGINS) {
      const reading = readTextNeutralization(`driver.text_neutralization_failed origin=${origin}`);
      expect(reading?.code).toBe("driver.text_neutralization_failed");
      expect(reading?.origin).toBe(origin);
    }
  });

  it("keeps the detail verbatim, so the mono figure is what the daemon sent", () => {
    const detail = "driver.text_neutralization_failed origin=participant_text";
    expect(readTextNeutralization(detail)?.wireDetail).toBe(detail);
  });

  it("separates an unread arm from the wire's own `unknown` arm", () => {
    // The wire's `unknown` is a driver SAYING it could not attribute the text; an
    // unrecognised arm is the console failing to read one. Collapsing them would
    // report a statement the driver never made.
    expect(
      readTextNeutralization("driver.text_neutralization_failed origin=elsewhere")?.origin,
    ).toBeUndefined();
    expect(readTextNeutralization("driver.text_neutralization_failed origin=unknown")?.origin).toBe(
      "unknown",
    );
  });

  it("does not fire on the other producer of the same wire member", () => {
    // The negative control the whole reading rests on: `providerFailureDetail` also
    // carries free-form resume-failure prose, and a substring match would classify
    // this as a neutralization trip.
    expect(
      readTextNeutralization(
        "provider endpoint returned 410 Gone while resuming; driver.text_neutralization_failed was not the cause",
      ),
    ).toBeUndefined();
    expect(readTextNeutralization(undefined)).toBeUndefined();
    expect(readTextNeutralization("")).toBeUndefined();
  });
});
