// A provider CLI swallows a command-shaped message and answers with a zero-turn success, so the
// bytes on the wire are neutralized and a turn settling with no evidence of a model fails loudly.
// The turn that settles with no evidence is the recorded Claude zero-turn reply.

import { describe, expect, it } from "vitest";

import { captureThrow } from "../__fixtures__/capture-throw.js";
import { classifyClaudeTurnEvidence } from "../drivers/claude/turn-evidence.js";
import { CLAUDE_ZERO_TURN_RESULT_FRAME } from "../drivers/claude/__fixtures__/turn-evidence-transcripts.js";
import {
  composeTextNeutralizationRunFailure,
  isCommandShapedText,
  observedTurnEvidence,
  OutboundFrameCapacityRefusedError,
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
  OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY,
  OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL,
  RuntimeBindingQuarantine,
  TextNeutralizationRefusedError,
  TEXT_NEUTRALIZATION_REFUSAL_CODE,
  UNRECOGNIZED_TURN_EVIDENCE,
  type OutboundFrameRole,
  type OutboundTextFrame,
} from "../outbound-frame.js";

// Code points, not literal characters: half of these are invisible in an editor.

/** The six ASCII whitespace bytes the predicate skips, and nothing else. */
const ASCII_WHITESPACE_LEADS: readonly string[] = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].map(
  (codePoint) => String.fromCodePoint(codePoint),
);

/** Two Unicode spaces outside that set. */
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

describe("command-shaped text predicate", () => {
  it("treats a leading slash as command-shaped after exactly the six ASCII whitespace bytes", () => {
    // No command-name list is consulted: the measured interception happens on the leading byte,
    // upstream of any name lookup, so avoiding real command names does not dodge it.
    expect(isCommandShapedText("/status")).toBe(true);
    expect(isCommandShapedText("/zzqnotarealcommand and some prose")).toBe(true);
    expect(isCommandShapedText("/foo:bar")).toBe(true);
    expect(isCommandShapedText("/etc/hosts is the file I mean")).toBe(true);
    for (const lead of ASCII_WHITESPACE_LEADS) {
      expect(isCommandShapedText(lead + "/status")).toBe(true);
    }
    expect(isCommandShapedText("  \t\r\n/status")).toBe(true);
  });

  it("does not treat a mid-text slash or a non-ASCII whitespace lead as command-shaped", () => {
    // A predicate that matched anywhere would silently corrupt every message that mentions a path.
    expect(isCommandShapedText("please read /etc/hosts")).toBe(false);
    expect(isCommandShapedText("use the a/b test")).toBe(false);
    expect(isCommandShapedText("")).toBe(false);
    expect(isCommandShapedText("   ")).toBe(false);
    // Deliberate: the predicate mirrors a provider's own ASCII parser, and over-matching would
    // neutralize text no provider intercepts. A parser that does skip exotic whitespace is the
    // tripwire's job.
    expect(isCommandShapedText(NO_BREAK_SPACE + "/status")).toBe(false);
    expect(isCommandShapedText(IDEOGRAPHIC_SPACE + "/status")).toBe(false);
  });
});

