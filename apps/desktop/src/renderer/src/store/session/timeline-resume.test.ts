// The resume rule, decided against the shape the wire carries: a cursor block of `{ latest }` with
// an optional `acknowledged` and no third member, which `SessionReadResponseSchema` enforces with
// `.strict()`. A floor member that schema forbids would describe a reply no daemon can send.

import { describe, expect, it } from "vitest";

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import {
  isUnresolvableCursorRejection,
  refuseUnresolvableResume,
  resolveTimelineResume,
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
    // The ordinary first read, not a refusal: with no acknowledged position the window starts.
    const decision = resolveTimelineResume({ latest: LATEST });

    expect(decision.outcome).toBe("restart");
  });

  it("restarts rather than refusing when the reply carries no cursor block at all", () => {
    // Nothing names a position, so this restarts like the case above; both submit no cursor.
    for (const block of [undefined, null, "cursors", [], {}, { latest: "" }, { latest: 4 }]) {
      expect(resolveTimelineResume(block).outcome).toBe("restart");
    }
  });

  it("ignores an acknowledged member that is not a cursor", () => {
    // A non-cursor `acknowledged` names no position, and submitting it would send a value the
    // daemon must refuse, so it restarts like an absent member.
    for (const acknowledged of [undefined, null, "", 7, {}]) {
      expect(resolveTimelineResume({ latest: LATEST, acknowledged }).outcome).toBe("restart");
    }
  });

  it("negative control: a well-formed block with a position does NOT restart", () => {
    // Guards a resolver that answers `restart` for everything: a console that never resumes.
    expect(resolveTimelineResume({ latest: LATEST, acknowledged: ACKNOWLEDGED }).outcome).toBe(
      "resume",
    );
  });

  it("takes the acknowledged position verbatim, whatever it looks like beside `latest`", () => {
    // The cursor is opaque and the console has no decoder, so a position that looks lower than
    // the head is still the daemon's. Comparing them would discard a live projection on a loss
    // nothing established.
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
    // Closed set in both directions: a code nothing raises is one a view could branch on in vain.
    const raised = new Set(
      [refuseUnresolvableResume()].flatMap((decision) =>
        decision.outcome === "refused" ? [decision.refusal.code] : [],
      ),
    );

    expect([...raised].sort()).toStrictEqual([...TIMELINE_RESUME_REFUSAL_CODES].sort());
  });

  it("says what the console did about it, and never carries a cursor", () => {
    // A refusal detail is one actionable sentence and never the refused value; a position in a
    // banner is a wire string nobody can act on.
    const decision = refuseUnresolvableResume();
    const detail = decision.outcome === "refused" ? decision.refusal.detail : "";

    expect(detail).toMatch(/re-read from the beginning/u);
    expect(detail).not.toContain(ACKNOWLEDGED);
    expect(detail).not.toContain(LATEST);
  });
});

describe("isUnresolvableCursorRejection — reading the daemon's answer", () => {
  it("recognizes the registered wire code on a plain envelope and on an Error", () => {
    class WireError extends Error {
      public readonly code = EVENT_CURSOR_UNRESOLVABLE_CODE;
    }

    expect(
      isUnresolvableCursorRejection({
        code: EVENT_CURSOR_UNRESOLVABLE_CODE,
        message: "cursor could not be decoded",
      }),
    ).toBe(true);
    expect(isUnresolvableCursorRejection(new WireError("cursor could not be decoded"))).toBe(true);
  });

  it("negative control: any other rejection is not this one", () => {
    // Guards a recognizer answering `true` for everything, which would re-read twice per failure.
    for (const rejection of [
      undefined,
      null,
      "event.cursor_unresolvable",
      new Error("event.cursor_unresolvable"),
      { code: "session.not_found", message: "no such session" },
      { code: EVENT_CURSOR_UNRESOLVABLE_CODE },
    ]) {
      expect(isUnresolvableCursorRejection(rejection)).toBe(false);
    }
  });

  it("answers rather than throwing for a rejection whose own code throws", () => {
    // This runs inside the `catch` that classifies the rejection, so a throwing accessor must
    // not escape.
    const hostile = {
      get code(): string {
        throw new Error("this getter is the hazard");
      },
      message: "unreadable",
    };

    expect(isUnresolvableCursorRejection(hostile)).toBe(false);
  });
});
