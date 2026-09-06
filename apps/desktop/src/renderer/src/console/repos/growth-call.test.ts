// One operation, two failure paths, one subsystem name — and deliberately two codes.
//
// THE CLAIM THIS SUITE OWNS is the pair, not either half: a growth call fails two
// ways — the port ANSWERS `unavailable`, or the call THROWS across the process
// boundary — and both are the same operation failing, so both must name the same
// subsystem. Both call sites used to stamp the second with the repos family's
// daemon-read origin, so `artifactRead` and `gitActionExecute` alike reported
// `growth-port` when the port answered and `repos` when the wire dropped, and a person
// reading the second had no way to know which subsystem had refused.
//
// AND WHAT THEY MUST NOT SHARE IS THE CODE, which is the half the first fix got
// backwards. This door replaced the family origin with the port's and then minted
// `wire-unregistered` to go with it — the member that says NOBODY ASKED, stamped on
// the one path reached only because somebody did.
// `bridge/growth-port/growth-port.ts` declares `call-rejected` for exactly this case
// and builds it, so the door hands the rejection to that builder instead of describing
// it a second time: an unregistered wire and a wire that dropped mid-call are different
// facts and different next moves, and the answer carries the port's own widening —
// which operation, which slate row, who owes the wire — on both paths alike.
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
  it("names the growth port on both paths and tells an outage from an unasked wire", async () => {
    const answered = await readGrowthAnswer(
      "artifactRead",
      OPERATION,
      async () => ANSWERED_REFUSAL,
    );
    const rejected = await readGrowthAnswer("artifactRead", OPERATION, () =>
      Promise.reject(DISCONNECTED),
    );

    expect(answered.status).toBe("refused");
    expect(rejected.status).toBe("refused");
    const answeredRefusal = answered.status === "refused" ? answered.refusal : undefined;
    const rejectedRefusal = rejected.status === "refused" ? rejected.refusal : undefined;

    // The property: one subsystem name across both paths, and it is the port's.
    expect(answeredRefusal?.origin).toBe(GROWTH_PORT_REFUSAL_ORIGIN);
    expect(rejectedRefusal?.origin).toBe(GROWTH_PORT_REFUSAL_ORIGIN);
    expect(rejectedRefusal?.origin).toBe(answeredRefusal?.origin);

    // And two codes, both members of the port's own closed set. Sharing one was the
    // defect: `wire-unregistered` says nobody asked, which is the ordinary V1 answer,
    // and `call-rejected` says the call was made and threw, which is an outage. A
    // person acts differently on each, so a door that reported one as the other buried
    // the only thing that told them apart.
    const wireUnregistered: GrowthPortRefusalCode = "wire-unregistered";
    const callRejected: GrowthPortRefusalCode = "call-rejected";
    expect(answeredRefusal?.code).toBe(wireUnregistered);
    expect(rejectedRefusal?.code).toBe(callRejected);
    expect(rejectedRefusal?.code).not.toBe(answeredRefusal?.code);

    // The port's own widening on the rejected path too, which a refusal this door
    // minted did not carry: a rejected call says which operation it was, which slate
    // row that operation serves, and who owes the wire — the members every growth
    // surface narrows and renders on the answered path.
    expect(rejectedRefusal).toMatchObject({
      status: "unavailable",
      operationId: "artifactRead",
      slateRow: "artifact-ingest-and-crud",
      owningDocument: "Plan-014",
    });

    // And the sentence carries what the rejection said. Suppressing it was this door's
    // own rule and it left a participant with a refusal and no reason; the port's
    // builder reads the rejection through `core/wire-rejection.ts`, which already
    // refuses to serialize a structure into a sentence, so what survives is prose the
    // producing side wrote rather than a rendering of the value.
    expect(rejectedRefusal?.detail).toContain(DISCONNECTED.message);
    expect(rejectedRefusal?.detail).not.toBe(answeredRefusal?.detail);
  });

  it("negative control: a coded rejection folds to one code and keeps its own sentence", async () => {
    // Both halves of the fold, because each could be got wrong on its own. A door that
    // kept the sender's CODE would put `session.not_found` and `reply-abandoned` on a
    // refusal stamped with the growth port's origin — codes from no vocabulary that
    // port declares, which is the sprawl one origin per subsystem exists to end. A
    // door that composed a CONSTANT would satisfy the case above and report two
    // unrelated outages with one sentence, so the two rejections here are driven for
    // their details as well as their code.
    const callRejected: GrowthPortRefusalCode = "call-rejected";

    const daemonEnvelope = await readGrowthAnswer("artifactRead", OPERATION, () =>
      Promise.reject({
        code: -32603,
        message: "the session is gone",
        data: { type: "session.not_found", fields: { retryAfter: 30 } },
      }),
    );
    const envelopeRefusal =
      daemonEnvelope.status === "refused" ? daemonEnvelope.refusal : undefined;
    expect(envelopeRefusal?.code).toBe(callRejected);
    expect(envelopeRefusal?.detail).toContain("the session is gone");

    const carried = refuse("scenario-engine", "reply-abandoned", "The parked reply was dropped.");
    const thrown = await readGrowthAnswer("artifactRead", OPERATION, () =>
      Promise.reject(new ConsoleRefusalError(carried)),
    );
    const thrownRefusal = thrown.status === "refused" ? thrown.refusal : undefined;
    expect(thrownRefusal?.code).toBe(callRejected);
    expect(thrownRefusal?.origin).toBe(GROWTH_PORT_REFUSAL_ORIGIN);
    expect(thrownRefusal?.detail).toContain(carried.detail);
    // Two rejections, two sentences: the builder reads each one rather than naming the
    // leg and stopping, which is what the constant this replaces did.
    expect(thrownRefusal?.detail).not.toBe(envelopeRefusal?.detail);
  });

  it("negative control: a served answer is still read rather than caught", async () => {
    // A `try` wide enough to swallow the success path would pass every case above.
    const reading = await readGrowthAnswer("artifactRead", OPERATION, async () => ({
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