describe("outbound text frame writer", () => {
  function writer(mechanismGrade: "native" | "emulated"): OutboundTextFrameWriter {
    return new OutboundTextFrameWriter({
      mechanismGrade,
      mintCorrelationId: () => "correlation-1",
    });
  }

  it("prepends exactly one newline under the emulated grade and never mutates the author's bytes", () => {
    const authored = "/status please";
    const frame = writer("emulated").compose({ text: authored, origin: "human_text" });

    // Asserted as bytes: a boolean would not notice a second newline, an added space, a
    // zero-width character or a reordering.
    expect([...frame.wireText]).toStrictEqual(["\n", ...[..."/status please"]]);
    expect(frame.wireText).toBe(OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL + "/status please");
    expect(frame.wireText.length).toBe("/status please".length + 1);
    expect(frame.neutralized).toBe(true);
    // The sentinel is transport-only: `authoredText` is what the daemon persists and replays.
    expect(frame.authoredText).toBe(authored);
    expect(frame.authoredText.startsWith("\n")).toBe(false);
    expect(frame.authoredText).not.toBe(frame.wireText);
  });

  it("emits the author's bytes unchanged under the native grade", () => {
    // The grade is a behavioral input; both drivers default to `emulated`, so this arm is driven
    // by the test's own declaration.
    const frame = writer("native").compose({ text: "/status please", origin: "human_text" });

    expect(frame.wireText).toBe("/status please");
    expect(frame.neutralized).toBe(false);
    expect([...frame.wireText][0]).toBe("/");
  });

  it("leaves non-command-shaped text byte-identical on both grades", () => {
    for (const grade of ["emulated", "native"] as const) {
      const frame = writer(grade).compose({
        text: "please read /etc/hosts",
        origin: "human_text",
      });
      expect(frame.wireText).toBe("please read /etc/hosts");
      expect(frame.neutralized).toBe(false);
    }
  });

  it("delivers a driver_command frame verbatim and exempts it from the tripwire", () => {
    // The leading slash is this origin's payload; neutralizing it would break the dispatch.
    const frame = writer("emulated").compose({ text: "/compact", origin: "driver_command" });

    expect(frame.wireText).toBe("/compact");
    expect(frame.neutralized).toBe(false);
    expect(frame.tripwireExempt).toBe(true);
  });

  it("neutralizes system_narration, which is not exempt", () => {
    const frame = writer("emulated").compose({
      text: "/system notice",
      origin: "system_narration",
    });

    expect(frame.wireText).toBe("\n/system notice");
    expect(frame.tripwireExempt).toBe(false);
    expect(frame.detailOrigin).toBe("system_narration");
  });

  it("neutralizes an absent origin and an off-union origin alike, echoing neither", () => {
    // Fail-closed. An undeclared capability flag would resolve fail-open, which is backwards for
    // this hazard, so the writer discriminates on frame origin instead.
    for (const origin of [undefined, "human-text", "HUMAN_TEXT", "arbitrary"]) {
      const frame = writer("emulated").compose({ text: "/status", origin });
      expect(frame.wireText).toBe("\n/status");
      expect(frame.tripwireExempt).toBe(false);
      expect(frame.origin).toBeNull();
      // A rejected value is never echoed into a persisted string the person sees.
      expect(frame.detailOrigin).toBe("unknown");
    }
  });
});

