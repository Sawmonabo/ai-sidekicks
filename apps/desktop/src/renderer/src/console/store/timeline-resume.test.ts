// The resume rule, decided against the shape the wire actually carries.
//
// Every case here reads a cursor block of the SHIPPED form — `{ latest }` with an
// optional `acknowledged`, and no third member — because that is what
// `SessionReadResponseSchema` is `.strict()` over. The suite this replaced asserted
// the opposite: it required a floor member that schema forbids, so its passing arms
// described a reply no daemon can send and its refusing arm was the state every real
// read is in.

import { describe, expect, it } from "vitest";

import {
  isUnresolvableCursorRejection,
  refuseUnresolvableResume,
  resolveTimelineResume,
  RESUME_CURSOR_UNRESOLVABLE_CODE,
  TIMELINE_RESUME_ORIGIN,
  TIMELINE_RESUME_REFUSAL_CODES,
} from "./timeline-resume.js";

const LATEST = "9_1723291500000000000";
const ACKNOWLEDGED = "7_1723291480000000000";

describe("resolveTimelineResume — where the next read starts", () => {
  it("resumes from the acknowledged position when the read carries one", () => {
    const decision = resolveTimelineResume({ latest: LATEST, acknowledged: ACKNOWLEDGED });

    expect(decision.outcome).toBe("resume");
    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(ACKNOWLEDGED);
  });

  it("restarts from the beginning when nothing has been acknowledged", () => {
    // The ordinary FIRST read, and the case the retired rule refused outright: a
    // participant who has been acknowledged nowhere has no position to resume from,
    // and the beginning of the window is where a reader with no position starts.
    const decision = resolveTimelineResume({ latest: LATEST });

    expect(decision.outcome).toBe("restart");
  });

  it("restarts rather than refusing when the reply carries no cursor block at all", () => {
    // Undecidable in the same direction and for the same reason: nothing names a
    // position. Reporting it apart from the case above would report a difference no
    // caller can act on — both submit no cursor.
    for (const block of [undefined, null, "cursors", [], {}, { latest: "" }, { latest: 4 }]) {
      expect(resolveTimelineResume(block).outcome).toBe("restart");
    }
  });

  it("ignores an acknowledged member that is not a cursor", () => {
    // A block whose `acknowledged` arrived as a number or an empty string names no
    // position either, and submitting one would send the daemon a value it must
    // refuse. It restarts, exactly as an absent member does.
    for (const acknowledged of [undefined, null, "", 7, {}]) {
      expect(resolveTimelineResume({ latest: LATEST, acknowledged }).outcome).toBe("restart");
    }
  });

  it("negative control: a well-formed block with a position does NOT restart", () => {
    // Without this every case above is satisfied by a resolver that answers `restart`
    // for everything — which is a console that never resumes and always looks right.
    expect(resolveTimelineResume({ latest: LATEST, acknowledged: ACKNOWLEDGED }).outcome).toBe(
      "resume",
    );
  });

  it("takes the acknowledged position verbatim, whatever it looks like beside `latest`", () => {
    // No ordering is taken over an opaque cursor: the console holds no `decode`, so a
    // position that LOOKS lower than the head is still the position the daemon issued.
    // A resolver that compared them would discard a live projection on a loss nothing
    // established — and would mis-order two UUID-derived cursors while doing it.
    const decision = resolveTimelineResume({
      latest: LATEST,
      acknowledged: "-4_1723200000000000000",
    });

    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(
      "-4_1723200000000000000",
    );
  });
});

describe("the refused arm — the one refusal left", () => {
  it("raises exactly the code it declares, under this module's own origin", () => {
    const decision = refuseUnresolvableResume();

    expect(decision.outcome).toBe("refused");
    if (decision.outcome !== "refused") {
      throw new Error("the refusal builder answered some other arm");
    }
    expect(decision.refusal.origin).toBe(TIMELINE_RESUME_ORIGIN);
    expect(TIMELINE_RESUME_REFUSAL_CODES).toContain(decision.refusal.code);
  });

  it("raises every code it declares, so the enumeration is a set and not a comment", () => {
    // The closed-set claim, both directions: what the module can raise and what it
    // says it can raise are the same list. A member nothing raises is a code a surface
    // could branch on and never reach.
    const raised = new Set(
      [refuseUnresolvableResume()].flatMap((decision) =>
        decision.outcome === "refused" ? [decision.refusal.code] : [],
      ),
    );

    expect([...raised].sort()).toStrictEqual([...TIMELINE_RESUME_REFUSAL_CODES].sort());
  });

  it("says what the console did about it, and never carries a cursor", () => {
    // `core/refusal.ts`: a detail is one actionable sentence and never the refused
    // value. The value here is a position, and a position pasted into a banner is a
    // wire string nobody can act on.
    const decision = refuseUnresolvableResume();
    const detail = decision.outcome === "refused" ? decision.refusal.detail : "";

    expect(detail).toMatch(/re-read from the beginning/u);
    expect(detail).not.toContain(ACKNOWLEDGED);
    expect(detail).not.toContain(LATEST);
  });
});

describe("isUnresolvableCursorRejection — reading the daemon's answer", () => {
  it("recognises the registered wire code on a plain envelope and on an Error", () => {
    class WireError extends Error {
      public readonly code = RESUME_CURSOR_UNRESOLVABLE_CODE;
    }

    expect(
      isUnresolvableCursorRejection({
        code: RESUME_CURSOR_UNRESOLVABLE_CODE,
        message: "cursor could not be decoded",
      }),
    ).toBe(true);
    expect(isUnresolvableCursorRejection(new WireError("cursor could not be decoded"))).toBe(true);
  });

  it("negative control: any other rejection is not this one", () => {
    // Without this, a recognizer that answered `true` for everything would satisfy the
    // case above — and the entry would then treat every failed read as a lost position
    // and re-read the window twice for each one.
    for (const rejection of [
      undefined,
      null,
      "event.cursor_unresolvable",
      new Error("event.cursor_unresolvable"),
      { code: "session.not_found", message: "no such session" },
      { code: RESUME_CURSOR_UNRESOLVABLE_CODE },
    ]) {
      expect(isUnresolvableCursorRejection(rejection)).toBe(false);
    }
  });

  it("answers rather than throwing for a rejection whose own code throws", () => {
    // A rejection is whatever a producer threw, and this arm runs inside the `catch`
    // that exists to classify it — so a throwing accessor here would propagate out of
    // the one place that can report the failure.
    const hostile = {
      get code(): string {
        throw new Error("this getter is the hazard");
      },
      message: "unreadable",
    };

    expect(isUnresolvableCursorRejection(hostile)).toBe(false);
  });
});
