import { describe, expect, it } from "vitest";

import {
  POST_REPLAY_TAIL_DEPTH,
  ReplayTargetAbandonedError,
  ReplayTargetLedger,
  assertReplayReconstituted,
  type ReplayTargetReadback,
  type SeededTranscriptFrame,
} from "../replay-assertion.js";

// A replay is complete only when the reconstituted session's own answer confirms it; a
// provider's success return is not evidence.

function seededFrames(...bodies: readonly string[]): SeededTranscriptFrame[] {
  return bodies.map((text, index) => ({
    position: index + 1,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text,
  }));
}

function answered(...turns: readonly string[]): ReplayTargetReadback {
  return { kind: "turns", turns };
}

describe("assertReplayReconstituted", () => {
  it("confirms a target whose answer matches the seeded tail", () => {
    const verdict = assertReplayReconstituted(
      seededFrames("hello", "hi there", "what is the plan?", "here it is"),
      answered("hello", "hi there", "what is the plan?", "here it is"),
    );
    expect(verdict.outcome).toBe("confirmed");
    if (verdict.outcome !== "confirmed") {
      throw new Error("unreachable");
    }
    expect(verdict.comparedTurns).toBe(POST_REPLAY_TAIL_DEPTH);
    expect(verdict.answeredTurns).toBe(4);
  });

  // A provider that accepts every seeding frame and stores none answers with zero turns while
  // every call above it succeeded. Only this check stops a session that forgot the conversation.
  it("REFUTES a provider that lies: every frame accepted, zero turns answered", () => {
    const verdict = assertReplayReconstituted(
      seededFrames("hello", "hi there", "what is the plan?", "here it is"),
      answered(),
    );
    expect(verdict).toStrictEqual({
      outcome: "refuted",
      refutation: "answered-zero-turns",
      detail: "the replay target answered with zero turns after 4 frame(s) were seeded",
    });
  });

  it("refutes a target that silently dropped part of the transcript", () => {
    const verdict = assertReplayReconstituted(
      seededFrames("one", "two", "three", "four"),
      answered("three", "four"),
    );
    expect(verdict.outcome).toBe("refuted");
    if (verdict.outcome !== "refuted") {
      throw new Error("unreachable");
    }
    expect(verdict.refutation).toBe("fewer-turns-than-seeded");
  });

  it("refutes a target that could not be read at all", () => {
    const verdict = assertReplayReconstituted(seededFrames("one"), {
      kind: "unreadable",
      reason: "the session is gone",
    });
    expect(verdict.outcome).toBe("refuted");
    if (verdict.outcome !== "refuted") {
      throw new Error("unreachable");
    }
    expect(verdict.refutation).toBe("target-unreadable");
    expect(verdict.detail).toContain("the session is gone");
  });

  it("refutes a target whose tail contradicts the transcript", () => {
    const verdict = assertReplayReconstituted(
      seededFrames("one", "two", "three"),
      answered("one", "two", "a summary of the above"),
    );
    expect(verdict.outcome).toBe("refuted");
    if (verdict.outcome !== "refuted") {
      throw new Error("unreachable");
    }
    expect(verdict.refutation).toBe("tail-mismatch");
    // The detail names the position and the lengths, never a body: diagnostics are kept for a
    // bounded time and must not hold conversation text.
    expect(verdict.detail).toContain("seeded position 3");
    expect(verdict.detail).not.toContain("a summary of the above");
    expect(verdict.detail).not.toContain("three");
  });

  // A provider may add turns of its own; losing turns is what destroys a transcript. The extra
  // turns are tolerated only because the tail is still compared, which the second case proves.
  it("tolerates a target that answered with MORE turns, anchored on the tail", () => {
    const confirmed = assertReplayReconstituted(
      seededFrames("one", "two", "three"),
      answered("a provider preamble", "one", "two", "three"),
    );
    expect(confirmed.outcome).toBe("confirmed");

    const refuted = assertReplayReconstituted(
      seededFrames("one", "two", "three"),
      answered("one", "two", "three", "a turn nobody seeded"),
    );
    expect(refuted.outcome).toBe("refuted");
    if (refuted.outcome !== "refuted") {
      throw new Error("unreachable");
    }
    expect(refuted.refutation).toBe("tail-mismatch");
  });

  // Over content-free turns the assertion cannot tell a provider that kept every frame from one
  // that discarded them all, so it refuses rather than confirming on the count alone.
  it("refutes a seeded tail carrying no bodies, rather than confirming on the count", () => {
    const verdict = assertReplayReconstituted(seededFrames("", "", ""), answered("", "", ""));
    expect(verdict.outcome).toBe("refuted");
    if (verdict.outcome !== "refuted") {
      throw new Error("unreachable");
    }
    expect(verdict.refutation).toBe("no-comparable-content");
  });

  it("still refutes an empty seed when the target answered with invented prose", () => {
    const verdict = assertReplayReconstituted(
      seededFrames("", "", ""),
      answered("", "", "prose nobody seeded"),
    );
    expect(verdict.outcome).toBe("refuted");
    if (verdict.outcome !== "refuted") {
      throw new Error("unreachable");
    }
    expect(verdict.refutation).toBe("no-comparable-content");
  });

  it("forgives line endings and surrounding whitespace, and nothing else", () => {
    const forgiven = assertReplayReconstituted(
      seededFrames("first\r\nsecond", "  padded  "),
      answered("first\nsecond", "padded"),
    );
    expect(forgiven.outcome).toBe("confirmed");

    // Interior whitespace is not collapsed: a reflowed body was changed, and forgiving that
    // would also forgive a summary.
    const refused = assertReplayReconstituted(
      seededFrames("first  second"),
      answered("first second"),
    );
    expect(refused.outcome).toBe("refuted");
  });
});

describe("ReplayTargetLedger", () => {
  it("refuses a burned target for good, naming why", () => {
    const ledger = new ReplayTargetLedger();
    ledger.abandon("burned-target", "ambiguous-delivery");
    expect(() => ledger.assertUsable("burned-target")).toThrow(ReplayTargetAbandonedError);
    try {
      ledger.assertUsable("burned-target");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ReplayTargetAbandonedError);
      expect((error as ReplayTargetAbandonedError).abandonmentCause).toBe("ambiguous-delivery");
    }
  });

  it("admits a fresh target, burning only the one abandoned", () => {
    const ledger = new ReplayTargetLedger();
    ledger.abandon("target-a", "target-not-fresh");
    expect(() => ledger.assertUsable("target-b")).not.toThrow();
    expect(ledger.abandonmentCauseFor("target-b")).toBeUndefined();
  });
});