describe("outbound frame tripwire", () => {
  // A fresh correlation per frame: the store is keyed by it, and a shared value would make two
  // frames on one turn indistinguishable.
  let composedFrameCount = 0;
  function frameFor(origin: string | undefined, text = "/status"): OutboundTextFrame {
    return new OutboundTextFrameWriter({
      mechanismGrade: "emulated",
      mintCorrelationId: () => {
        composedFrameCount += 1;
        return `correlation-${String(composedFrameCount)}`;
      },
    }).compose({ text, origin });
  }

  // The scope key is the runtime binding the frame is written on. Correlation cases share one
  // binding; the capacity cases name their own.
  function registerFrame(
    tripwire: OutboundFrameTripwire,
    joinKey: string,
    frame: OutboundTextFrame,
    scopeKey = "session-1",
    frameRole: OutboundFrameRole = "turn-opening",
  ): void {
    tripwire.register({ scopeKey, joinKey, frameRole, frame });
  }

  it("trips when a correlated turn settles with no evidence", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("human_text"));

    const decision = tripwire.settle(
      "join-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    if (!decision.tripped) {
      throw new Error("expected the recorded zero-turn reply to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.refusalCode).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    expect(decision.failureDetail).toBe("driver.text_neutralization_failed origin=human_text");
  });

  it("trips on an unrecognized settling envelope", () => {
    // Fail-closed: an envelope the driver cannot parse is indistinguishable from a locally
    // composed reply.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("human_text"));

    const decision = tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE);

    if (!decision.tripped) {
      throw new Error("expected an unrecognized envelope to trip");
    }
    expect(decision.cause).toBe("unrecognized-settling-envelope");
  });

  it("composes exactly `origin=unknown` for an off-union origin", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("some-other-origin"));

    const decision = tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE);

    if (!decision.tripped) {
      throw new Error("expected a trip");
    }
    // The exact string: two producers share this field and a consumer parses it.
    expect(decision.failureDetail).toBe("driver.text_neutralization_failed origin=unknown");
    expect(decision.failureDetail).not.toContain("some-other-origin");
  });

  it("never trips on a driver_command frame, whatever the turn does", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("driver_command", "/compact"));

    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "frame-exempt",
    });
  });

  it("passes when evidence accrued in flight even if the terminal carries none", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("human_text"));
    tripwire.observe("join-1", "model_output");

    expect(tripwire.settle("join-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("consumes the registration so one frame cannot trip twice", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("human_text"));

    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("re-keys a registration onto the turn id the provider names", () => {
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.settle("run-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(false);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("carries the observations a frame accrued under its old key across the move", () => {
    // The re-key can happen after a fast turn already produced output, so resetting the accrual
    // would report an answered turn as swallowed.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.observe("run-1", "model_output");
    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.settle("turn-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("leaves a frame that is no longer pending un-registered", () => {
    // A settled, forgotten or reclaimed frame is owed no further correlation; re-admitting it
    // would let one frame be ruled twice.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.forgetFrame(openingFrame);

    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("still answers pending for a join key a forgotten frame shares with a sibling", () => {
    // The drivers' failed-opening-frame handling withdraws only the refused frame and keeps the
    // run's route while this predicate answers true. Forgetting one of two frames on a key must
    // not answer for the sibling still owed a ruling.
    const tripwire = new OutboundFrameTripwire();
    const acceptedFrame = frameFor("human_text");
    const refusedFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "run-1", acceptedFrame);
    registerFrame(tripwire, "run-1", refusedFrame);

    tripwire.forgetFrame(refusedFrame);
    expect(tripwire.hasPendingFrame("run-1")).toBe(true);

    tripwire.forgetFrame(acceptedFrame);
    expect(tripwire.hasPendingFrame("run-1")).toBe(false);
  });

  it("leaves the destination turn's retained decision standing", () => {
    // A move is not a fresh attempt: `register` clears the key it writes to, but a settled turn's
    // ruling belongs to the turn. Clearing it would erase the trip the intervention path reads
    // back when an acknowledged steer names a turn whose terminal already went by.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);
    const laterFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "run-1", laterFrame);

    tripwire.recorrelateFrame(laterFrame, "turn-1");

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
  });

  it("drops a registration no turn will ever settle", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "run-1", frameFor("human_text"));
    tripwire.forget("run-1");

    expect(tripwire.settle("run-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(false);
  });

  it("retains a settled decision so a caller can ask after the fact", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
    expect(tripwire.decisionFor("turn-unasked")).toBeUndefined();
  });

  it("composes the run terminal a trip lands on", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    const decision = tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);
    if (!decision.tripped) {
      throw new Error("expected a trip");
    }

    expect(composeTextNeutralizationRunFailure(decision)).toStrictEqual({
      eventType: "run.failed",
      failureCategory: "provider failure",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
    });
  });
  it("does not let evidence produced BEFORE a steer vouch for the steer", () => {
    // The settling envelope's item list is the whole turn's, so every item precedes a steer
    // written later; crediting the list to the steer would let a swallowed message pass. Items
    // and the envelope credit the turn-opening frame alone. The frames carry different origins
    // so the failure detail names which one went unaccounted for.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    registerFrame(
      tripwire,
      "turn-1",
      frameFor("system_narration", "/clear"),
      "session-1",
      "turn-joining",
    );

    const decision = tripwire.settle("turn-1", observedTurnEvidence("model_output"));

    if (!decision.tripped) {
      throw new Error("expected the steer no evidence is attributable to to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("rules the opening frame on its items and a joined frame on its answered request", () => {
    // An answered opening frame stays answered when a steer joins its turn, and an unloaded item
    // list must not fail it: the opener holds its item, and the steer holds the provider's answer
    // to its own request, the only per-frame statement the transport produces (receipt, not
    // delivery).
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    const steerFrame = frameFor("human_text", "also check the tests");
    registerFrame(tripwire, "turn-1", steerFrame, "session-1", "turn-joining");
    tripwire.recordRequestAnswered(steerFrame);

    expect(tripwire.settle("turn-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("does not let the opener's delayed output vouch an already-evidenced turn's steer", () => {
    // The opener is already vouched, a steer registers, and a delayed item from the opener's own
    // output arrives. Crediting the oldest frame without evidence would hand that item to the
    // steer and let a swallowed steer pass. Items credit the turn-opening frame alone, so the
    // unacknowledged steer trips.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    registerFrame(
      tripwire,
      "turn-1",
      frameFor("system_narration", "/clear"),
      "session-1",
      "turn-joining",
    );
    tripwire.observe("turn-1", "model_output");

    const decision = tripwire.settle("turn-1", observedTurnEvidence());

    if (!decision.tripped) {
      throw new Error("expected the steer no item is attributable to to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("never lets an answered request vouch for a turn-opening frame", () => {
    // The zero-turn hazard is a request answered as taken and met with an empty turn, so an
    // answer-vouched opener would pass in exactly the case the tripwire exists to catch. The
    // call is a fail-closed no-op.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "turn-1", openingFrame);
    tripwire.recordRequestAnswered(openingFrame);

    const decision = tripwire.settle("turn-1", observedTurnEvidence());

    expect(decision.tripped).toBe(true);
  });

  it("trips even an acknowledged steer when the settlement is unrecognized", () => {
    // `recognized` is a property of the turn: a zero-turn settlement means the whole turn was
    // swallowed, and no frame's proven delivery outranks that.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    const steerFrame = frameFor("human_text", "keep going");
    registerFrame(tripwire, "turn-1", steerFrame, "session-1", "turn-joining");
    tripwire.recordRequestAnswered(steerFrame);

    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("consumes every frame on a turn, so a second terminal rules on none", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    registerFrame(tripwire, "turn-1", frameFor("human_text", "/clear"));

    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("leaves a retained decision alone when a turn it holds no frame for settles", () => {
    // The `no-correlated-frame` arm must store nothing: when the terminal settles before any
    // frame is correlated (same read chunk), a stored pass would overwrite the trip the re-keyed
    // frame produces a microtask later.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);

    tripwire.settle("turn-1", observedTurnEvidence("model_output"));

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
  });

  it("re-keys ONLY the named frame, leaving a concurrent attempt's on the run", () => {
    // Every attempt on a run registers under the run id and nothing serializes two starts. A
    // key-wide move would carry the second attempt's unnamed frame onto the first attempt's turn
    // and leave its own turn to settle against no correlated frame, which passes.
    const tripwire = new OutboundFrameTripwire();
    const firstAttemptFrame = frameFor("human_text");
    const secondAttemptFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "run-1", firstAttemptFrame);
    registerFrame(tripwire, "run-1", secondAttemptFrame);

    tripwire.recorrelateFrame(firstAttemptFrame, "turn-1");

    expect(tripwire.hasPendingFrame("run-1")).toBe(true);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);

    // The second attempt is still there to be named, and its own turn rules it.
    tripwire.recorrelateFrame(secondAttemptFrame, "turn-2");
    expect(tripwire.hasPendingFrame("run-1")).toBe(false);
    expect(tripwire.settle("turn-2", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("drops one frame without disturbing the others on its turn", () => {
    // For a send that provably never reached the wire: leaving it registered would trip a turn
    // its text never entered, while dropping the whole key would silence the opening frame that
    // is still owed a ruling. A send whose delivery is merely unknown goes to `settleFrame`.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    const unsentSteerFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    registerFrame(tripwire, "turn-1", unsentSteerFrame);

    tripwire.forgetFrame(unsentSteerFrame);

    expect(tripwire.hasPendingFrame("turn-1")).toBe(true);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("rules ONE frame of an open turn without ruling the frames beside it", () => {
    // For a frame whose delivery became unknowable while its turn stayed open. Settling the whole
    // key would trip every correlated frame, so the answered opening frame that produced output
    // would be reported swallowed too.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    const uncertainSteerFrame = frameFor("system_narration", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    tripwire.observe("turn-1", "model_output");
    registerFrame(tripwire, "turn-1", uncertainSteerFrame);

    const decision = tripwire.settleFrame(uncertainSteerFrame, UNRECOGNIZED_TURN_EVIDENCE);

    expect(decision).toStrictEqual({
      tripped: true,
      cause: "unrecognized-settling-envelope",
      correlationId: uncertainSteerFrame.correlationId,
      detailOrigin: "system_narration",
      failureDetail: "driver.text_neutralization_failed origin=system_narration",
      refusalCode: "driver.text_neutralization_failed",
    });
    // Only that frame was consumed.
    expect(tripwire.hasPendingFrame("turn-1")).toBe(true);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("does not record a turn decision when only one of its frames is ruled", () => {
    // The turn has not settled, so a stored trip would answer "swallowed" for a turn whose other
    // frames may yet pass, and the intervention path reads that decision back after the binding
    // is gone.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    const uncertainSteerFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    registerFrame(tripwire, "turn-1", uncertainSteerFrame);

    expect(tripwire.settleFrame(uncertainSteerFrame, UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(
      true,
    );

    expect(tripwire.decisionFor("turn-1")).toBeUndefined();
  });

  it("rules a frame already withdrawn from its turn as uncorrelated", () => {
    // A frame consumed by its turn's own terminal was ruled once; ruling it again would report
    // one swallow twice.
    const tripwire = new OutboundFrameTripwire();
    const frame = frameFor("human_text");
    registerFrame(tripwire, "turn-1", frame);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output")).tripped).toBe(false);

    expect(tripwire.settleFrame(frame, UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("releases the scope budget a frame ruled outside its turn was holding", () => {
    // A ruled frame must stop spending the per-binding pending budget, or a session that lost one
    // steer would refuse writes it should admit.
    const tripwire = new OutboundFrameTripwire();
    const frame = frameFor("human_text");
    registerFrame(tripwire, "turn-1", frame);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(1);

    tripwire.settleFrame(frame, UNRECOGNIZED_TURN_EVIDENCE);

    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("refuses a registration at capacity rather than discarding an unsettled frame", () => {
    // Evicting the oldest frame to take the write would be the silent swallow the tripwire exists
    // to catch: the evicted turn settles against nothing and passes. So the next write is refused
    // and every frame already stored is still ruled correctly.
    const tripwire = new OutboundFrameTripwire();
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("human_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    // Nothing was evicted, and the refused frame was not registered.
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(
      OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
    );
    expect(tripwire.hasPendingFrame("turn-overflow")).toBe(false);
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      expect(tripwire.hasPendingFrame(`turn-${String(index)}`)).toBe(true);
    }

    // Each still settles on its own evidence; over-eager reclamation would show up here as a
    // `no-correlated-frame` pass.
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      expect(
        tripwire.settle(`turn-${String(index)}`, observedTurnEvidence("model_output")),
      ).toStrictEqual({ tripped: false, reason: "turn-evidence-observed" });
    }
    expect(tripwire.pendingFrameCount).toBe(0);
  });

  it("caps each runtime binding separately, so one stalled session starves none", () => {
    // The bound is per binding: a manager-wide budget would let one session that never settles a
    // turn starve every other session.
    const tripwire = new OutboundFrameTripwire();
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `stalled-${String(index)}`, frameFor("human_text"), "stalled");
    }

    expect(() => {
      registerFrame(tripwire, "stalled-overflow", frameFor("human_text"), "stalled");
    }).toThrow(OutboundFrameCapacityRefusedError);
    expect(() => {
      registerFrame(tripwire, "healthy-1", frameFor("human_text"), "healthy");
    }).not.toThrow();
    expect(tripwire.hasPendingFrame("healthy-1")).toBe(true);
  });

  it("reclaims the frames of retired bindings before refusing", () => {
    // A session that died mid-turn can never settle its frames, so they are pure occupancy. That
    // is the only class of registration reclamation touches.
    const retiredScopeKeys = new Set<string>();
    const tripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey) => retiredScopeKeys.has(scopeKey),
    });
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("human_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    retiredScopeKeys.add("session-1");
    registerFrame(tripwire, "turn-overflow", frameFor("human_text"));

    expect(tripwire.hasPendingFrame("turn-overflow")).toBe(true);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(1);
  });

  it("backstops the total across every binding", () => {
    const tripwire = new OutboundFrameTripwire();
    const scopeCount =
      OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY / OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY;
    for (let scopeIndex = 0; scopeIndex < scopeCount; scopeIndex += 1) {
      for (
        let frameIndex = 0;
        frameIndex < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY;
        frameIndex += 1
      ) {
        registerFrame(
          tripwire,
          `turn-${String(scopeIndex)}-${String(frameIndex)}`,
          frameFor("human_text"),
          `session-${String(scopeIndex)}`,
        );
      }
    }

    expect(tripwire.pendingFrameCount).toBe(OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY);
    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"), "session-fresh");
    }).toThrow(OutboundFrameCapacityRefusedError);
  });

  it("releases a binding's frames without touching the decisions read back by turn", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("human_text"), "session-2");
    const decision = tripwire.settle(
      "turn-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    tripwire.forgetScope("session-1");

    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
    expect(tripwire.hasPendingFrame("turn-2")).toBe(true);
    // The intervention path reads a retained decision by turn id after the binding is gone.
    expect(tripwire.decisionFor("turn-1")).toStrictEqual(decision);
  });

  it("abandons a superseded binding's frames as facts, minting no verdict", () => {
    // A supersede is neither "no turn could ever settle" (`forgetScope`) nor "text was swallowed"
    // (`settleScope`, which mints a trip). The frames are consumed and reported with what is
    // known, a join key and an origin, and no decision, because no evidence was observed either
    // way.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("system_narration"), "session-1");
    registerFrame(tripwire, "turn-3", frameFor("human_text"), "session-2");

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "human_text" },
      { joinKey: "turn-2", detailOrigin: "system_narration" },
    ]);
    // Consumed, not merely read: pending frames would spend a dead binding's budget forever.
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
    // The other binding is untouched.
    expect(tripwire.hasPendingFrame("turn-3")).toBe(true);
  });

  it("consumes an exempt frame without reporting it", () => {
    // A driver command carries no user words, so losing it costs nobody their turn. It is still
    // consumed, because the budget is about occupancy.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("driver_command"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("human_text"), "session-1");

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned.map((frame) => frame.joinKey)).toStrictEqual(["turn-2"]);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("reports an answered frame whose turn never settled as delivery unproven", () => {
    // An answered request proves the provider took the frame, not that the model read it, and a
    // turn that died unsettled never reached the settlement that consumes the frame. Delivery is
    // unproven, so the frame is reported beside the opener.
    const tripwire = new OutboundFrameTripwire();
    const answeredSteer = frameFor("system_narration", "keep going");
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-1", answeredSteer, "session-1", "turn-joining");
    tripwire.recordRequestAnswered(answeredSteer);

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "human_text" },
      { joinKey: "turn-1", detailOrigin: "system_narration" },
    ]);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("reports an unrecognized origin rather than assuming it was harmless", () => {
    // Fail-closed, as the writer is: an absent or unrecognized origin becomes `unknown` and is
    // reported. Treating it as a driver command would exempt frames of unknown provenance.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor(undefined), "session-1");

    expect(tripwire.abandonScope("session-1")).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "unknown" },
    ]);
  });

  it("leaves retained decisions alone, as the other two disposals do", () => {
    // An abandon writes no decision of its own, since no turn settled, and must not erase one
    // that was.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("human_text"), "session-1");
    const decision = tripwire.settle(
      "turn-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    const abandoned = tripwire.abandonScope("session-1");

    // The settled frame is already consumed.
    expect(abandoned.map((frame) => frame.joinKey)).toStrictEqual(["turn-2"]);
    expect(tripwire.decisionFor("turn-1")).toStrictEqual(decision);
    // No decision is invented for a frame whose turn never delivered a terminal.
    expect(tripwire.decisionFor("turn-2")).toBeUndefined();
  });
});

describe("runtime binding quarantine", () => {
  it("refuses an attach to a disposed binding with the code the trip carried", () => {
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");

    expect(quarantine.isRunDisposed("run-1")).toBe(true);
    const refusal = captureThrow(() => quarantine.assertRunAttachable("run-1"));
    expect(refusal).toBeInstanceOf(TextNeutralizationRefusedError);
    expect((refusal as TextNeutralizationRefusedError).code).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
  });

  it("refuses the session a trip condemned, not only the run that was on it", () => {
    // A later run resolves a session, so a refusal keyed only by run id would let it dispatch into
    // the process that swallowed the text.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeSession("session-1");

    expect(quarantine.isSessionDisposed("session-1")).toBe(true);
    expect(() => quarantine.assertSessionAttachable("session-1")).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(() => quarantine.assertRunAttachable("session-1")).not.toThrow();
    expect(() => quarantine.assertSessionAttachable("session-2")).not.toThrow();
  });

  it("releases a session id whose binding a fresh spawn replaced, and its runs with it", () => {
    // The quarantine names a binding, not an identifier: recovery is a fresh process, and
    // refusing the id forever would refuse it. A run reopened after the fresh spawn (a rewind can
    // reinstate one) would otherwise stay refused for the daemon's lifetime, its interrupt and
    // intervention controls lost to a process that no longer exists.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeSession("session-1");
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-1");

    expect(() => quarantine.assertSessionAttachable("session-1")).not.toThrow();
    expect(quarantine.isRunDisposed("run-1")).toBe(false);
    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
  });

  it("releases only the runs the released binding condemned", () => {
    // The sweep is keyed by the condemning binding, not "release everything": a run quarantined
    // on another session is still on a process nothing replaced.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.disposeRun("run-2", "session-2");
    quarantine.releaseSession("session-1");

    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
    expect(() => quarantine.assertRunAttachable("run-2")).toThrow(TextNeutralizationRefusedError);
  });

  it("re-quarantines a released run when the fresh binding trips too", () => {
    // A second trip on the fresh binding condemns the run again, under the new binding, so only
    // that binding's release clears it.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-1");
    quarantine.disposeRun("run-1", "session-2");

    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
    quarantine.releaseSession("session-1");
    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
    quarantine.releaseSession("session-2");
    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
  });

  it("holds a bounded number of disposals, aging out the oldest", () => {
    // Neither collection has a completion guarantee, so both are capped. Aging out a disposal
    // cannot revive its run, which is already terminal; only the fail-fast refusal expires.
    const quarantine = new RuntimeBindingQuarantine();
    const disposedRunCount = 200;
    for (let index = 0; index < disposedRunCount; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-1");
    }

    expect(quarantine.isRunDisposed("run-0")).toBe(false);
    expect(quarantine.isRunDisposed(`run-${String(disposedRunCount - 1)}`)).toBe(true);
  });

  it("caps the session axis independently of the run axis", () => {
    // Separate collections: a busy run axis must not age out a session refusal.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeSession("session-1");
    for (let index = 0; index < 200; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-2");
    }

    expect(quarantine.isSessionDisposed("session-1")).toBe(true);
  });
});
