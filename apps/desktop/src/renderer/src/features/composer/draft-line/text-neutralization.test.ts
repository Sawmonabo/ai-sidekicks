// The tripwire reading fires on the fixed form and on nothing else.

import { describe, expect, it } from "vitest";

import { TEXT_NEUTRALIZATION_ORIGINS, readTextNeutralization } from "./text-neutralization.js";

describe("readTextNeutralization — the fixed form, read the way the wire says to", () => {
  it("reads the code and every declared origin arm", () => {
    for (const origin of TEXT_NEUTRALIZATION_ORIGINS) {
      const reading = readTextNeutralization(`driver.text_neutralization_failed origin=${origin}`);
      expect(reading?.code).toBe("driver.text_neutralization_failed");
      expect(reading?.origin).toBe(origin);
    }
  });

  it("keeps the detail verbatim, so the mono figure is what the daemon sent", () => {
    const detail = "driver.text_neutralization_failed origin=human_text";
    expect(readTextNeutralization(detail)?.wireDetail).toBe(detail);
  });

  it("separates an unread arm from the wire's own `unknown` arm", () => {
    // The wire's `unknown` is a driver saying it could not attribute the text; an unrecognized
    // arm is the console failing to read one.
    expect(
      readTextNeutralization("driver.text_neutralization_failed origin=elsewhere")?.origin,
    ).toBeUndefined();
    expect(readTextNeutralization("driver.text_neutralization_failed origin=unknown")?.origin).toBe(
      "unknown",
    );
  });

  it("does not fire on the other producer of the same wire member", () => {
    // `providerFailureDetail` also carries free-form prose, and a substring match would
    // classify this as a trip.
    expect(
      readTextNeutralization(
        "provider endpoint returned 410 Gone while resuming; driver.text_neutralization_failed was not the cause",
      ),
    ).toBeUndefined();
    expect(readTextNeutralization(undefined)).toBeUndefined();
    expect(readTextNeutralization("")).toBeUndefined();
  });
});
