// One operation, two failure paths, one subsystem name.
//
// THE CLAIM THIS SUITE OWNS is the pair, not either half: a growth call fails two
// ways — the port ANSWERS `unavailable`, or the call THROWS across the process
// boundary — and both are the same operation failing. Both call sites used to stamp
// the second with the repos family's daemon-read origin and the daemon-reply code
// `call-rejected`, so `artifactRead` and `gitActionExecute` alike reported
// `growth-port` / `wire-unregistered` when the port answered and `repos` /
// `call-rejected` when the wire dropped, and a person reading the second had no way to
// know which subsystem had refused.
//
// DRIVEN AGAINST THE DOOR rather than through a reader, because the reader's suites
// own scheduling, joins, and generation stamps and would pass or fail identically on
// a door that never existed. What varies here is only what the call did.
//
// THE SECOND CALLER IS WHY THE DOOR IS AT THE FAMILY ROOT. The proposal gate reached
// for the daemon-read stamp of its own, so its three gitflow calls reported the pair
// this suite exists to have closed. One door, one vocabulary, both panes.

import { describe, expect, it } from "vitest";

import {
  GROWTH_PORT_REFUSAL_ORIGIN,
  growthUnavailable,
  type GrowthPortRefusalCode,
} from "../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../core/index.js";
import { growthAnswerReading, readGrowthAnswer } from "./growth-call.js";

/**
 * The origin this door stamps on a reply it could not read, spelled rather than
 * imported.
 *
 * An assertion about a VALUE has to spell it: a test that imported the constant would
 * pass whatever that constant became, which is the one thing this case is here to hold.
 */
const GROWTH_CALL_REFUSAL_ORIGIN_SPELLED = "repos-growth-call";

/** A refusal built by `core` alone — no port discriminant, which is the case below. */
const REFUSAL = refuse("growth-port", "wire-unregistered", "Not checked.");

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

describe("the growth-call door — reading one port answer", () => {
  it("reads the port's own refusal, keeping the code and the sentence it carries", () => {
    const answer = growthAnswerReading("The allow-list read", {
      ...REFUSAL,
      status: "unavailable",
      code: "wire-unregistered",
      operationId: "artifactAllowlistRead",
      slateRow: "artifact-crud",
      owningDocument: "attachments",
    } as never);
    expect(answer.status).toBe("refused");
    expect(answer.status === "refused" ? answer.refusal : undefined).toMatchObject({
      code: "wire-unregistered",
      origin: "growth-port",
    });
  });

  it("reads a refusal that carries no served discriminant", () => {
    // THE CASE THE OLD NARROWING GOT WRONG, and the reason this function exists. A
    // refusal built by `core`'s `refuse(...)` has the console's three refusal fields
    // and no `status` at all — which is the value `growthUnavailable` spreads to build
    // its own. Read as "not unavailable, therefore served", it was dereferenced for a
    // `value` it does not carry and the pane published a `TypeError` in place of the
    // refusal that had just told it why.
    const answer = growthAnswerReading("The allow-list read", REFUSAL as never);
    expect(answer.status).toBe("refused");
    expect(answer.status === "refused" ? answer.refusal : undefined).toBe(REFUSAL);
  });

  it("reads a served answer's value through untouched", () => {
    const served = { contentTypes: ["text/plain"], maximumByteLength: 42 };
    const answer = growthAnswerReading("The allow-list read", {
      status: "served",
      value: served,
    });
    expect(answer.status).toBe("read");
    expect(answer.status === "read" ? answer.value : undefined).toBe(served);
  });

  it("negative control: a served answer whose VALUE looks like a refusal is still read", () => {
    // Without this, recognising a refusal by its fields could be written to look
    // anywhere in the reply and would refuse a perfectly good read whose payload
    // happened to carry a code, a detail, and an origin. The shape test is about the
    // ANSWER and never about what the answer is carrying.
    const answer = growthAnswerReading("The manifest re-read", {
      status: "served",
      value: REFUSAL,
    });
    expect(answer.status).toBe("read");
    expect(answer.status === "read" ? answer.value : undefined).toBe(REFUSAL);
  });

  it("refuses a reply that is neither, naming the operation and not the reply", () => {
    // Total rather than throwing: a reply of an unexpected shape is a fact a person
    // can act on, and an exception three frames from where the answer arrived is not.
    const answer = growthAnswerReading("The delete", { status: "served" } as never);
    expect(answer.status).toBe("refused");
    const refusal = answer.status === "refused" ? answer.refusal : undefined;
    expect(refusal?.code).toBe("reply-unreadable");
    expect(refusal?.origin).toBe(GROWTH_CALL_REFUSAL_ORIGIN_SPELLED);
    expect(refusal?.detail).toContain("The delete");
  });
});
