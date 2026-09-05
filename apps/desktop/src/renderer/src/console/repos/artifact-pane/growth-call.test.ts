// One operation, two failure paths, one subsystem name.
//
// THE CLAIM THIS SUITE OWNS is the pair, not either half: a growth call fails two
// ways — the port ANSWERS `unavailable`, or the call THROWS across the process
// boundary — and both are the same operation failing. This door used to stamp the
// second with the repos family's daemon-read origin and the daemon-reply code
// `call-rejected`, so `artifactRead` reported `growth-port` / `wire-unregistered`
// when the port answered and `repos` / `call-rejected` when the wire dropped, and a
// person reading the second had no way to know which subsystem had refused.
//
// DRIVEN AGAINST THE DOOR rather than through a reader, because the reader's suites
// own scheduling, joins, and generation stamps and would pass or fail identically on
// a door that never existed. What varies here is only what the call did.

import { describe, expect, it } from "vitest";

import {
  GROWTH_PORT_REFUSAL_ORIGIN,
  growthUnavailable,
  type GrowthPortRefusalCode,
} from "../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import { readGrowthAnswer } from "./growth-call.js";

/** The leg name every case below calls under, so the sentence is comparable. */
const OPERATION = "The artifact read";

/** What a live port answers for a wire the corpus has not registered. */
const ANSWERED_REFUSAL = growthUnavailable("artifactRead");

/** What the same operation leaves in the caller's hands when the bridge drops. */
const DISCONNECTED = new Error("the daemon channel closed");

describe("the growth-call door — the two ways one operation fails", () => {
  it("names the growth port on the answered path and the rejected path alike", async () => {
    const answered = await readGrowthAnswer(OPERATION, async () => ANSWERED_REFUSAL);
    const rejected = await readGrowthAnswer(OPERATION, () => Promise.reject(DISCONNECTED));

    expect(answered.status).toBe("refused");
    expect(rejected.status).toBe("refused");
    const answeredRefusal = answered.status === "refused" ? answered.refusal : undefined;
    const rejectedRefusal = rejected.status === "refused" ? rejected.refusal : undefined;

    // The property: one subsystem name across both paths, and it is the port's.
    expect(answeredRefusal?.origin).toBe(GROWTH_PORT_REFUSAL_ORIGIN);
    expect(rejectedRefusal?.origin).toBe(GROWTH_PORT_REFUSAL_ORIGIN);
    expect(rejectedRefusal?.origin).toBe(answeredRefusal?.origin);

    // And one vocabulary. A namespace the live bridge fills in is gone exactly when a
    // call through it throws, which is what this member of the port's closed set says.
    const wireUnregistered: GrowthPortRefusalCode = "wire-unregistered";
    expect(rejectedRefusal?.code).toBe(wireUnregistered);
    expect(rejectedRefusal?.code).toBe(answeredRefusal?.code);

    // What still separates them is the sentence, which is the honest difference: the
    // answered path says nobody asked, and this one says the call was rejected.
    expect(rejectedRefusal?.detail).toBe("The artifact read was rejected.");
    expect(rejectedRefusal?.detail).not.toBe(answeredRefusal?.detail);
    // The leg is named and the rejected value is not quoted into it: a rejection off
    // the wire can carry participant content as readily as a schema failure can.
    expect(rejectedRefusal?.detail).not.toContain(DISCONNECTED.message);
  });

  it("negative control: a coded rejection keeps the code and origin its sender chose", async () => {
    // The over-reach a fallback invites. A door that stamped the port's vocabulary
    // over every rejection would satisfy the case above and discard the two codes
    // that actually diagnose something — so both typed arms are driven here, and each
    // one's surviving code is a code the fallback could not have produced.
    const daemonEnvelope = await readGrowthAnswer(OPERATION, () =>
      Promise.reject({
        code: -32603,
        message: "the session is gone",
        data: { type: "session.not_found", fields: { retryAfter: 30 } },
      }),
    );
    expect(daemonEnvelope.status === "refused" ? daemonEnvelope.refusal.code : undefined).toBe(
      "session.not_found",
    );
    expect(
      daemonEnvelope.status === "refused"
        ? (daemonEnvelope.refusal as { retry?: { afterSeconds?: number } }).retry?.afterSeconds
        : undefined,
    ).toBe(30);

    const carried = refuse("scenario-engine", "reply-abandoned", "The parked reply was dropped.");
    const thrownRefusal = await readGrowthAnswer(OPERATION, () =>
      Promise.reject(new ConsoleRefusalError(carried)),
    );
    expect(thrownRefusal).toStrictEqual({ status: "refused", refusal: carried });
  });

  it("negative control: a served answer is still read rather than caught", async () => {
    // A `try` wide enough to swallow the success path would pass every case above.
    const reading = await readGrowthAnswer(OPERATION, async () => ({
      status: "served" as const,
      value: { bytes: 4 },
    }));
    expect(reading).toStrictEqual({ status: "read", value: { bytes: 4 } });
  });
});
